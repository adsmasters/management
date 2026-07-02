import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Year*12+month index from an ISO date string, using the PRINTED calendar date
// (ignoring time-of-day/timezone). Crucial: "2026-01-01T00:00:00.000+01:00" must
// count as January — naive new Date()+getUTCMonth() would shift it to December.
function calYM(s: string): number | null {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return parseInt(m[1]) * 12 + (parseInt(m[2]) - 1);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getUTCFullYear() * 12 + d.getUTCMonth();
}

// ── Service-Klassifizierung ───────────────────────────────────────────────
// Klassifiziert nach der POSITIONS-ÜBERSCHRIFT (lineItem.name), NICHT der
// Beschreibung — denn in der Beschreibung tauchen z.B. bei Full Service auch
// PPC-Begriffe auf, was sonst zu Fehlzuordnungen führt. Reihenfolge = Priorität.
// Findet der Positionsname nichts, wird ersatzweise der Rechnungstitel geprüft.
function matchService(s: string): string | null {
  const n = (s || '').toLowerCase();
  if (/full\s*service/.test(n)) return 'Full Service';
  if (/masterclass/.test(n)) return 'Masterclass';
  if (/starter[\s-]*programm/.test(n)) return 'Starter-Programm';
  if (/\bppc\b/.test(n) || /advertising\s*betreuung/.test(n) || /ppc[\s-]*betreuung/.test(n)) return 'PPC';
  if (/\bbilder\b/.test(n) || /a\s*\+\s*inhalte/.test(n) || /a\s*\+\s*content/.test(n)) return 'Bilder';
  return null;
}
function classifyService(name: string, fallbackTitle: string): string {
  return matchService(name) || matchService(fallbackTitle) || 'Andere';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json().catch(() => ({} as any));
    let { lexofficeKey, year, month } = body;
    const { excludeKeywords, debugContact, dryRun } = body;
    // Server-Fallbacks (für Cron/Automatik ohne Browser):
    //   - Key aus Secret LEXOFFICE_KEY, wenn nicht im Body
    //   - Monat = aktueller Monat, wenn nicht übergeben
    if (!lexofficeKey) lexofficeKey = Deno.env.get('LEXOFFICE_KEY') || '';
    if (!lexofficeKey) throw new Error('LexOffice API Key fehlt');
    if (!year || !month) { const _n = new Date(); year = _n.getUTCFullYear(); month = _n.getUTCMonth() + 1; }
    const debugContactLower: string = (debugContact || '').toLowerCase().trim();

    // Hardcoded defaults: advertising pass-through invoices ("Media-Budget",
    // "Ausgleich Media-Budget", "zweckgebundener Ausgleich") are forwarded to
    // Amazon and are NOT agency revenue — always exclude them, regardless of
    // what the user has configured in Settings. User keywords are added on top.
    const DEFAULT_EXCLUDE = ['media-budget', 'mediabudget', 'zweckgebundener ausgleich'];
    // Ausschluss-Keywords: Body (Browser) ODER Secret REVENUE_EXCLUDE_KEYWORDS (Cron), kommagetrennt.
    const envExclude: string[] = (Deno.env.get('REVENUE_EXCLUDE_KEYWORDS') || '').split(',').map((k) => k.toLowerCase().trim()).filter(Boolean);
    const userExclude: string[] = (excludeKeywords || []).map((k: string) => k.toLowerCase().trim()).filter(Boolean);
    const excludeLower: string[] = [...new Set([...DEFAULT_EXCLUDE, ...envExclude, ...userExclude])];

    const targetYear  = year as number;
    const targetMonth = month as number; // 1-based

    // Window: 3 months back -> 15th of following month.
    // Wide enough to catch quarterly invoices (dated at/near the start of their
    // quarter), but trimmed to keep the per-invoice fetch count (and thus runtime)
    // low so the function doesn't hit the execution timeout.
    const from = new Date(Date.UTC(targetYear, targetMonth - 4, 1)).toISOString().substring(0, 10);
    const to   = new Date(Date.UTC(targetYear, targetMonth, 15)).toISOString().substring(0, 10);

    // Robust GET with retry on rate-limit (429) and transient server errors (5xx).
    // LexOffice allows ~2 requests/sec — on 429 we back off and retry instead of
    // failing, because a failed invoice fetch must NEVER fall through to a blind
    // estimate (that bypasses exclusion and lets pass-through invoices count).
    async function lexGet(path: string) {
      let lastErr = '';
      for (let attempt = 0; attempt < 6; attempt++) {
        const res = await fetch('https://api.lexoffice.io/v1' + path, {
          headers: { 'Authorization': `Bearer ${lexofficeKey}`, 'Accept': 'application/json' },
        });
        if (res.ok) return res.json();
        const txt = await res.text();
        lastErr = `LexOffice ${res.status}: ${txt}`;
        if (res.status === 429 || res.status >= 500) {
          // exponential backoff: 1s, 2s, 4s, 8s, 16s
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }
        throw new Error(lastErr); // non-retryable (4xx other than 429)
      }
      throw new Error(lastErr + ' (after retries)');
    }

    // Fetch all voucher pages
    const first = await lexGet(
      `/voucherlist?voucherType=invoice&voucherStatus=open,paid&voucherDateFrom=${from}&voucherDateTo=${to}&size=250&page=0`
    );
    const pages = first.totalPages || 1;
    const allVouchers = [...(first.content || [])];
    for (let p = 1; p < pages; p++) {
      await sleep(600);
      const data = await lexGet(
        `/voucherlist?voucherType=invoice&voucherStatus=open,paid&voucherDateFrom=${from}&voucherDateTo=${to}&size=250&page=${p}`
      );
      allVouchers.push(...(data.content || []));
    }

    const map: Record<string, number> = {};
    // Additiv: Umsatz pro Kunde × Service (verändert die map/revenue-Logik NICHT)
    const serviceMap: Record<string, Record<string, number>> = {};
    const debugRows: any[] = [];
    let syncIncomplete = false; // true if any invoice detail couldn't be fetched

    for (let i = 0; i < allVouchers.length; i++) {
      const v = allVouchers[i];
      // Throttle between invoice fetches. ~400ms keeps runtime down; the 429
      // retry/backoff in lexGet absorbs the occasional rate-limit hit.
      if (i > 0) await sleep(400);

      const contactName = (v.contactName || '').trim();
      if (!contactName) continue;
      // Debug mode: only process one contact to keep API calls low
      if (debugContactLower && !contactName.toLowerCase().includes(debugContactLower)) continue;

      let usedNet = false;
      let fetchError = '';

      try {
        const voucherId = v.id || v.voucherId;
        const invoice = await lexGet(`/invoices/${voucherId}`);

        // Extract title and line items early – needed for Q-pattern inference below
        const invoiceTitle = invoice.title || invoice.introduction || '';
        const lineItems: any[] = invoice.lineItems || [];

        // ── Determine which month(s) this invoice belongs to + split factor ──
        // Bucket by LEISTUNGSDATUM (service period) like DATEV — NOT by invoice date.
        // LexOffice exposes the Leistungszeitraum under `shippingConditions`
        // (shippingDate = start, shippingEndDate = end of service period). The legacy
        // `serviceDate` field is kept as a fallback; voucherDate (Rechnungsdatum) is
        // the last resort only when no service date is present at all.
        const sc = invoice.shippingConditions || null;
        const sd = invoice.serviceDate || null;
        let startStr = '';
        let endStr = '';
        let dateSource = 'voucherDate';
        if (sc && (sc.shippingDate || sc.shippingEndDate)) {
          startStr   = sc.shippingDate || sc.shippingEndDate || '';
          endStr     = sc.shippingEndDate || '';
          dateSource = 'shippingConditions';
        } else if (sd && (sd.date || sd.startDate || sd.endDate)) {
          startStr   = sd.date || sd.startDate || '';
          endStr     = sd.endDate || '';
          dateSource = 'serviceDate';
        }

        let belongs = false;
        let monthDivisor = 1;
        const targetYM = targetYear * 12 + (targetMonth - 1);

        if (startStr) {
          const startYM = calYM(startStr);
          const endYM   = endStr ? calYM(endStr) : startYM;
          if (startYM !== null && endYM !== null) {
            belongs      = targetYM >= startYM && targetYM <= endYM;
            monthDivisor = Math.max(1, endYM - startYM + 1);
          }
        } else {
          const vYM = calYM(v.voucherDate || '');
          if (vYM !== null) belongs = vYM === targetYM;
        }

        // ── Q-pattern fallback ────────────────────────────────────────────────
        // When serviceDate doesn't provide a multi-month range (monthDivisor === 1),
        // look for a quarter pattern like "Q2 2026" in title or line items.
        // This reliably handles quarterly management-fee invoices.
        //
        // IMPORTANT: when Q-pattern is found, belongs is ALWAYS overridden based on
        // the Q-range — not voucherDate. This prevents e.g. a December invoice for
        // "Q1 2026" from being counted in December (voucherDate match) instead of
        // being split correctly across January–March 2026.
        //
        // SAFETY for media-budget invoices that also contain Q-patterns:
        //   - Monthly ones (April/May, title "Ausgleich Media-Budget") → excluded
        //     by invoice-title exclude check inside if(belongs) → continue
        //   - Quarterly Q1 (title "Rechnung", line item "Media-Budget Q1 2026") →
        //     line-item exclusion sets netAmount=0 → not added to map
        if (monthDivisor === 1) {
          const allTitleText = [
            invoiceTitle,
            ...lineItems.map((it: any) => (it.name || '') + ' ' + (it.description || '')),
          ].join(' ');
          const qm = allTitleText.match(/\bQ([1-4])\s*(\d{4})\b/i);
          if (qm) {
            const q  = parseInt(qm[1]);
            const y  = parseInt(qm[2]);
            const qStartMonth = (q - 1) * 3 + 1;   // Q1→1, Q2→4, Q3→7, Q4→10
            const qEndMonth   = qStartMonth + 2;    // Q1→3, Q2→6, Q3→9, Q4→12
            const startYM2 = y * 12 + (qStartMonth - 1);
            const endYM2   = y * 12 + (qEndMonth   - 1);
            // Always override belongs from Q-range (never from voucherDate for quarterly invoices)
            belongs      = targetYM >= startYM2 && targetYM <= endYM2;
            monthDivisor = 3;
          }
        }

        if (belongs) {
          let netAmount: number;
          const tp = invoice.totalPrice || {};

          // Check if the entire invoice should be excluded (title/introduction matches keyword)
          const invoiceText = [invoiceTitle, invoice.remark || ''].join(' ').toLowerCase();
          const invoiceExcluded = excludeLower.length > 0 && excludeLower.some(kw => invoiceText.includes(kw));

          if (invoiceExcluded) {
            debugRows.push({ contact: contactName, voucherDate: v.voucherDate, serviceDate: sd, belongs, monthDivisor, gross: v.totalAmount, net: 0, usedNet: false, excluded: 'invoice-title', title: invoiceTitle, lineItems: lineItems.map((it:any)=>it.name) });
            continue;
          }

          // Per-Service-Netto dieser Rechnung (vor Monats-Split). Wird parallel zur
          // bestehenden Summenlogik gefüllt, damit die Service-Summe == Gesamtsumme.
          const svcNet: Record<string, number> = {};
          if (excludeLower.length > 0 && lineItems.length > 0) {
            // Sum only line items whose name/description doesn't match any exclude keyword
            netAmount = lineItems.reduce((sum: number, item: any) => {
              const desc = ((item.name || '') + ' ' + (item.description || '')).toLowerCase();
              const excluded = excludeLower.some(kw => desc.includes(kw));
              if (excluded) return sum;
              // lineItemAmount is already the total net for this line (quantity already included)
              // unitPrice.netAmount is the per-unit net price → multiply by quantity
              let lineNet: number;
              if (item.lineItemAmount != null) {
                lineNet = Number(item.lineItemAmount);
              } else {
                lineNet = Number(item.unitPrice?.netAmount ?? 0) * Number(item.quantity ?? 1);
              }
              if (isNaN(lineNet)) lineNet = 0;
              // Service NUR aus der Positions-Überschrift (name), nicht der Beschreibung
              const svc = classifyService(item.name || '', invoiceTitle);
              svcNet[svc] = (svcNet[svc] || 0) + lineNet;
              return sum + lineNet;
            }, 0);
          } else if (tp.totalNetAmount != null) {
            // Prefer totalNetAmount — the only reliable net field in LexOffice API
            netAmount = Number(tp.totalNetAmount);
            usedNet = true;
            svcNet[classifyService(invoiceTitle, invoiceTitle)] = netAmount;
          } else {
            // Fallback: estimate net from gross (same as error fallback)
            netAmount = Math.round((v.totalAmount || 0) / 1.19 * 100) / 100;
            svcNet[classifyService(invoiceTitle, invoiceTitle)] = netAmount;
          }
          // Split across months if multi-month service period
          const netAmountForMonth = monthDivisor > 1 ? Math.round(netAmount / monthDivisor * 100) / 100 : netAmount;
          if (netAmountForMonth > 0) {
            map[contactName] = (map[contactName] || 0) + netAmountForMonth;
            // Service-Aufteilung mit identischem Monats-Split akkumulieren
            if (!serviceMap[contactName]) serviceMap[contactName] = {};
            for (const svc of Object.keys(svcNet)) {
              const split = monthDivisor > 1 ? Math.round(svcNet[svc] / monthDivisor * 100) / 100 : svcNet[svc];
              if (split) serviceMap[contactName][svc] = (serviceMap[contactName][svc] || 0) + split;
            }
          }
          debugRows.push({
            contact: contactName,
            voucherDate: v.voucherDate,
            serviceDate: sd,
            shippingConditions: sc,
            dateSource,
            belongs,
            gross: v.totalAmount,
            net: netAmountForMonth,
            netTotal: netAmount,
            monthDivisor,
            usedNet,
            title: invoiceTitle,
            lineItems: lineItems.map((it:any)=>it.name),
          });
        } else if (debugContactLower) {
          // In debug mode, record invoices that did NOT belong to the target month
          debugRows.push({
            contact: contactName,
            voucherDate: v.voucherDate,
            serviceDate: sd,
            shippingConditions: sc,
            dateSource,
            startStr,
            endStr,
            belongs: false,
            monthDivisor,
            gross: v.totalAmount,
            title: invoiceTitle,
            lineItems: lineItems.map((it:any)=>it.name),
            note: 'not-in-target-month',
          });
        }
      } catch (err: any) {
        fetchError = err?.message || 'unknown';
        // NO blind fallback. We cannot fetch the invoice detail, so we cannot
        // check its title/line items for exclusion (the voucherlist has no title).
        // Adding gross/1.19 here would let pass-through "Media-Budget" invoices
        // count as revenue — exactly the bug that produced Red Bull's 21.090,72 €.
        // Instead: skip the invoice, record the failure, and mark the whole sync
        // as incomplete so the caller knows to retry rather than trust the result.
        syncIncomplete = true;
        debugRows.push({
          contact: contactName,
          voucherDate: v.voucherDate,
          gross: v.totalAmount,
          net: 0,
          skipped: true,
          fetchError,
        });
      }
    }

    const rows = Object.entries(map).map(([contact_name, total_amount]) => ({
      year: targetYear,
      month: targetMonth,
      contact_name,
      total_amount,
      voucher_id: `agg_${targetYear}_${targetMonth}_${contact_name.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 40)}`,
    }));

    // Per-Service-Zeilen (additiv, eigene Tabelle revenue_services)
    const serviceRows: any[] = [];
    for (const contact_name of Object.keys(serviceMap)) {
      for (const service of Object.keys(serviceMap[contact_name])) {
        const amount = Math.round(serviceMap[contact_name][service] * 100) / 100;
        if (amount !== 0) serviceRows.push({ year: targetYear, month: targetMonth, contact_name, service, amount });
      }
    }

    // dryRun: inspect classification without touching the revenue table
    if (dryRun) {
      return new Response(
        JSON.stringify({ ok: true, dryRun: true, syncIncomplete, wouldWrite: rows, wouldWriteServices: serviceRows, debug: debugRows }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // Never overwrite a month with incomplete data: if any invoice couldn't be
    // fetched (rate limit etc.), keep the existing rows and tell the caller to retry.
    if (syncIncomplete) {
      return new Response(
        JSON.stringify({ error: 'Sync unvollständig (LexOffice Rate-Limit) – Monat NICHT überschrieben. Bitte erneut syncen.', syncIncomplete: true, debug: debugRows }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { error: delErr } = await sb.from('revenue').delete().eq('year', targetYear).eq('month', targetMonth);
    if (delErr) throw delErr;

    if (rows.length > 0) {
      const { error: insErr } = await sb.from('revenue').insert(rows);
      if (insErr) throw insErr;
    }

    // Additiv: Service-Aufteilung schreiben. In try/catch gekapselt, damit ein
    // Fehler hier den (bereits erfolgreichen) Haupt-Sync NIE umwirft.
    let serviceCount = 0;
    try {
      await sb.from('revenue_services').delete().eq('year', targetYear).eq('month', targetMonth);
      if (serviceRows.length > 0) {
        const { error: svcErr } = await sb.from('revenue_services').insert(serviceRows);
        if (!svcErr) serviceCount = serviceRows.length;
      }
    } catch (_) { /* Service-Aufteilung optional – Haupt-Sync bleibt gültig */ }

    return new Response(
      JSON.stringify({ ok: true, count: rows.length, serviceCount, debug: debugRows }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
