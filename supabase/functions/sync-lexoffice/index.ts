import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { lexofficeKey, year, month, excludeKeywords } = await req.json();
    if (!lexofficeKey) throw new Error('LexOffice API Key fehlt');
    const excludeLower: string[] = (excludeKeywords || []).map((k: string) => k.toLowerCase().trim()).filter(Boolean);

    const targetYear  = year as number;
    const targetMonth = month as number; // 1-based

    // Wide window: 1st of prev month -> 15th of following month
    const from = new Date(Date.UTC(targetYear, targetMonth - 2, 1)).toISOString().substring(0, 10);
    const to   = new Date(Date.UTC(targetYear, targetMonth, 15)).toISOString().substring(0, 10);

    async function lexGet(path: string) {
      const res = await fetch('https://api.lexoffice.io/v1' + path, {
        headers: { 'Authorization': `Bearer ${lexofficeKey}`, 'Accept': 'application/json' },
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`LexOffice ${res.status}: ${txt}`);
      }
      return res.json();
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
    const debugRows: any[] = [];

    for (let i = 0; i < allVouchers.length; i++) {
      const v = allVouchers[i];
      if (i > 0 && i % 4 === 0) await sleep(800);

      const contactName = (v.contactName || '').trim();
      if (!contactName) continue;

      let usedNet = false;
      let fetchError = '';

      try {
        const voucherId = v.id || v.voucherId;
        const invoice = await lexGet(`/invoices/${voucherId}`);

        // Determine month via Leistungsdatum (serviceDate), fallback to Rechnungsdatum
        // For multi-month service periods, split amount evenly across months
        const sd = invoice.serviceDate;
        let belongs = false;
        let monthDivisor = 1; // how many months to split across
        if (sd) {
          const startStr: string = sd.date || sd.startDate || '';
          const endStr: string = sd.endDate || '';
          if (startStr && endStr && startStr !== endStr) {
            // Multi-month range: check if targetYear/targetMonth falls within range
            const start = new Date(startStr);
            const end   = new Date(endStr);
            if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
              const startYM = start.getUTCFullYear() * 12 + start.getUTCMonth();
              const endYM   = end.getUTCFullYear()   * 12 + end.getUTCMonth();
              const targetYM = targetYear * 12 + (targetMonth - 1);
              belongs = targetYM >= startYM && targetYM <= endYM;
              monthDivisor = endYM - startYM + 1;
            }
          } else if (startStr) {
            const d = new Date(startStr);
            if (!isNaN(d.getTime())) {
              belongs = d.getUTCFullYear() === targetYear && d.getUTCMonth() + 1 === targetMonth;
            }
          }
        } else {
          const vd = new Date(v.voucherDate || '');
          belongs = vd.getUTCFullYear() === targetYear && vd.getUTCMonth() + 1 === targetMonth;
        }

        if (belongs) {
          let netAmount: number;
          const tp = invoice.totalPrice || {};
          const lineItems: any[] = invoice.lineItems || [];

          // Check if the entire invoice should be excluded (title/introduction matches keyword)
          const invoiceTitle = invoice.title || invoice.introduction || '';
          const invoiceText = [invoiceTitle, invoice.remark || ''].join(' ').toLowerCase();
          const invoiceExcluded = excludeLower.length > 0 && excludeLower.some(kw => invoiceText.includes(kw));

          if (invoiceExcluded) {
            debugRows.push({ contact: contactName, gross: v.totalAmount, net: 0, usedNet: false, excluded: 'invoice-title', title: invoiceTitle });
            continue;
          }

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
              return sum + (isNaN(lineNet) ? 0 : lineNet);
            }, 0);
          } else if (tp.totalNetAmount != null) {
            // Prefer totalNetAmount — the only reliable net field in LexOffice API
            netAmount = Number(tp.totalNetAmount);
            usedNet = true;
          } else {
            // Fallback: estimate net from gross (same as error fallback)
            netAmount = Math.round((v.totalAmount || 0) / 1.19 * 100) / 100;
          }
          // Split across months if multi-month service period
          const netAmountForMonth = monthDivisor > 1 ? Math.round(netAmount / monthDivisor * 100) / 100 : netAmount;
          if (netAmountForMonth > 0) {
            map[contactName] = (map[contactName] || 0) + netAmountForMonth;
          }
          debugRows.push({
            contact: contactName,
            gross: v.totalAmount,
            net: netAmountForMonth,
            netTotal: netAmount,
            monthDivisor,
            usedNet,
            title: invoiceTitle,
          });
        }
      } catch (err: any) {
        fetchError = err?.message || 'unknown';
        // Fallback: voucherDate + net estimate (gross / 1.19)
        const vd = new Date(v.voucherDate || '');
        if (vd.getUTCFullYear() === targetYear && vd.getUTCMonth() + 1 === targetMonth) {
          const netFallback = Math.round((v.totalAmount || 0) / 1.19 * 100) / 100;
          map[contactName] = (map[contactName] || 0) + netFallback;
          debugRows.push({
            contact: contactName,
            gross: v.totalAmount,
            net: netFallback,
            usedNet: false,
            fetchError,
            fallback: 'gross/1.19',
          });
        }
      }
    }

    const rows = Object.entries(map).map(([contact_name, total_amount]) => ({
      year: targetYear,
      month: targetMonth,
      contact_name,
      total_amount,
      voucher_id: `agg_${targetYear}_${targetMonth}_${contact_name.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 40)}`,
    }));

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

    return new Response(
      JSON.stringify({ ok: true, count: rows.length, debug: debugRows }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
