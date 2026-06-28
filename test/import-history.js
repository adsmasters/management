/* Einmaliger History-Import: liest history-csv/*.csv, holt Regeln aus Supabase,
 * reichert via cost-engine an und spielt Transaktionen per REST ein (idempotent).
 *   node test/import-history.js
 */
const fs = require('fs');
const path = require('path');
const E = require('../js/cost-engine.js');

const URL = 'https://lgrnmiszhhahfcmctmwo.supabase.co/rest/v1';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxncm5taXN6aGhhaGZjbWN0bXdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NjE2NDksImV4cCI6MjA4OTIzNzY0OX0.FDZRGMESves7XbAMs_oMLWmvnywMlVqe8p7f1kt06qk';
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

async function get(pathq) {
  const r = await fetch(URL + pathq, { headers: H });
  if (!r.ok) throw new Error('GET ' + pathq + ' -> ' + r.status + ' ' + await r.text());
  return r.json();
}
async function post(table, body, prefer) {
  const r = await fetch(URL + '/' + table, {
    method: 'POST', headers: { ...H, Prefer: prefer || 'return=representation' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('POST ' + table + ' -> ' + r.status + ' ' + await r.text());
  return r.json();
}
async function patch(table, q, body) {
  const r = await fetch(URL + '/' + table + q, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('PATCH ' + table + ' -> ' + r.status + ' ' + await r.text());
}

function sourceFromName(f) { return /ksk|kreissparkasse|onlinebank/i.test(f) ? 'kreissparkasse' : 'amex'; }
const MON = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
function isoLabel(iso) { const p = iso.split('-'); return MON[+p[1] - 1] + ' ' + p[0]; }

(async () => {
  const rules = {
    categoryRules: await get('/cost_category_rules?select=match_type,pattern,category&limit=2000'),
    vatRules: await get('/cost_vat_rules?select=match_type,pattern,vat_rate,start_date,end_date&limit=2000'),
    excludeRules: await get('/cost_exclude_rules?select=match_type,pattern,reason&limit=2000'),
  };
  console.log(`Regeln: ${rules.categoryRules.length} Kategorie, ${rules.vatRules.length} MwSt, ${rules.excludeRules.length} Ausschluss`);

  const dir = path.join(__dirname, '..', 'history-csv');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.csv')).sort();
  let grandNew = 0, grandSkip = 0, grandExcl = 0;

  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const source = sourceFromName(f);
    const enriched = E.assignDedupHashes(E.enrichAll(E.parseCsv(text, source), rules));
    if (!enriched.length) { console.log(`· ${f}: keine Buchungen`); continue; }
    const dates = enriched.map(t => t.tx_date).sort();
    const period = isoLabel(dates[0]) + ' – ' + isoLabel(dates[dates.length - 1]);

    const imp = (await post('cost_imports', [{ source, filename: f, row_count: 0, skipped_count: 0, period_label: period }]))[0];

    const rows = enriched.map(t => ({
      tx_date: t.tx_date, year: t.year, month: t.month, source: t.source,
      description: t.description, payee: t.payee, purpose: t.purpose, booking_text: t.booking_text,
      amount_gross: t.amount_gross, category: t.category, vat_rate: t.vat_rate,
      vat_amount: t.vat_amount, amount_net: t.amount_net, excluded: t.excluded,
      exclude_reason: t.exclude_reason, import_id: imp.id, dedup_hash: t.dedup_hash,
    }));
    const inserted = await post('cost_transactions?on_conflict=dedup_hash', rows,
      'resolution=ignore-duplicates,return=representation');
    const ins = inserted.length, skip = rows.length - ins;
    const excl = enriched.filter(t => t.excluded).length;
    await patch('cost_imports', '?id=eq.' + imp.id, { row_count: ins, skipped_count: skip });
    grandNew += ins; grandSkip += skip; grandExcl += excl;
    console.log(`✓ ${f.padEnd(26)} ${source.padEnd(14)} ${period.padEnd(18)} neu:${String(ins).padStart(4)} dup:${String(skip).padStart(3)} (ausgeschlossen:${excl})`);
  }
  console.log(`\nGesamt: ${grandNew} neu eingespielt, ${grandSkip} Duplikate übersprungen, ${grandExcl} als ausgeschlossen markiert.`);
})().catch(e => { console.error('FEHLER:', e.message); process.exit(1); });
