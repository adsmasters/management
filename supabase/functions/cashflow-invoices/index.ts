// Liefert für die Cashflow-Vorschau alles, was aus Lexoffice planbar ist:
//   1. offene AUSGANGSrechnungen (brutto, nach Fälligkeit)  – wie open-invoices,
//      zusätzlich mit Kennzeichen "Ad-Spend-Weiterberechnung" (Durchlaufposten).
//   2. offene EINGANGSrechnungen (purchaseinvoice), falls der API-Key sie liefert.
// Kein DB-Write. Fetch-/Retry-Logik 1:1 wie in open-invoices/sync-lexoffice.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Durchlaufposten: Media-Budget / Werbekosten werden an Amazon weitergereicht.
// Gleiche Keywords wie DEFAULT_EXCLUDE im Umsatz-Sync – dort fliegen sie aus dem
// Umsatz, hier werden sie als eigene Cashflow-Zeile gebraucht.
const ADSPEND_KEYWORDS = ['media-budget', 'mediabudget', 'media budget', 'zweckgebundener ausgleich', 'werbekosten', 'ad spend', 'adspend'];
const isAdSpendText = (s: string) => {
  const n = (s || '').toLowerCase();
  return ADSPEND_KEYWORDS.some((k) => n.includes(k));
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json().catch(() => ({} as any));
    let lexofficeKey = body.lexofficeKey;
    if (!lexofficeKey) lexofficeKey = Deno.env.get('LEXOFFICE_KEY') || '';
    if (!lexofficeKey) throw new Error('LexOffice API Key fehlt');
    const extraKeywords: string[] = (body.adSpendKeywords || []).map((k: string) => String(k).toLowerCase().trim()).filter(Boolean);
    const isAdSpend = (s: string) => isAdSpendText(s) || extraKeywords.some((k) => (s || '').toLowerCase().includes(k));

    async function lexGet(path: string) {
      let lastErr = '';
      for (let attempt = 0; attempt < 6; attempt++) {
        const res = await fetch('https://api.lexoffice.io/v1' + path, {
          headers: { 'Authorization': `Bearer ${lexofficeKey}`, 'Accept': 'application/json' },
        });
        if (res.ok) return res.json();
        const txt = await res.text();
        lastErr = `LexOffice ${res.status}: ${txt}`;
        if (res.status === 429 || res.status >= 500) { await sleep(1000 * Math.pow(2, attempt)); continue; }
        throw new Error(lastErr);
      }
      throw new Error(lastErr + ' (after retries)');
    }

    async function listAll(query: string) {
      const first = await lexGet('/voucherlist?' + query + '&page=0');
      const pages = first.totalPages || 1;
      const all = [...(first.content || [])];
      for (let p = 1; p < pages; p++) {
        await sleep(400);
        const data = await lexGet('/voucherlist?' + query + '&page=' + p);
        all.push(...(data.content || []));
      }
      return all;
    }

    // ── 1. Ausgangsrechnungen (offen) ───────────────────────────────────────
    const sales = await listAll('voucherType=invoice&voucherStatus=open&size=250');
    const startedAt = Date.now();
    const invoices: any[] = [];
    for (let i = 0; i < sales.length; i++) {
      const v = sales[i];
      const gross = Number(v.totalAmount) || 0;
      const openGross = v.openAmount != null ? Number(v.openAmount) : gross;
      let net = openGross / 1.19;               // Fallback wie in open-invoices
      let adSpend = isAdSpend(v.contactName || '');
      let detailMissing = true;
      // Für das Ad-Spend-Kennzeichen braucht es Titel/Positionen → Detailabruf
      // (~2 req/s, hartes Zeitbudget wie in open-invoices).
      if (Date.now() - startedAt < 110000) {
        if (i > 0) await sleep(450);
        try {
          const inv = await lexGet('/invoices/' + (v.id || v.voucherId));
          detailMissing = false;
          const tp = inv.totalPrice || {};
          const totalNet = Number(tp.totalNetAmount) || 0;
          const totalGross = Number(tp.totalGrossAmount) || gross || 0;
          net = totalGross > 0 ? openGross * (totalNet / totalGross) : openGross;
          const texts = [inv.title, inv.introduction, ...(inv.lineItems || []).map((li: any) => `${li.name || ''} ${li.description || ''}`)];
          if (texts.some((t) => isAdSpend(String(t || '')))) adSpend = true;
        } catch (_) { /* Fallback bleibt */ }
      }
      invoices.push({
        id: v.id,
        number: v.voucherNumber || '',
        contact: v.contactName || '(ohne Name)',
        voucherDate: v.voucherDate || null,
        dueDate: v.dueDate || null,
        total: gross,
        open: Math.round(net * 100) / 100,          // netto (wie open-invoices)
        openGross: Math.round(openGross * 100) / 100, // brutto = was aufs Konto kommt
        isAdSpend: adSpend,
        detailMissing,
        status: v.voucherStatus || 'open',
        currency: v.currency || 'EUR',
      });
    }

    // ── 2. Eingangsrechnungen (offen) ───────────────────────────────────────
    // Nicht jeder Lexoffice-Tarif/Key gibt purchaseinvoice frei → weicher Fehler,
    // die Seite fällt dann auf die manuelle Eingabemaske zurück.
    let purchases: any[] = [];
    let purchaseError: string | null = null;
    try {
      const rows = await listAll('voucherType=purchaseinvoice&voucherStatus=open&size=250');
      purchases = rows.map((v: any) => {
        const gross = Number(v.totalAmount) || 0;
        const openGross = v.openAmount != null ? Number(v.openAmount) : gross;
        return {
          id: v.id,
          number: v.voucherNumber || '',
          supplier: v.contactName || '(ohne Name)',
          voucherDate: v.voucherDate || null,
          dueDate: v.dueDate || null,
          openGross: Math.round(openGross * 100) / 100,
          isAdSpend: isAdSpend(`${v.contactName || ''} ${v.voucherNumber || ''}`),
          currency: v.currency || 'EUR',
        };
      });
    } catch (e: any) {
      purchaseError = e.message;
    }

    return new Response(JSON.stringify({
      ok: true,
      count: invoices.length,
      invoices,
      purchases,
      purchaseCount: purchases.length,
      purchaseError,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
