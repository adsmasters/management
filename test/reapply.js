/* Wendet Kategorie-/MwSt-/Ausschluss-/Finanzamt-Logik auf ALLE bestehenden
 * Buchungen neu an (wie der „Regeln neu anwenden"-Button), via REST.
 * Respektiert manuelle Ausschlüsse/Anpassungen.   node test/reapply.js
 */
const E = require('../js/cost-engine.js');
const BASE = 'https://lgrnmiszhhahfcmctmwo.supabase.co/rest/v1';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxncm5taXN6aGhhaGZjbWN0bXdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NjE2NDksImV4cCI6MjA4OTIzNzY0OX0.FDZRGMESves7XbAMs_oMLWmvnywMlVqe8p7f1kt06qk';
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
const MANUAL = 'Manuell ausgeschlossen', ADJ = 'Angepasst';
const eur = n => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n || 0);

(async () => {
  const get = async q => (await fetch(BASE + q, { headers: H })).json();
  const rules = {
    categoryRules: await get('/cost_category_rules?select=match_type,pattern,category&limit=2000'),
    vatRules: await get('/cost_vat_rules?select=match_type,pattern,vat_rate,start_date,end_date&limit=2000'),
    excludeRules: await get('/cost_exclude_rules?select=match_type,pattern,reason&limit=2000'),
  };
  let all = [], from = 0;
  while (true) { const c = await get('/cost_transactions?select=*&limit=1000&offset=' + from); all = all.concat(c); if (c.length < 1000) break; from += 1000; }

  let changed = 0;
  for (const t of all) {
    if (t.exclude_reason === MANUAL || t.exclude_reason === ADJ) continue;   // manuell: nicht anfassen
    const en = E.enrich(t, rules);
    const nf = { category: en.category, vat_rate: en.vat_rate, vat_amount: en.vat_amount,
      amount_net: en.amount_net, excluded: en.excluded, exclude_reason: en.exclude_reason };
    const diff = ['category', 'vat_rate', 'vat_amount', 'amount_net', 'excluded', 'exclude_reason']
      .some(k => String(t[k]) !== String(nf[k]));
    if (!diff) continue;
    const r = await fetch(BASE + '/cost_transactions?id=eq.' + t.id, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(nf) });
    if (!r.ok) { console.error('PATCH', t.id, r.status, await r.text()); continue; }
    changed++;
    if (/lohnsteuer/i.test(t.description) && /umsatzsteuer/i.test(t.description))
      console.log('Finanzamt-Bündel ' + t.tx_date + ': brutto ' + eur(t.amount_gross) + ' → zählt ' + eur(nf.amount_net) + ' (nur Lohnsteuer)');
  }
  console.log('\n' + changed + ' Buchungen aktualisiert.');

  // Monatsübersicht Kosten neu – Memo-Kategorien (Steuern, Geldanlage …) kommen
  // aus den Einstellungen, sonst weicht die Summe von der Kostenanalyse ab.
  const settings = await get('/cost_category_settings?select=category,include_in_profit');
  const off = new Set(settings.filter(s => s.include_in_profit === false).map(s => s.category));
  const bym = {};
  let fresh = [], off2 = 0;   // paginieren: PostgREST liefert max. 1000 Zeilen je Request
  while (true) {
    const c = await get('/cost_transactions?select=year,month,category,amount_net,excluded&limit=1000&offset=' + off2);
    fresh = fresh.concat(c); if (c.length < 1000) break; off2 += 1000;
  }
  fresh.forEach(t => { if (t.excluded || off.has(t.category)) return; const k = t.year + '-' + String(t.month).padStart(2, '0'); bym[k] = (bym[k] || 0) + (+t.amount_net || 0); });
  console.log('\nNetto-Kosten je Monat (nach Korrektur):');
  Object.keys(bym).sort().forEach(k => console.log('  ' + k + '  ' + eur(bym[k])));
})().catch(e => { console.error('FEHLER:', e.message); process.exit(1); });
