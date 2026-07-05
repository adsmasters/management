// Liefert offene + überfällige Ausgangsrechnungen aus LexOffice (live, kein DB-Write).
// Nur die Rechnungsliste (voucherlist) – schnell, keine Detail-Fetches, kein Timeout.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json().catch(() => ({} as any));
    let lexofficeKey = body.lexofficeKey;
    if (!lexofficeKey) lexofficeKey = Deno.env.get('LEXOFFICE_KEY') || '';
    if (!lexofficeKey) throw new Error('LexOffice API Key fehlt');

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

    // Alle unbezahlten Rechnungen. LexOffice-Status für unbezahlt = "open"
    // (überfällig wird NICHT als Status geführt, sondern aus dueDate abgeleitet).
    const q = 'voucherType=invoice&voucherStatus=open&size=250';
    const first = await lexGet('/voucherlist?' + q + '&page=0');
    const pages = first.totalPages || 1;
    const all = [...(first.content || [])];
    for (let p = 1; p < pages; p++) {
      await sleep(400);
      const data = await lexGet('/voucherlist?' + q + '&page=' + p);
      all.push(...(data.content || []));
    }

    // Pro Rechnung das Netto holen (voucherlist liefert nur brutto). Netto-Anteil
    // des noch offenen Betrags = openGross × (Netto/Brutto der Rechnung). Korrekt
    // auch bei Reverse-Charge (0 % MwSt → Netto = Brutto) und gemischten Sätzen.
    const startedAt = Date.now();
    const invoices: any[] = [];
    for (let i = 0; i < all.length; i++) {
      const v = all[i];
      const gross = Number(v.totalAmount) || 0;
      const openGross = v.openAmount != null ? Number(v.openAmount) : gross;
      let net = openGross / 1.19; // Fallback
      if (Date.now() - startedAt < 120000) {
        if (i > 0) await sleep(450); // ~2 req/s (LexOffice-Limit)
        try {
          const inv = await lexGet('/invoices/' + (v.id || v.voucherId));
          const tp = inv.totalPrice || {};
          const totalNet = Number(tp.totalNetAmount) || 0;
          const totalGross = Number(tp.totalGrossAmount) || gross || 0;
          net = totalGross > 0 ? openGross * (totalNet / totalGross) : openGross;
        } catch (_) { /* Fallback-Schätzung bleibt */ }
      }
      invoices.push({
        id: v.id,
        number: v.voucherNumber || '',
        contact: v.contactName || '(ohne Name)',
        voucherDate: v.voucherDate || null,
        dueDate: v.dueDate || null,
        total: gross,
        open: Math.round(net * 100) / 100,        // NETTO (offen)
        openGross: Math.round(openGross * 100) / 100,
        status: v.voucherStatus || 'open',
        currency: v.currency || 'EUR',
      });
    }

    return new Response(JSON.stringify({ ok: true, count: invoices.length, invoices }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
