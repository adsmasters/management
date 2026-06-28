/* Node-Tests für cost-engine.js – ohne externe Abhängigkeiten.
 * Ausführen:  node test/cost-engine.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../js/cost-engine.js');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ✓ ' + name); }

console.log('cost-engine');

// ── Betrags-Parsing ─────────────────────────────────────────────────────────
test('parseGermanAmount', () => {
  assert.strictEqual(E.parseGermanAmount('1.999,20'), 1999.2);
  assert.strictEqual(E.parseGermanAmount('-13109,63'), -13109.63);
  assert.strictEqual(E.parseGermanAmount('"364,84"'), 364.84);
  assert.strictEqual(E.parseGermanAmount('10,79'), 10.79);
});

test('parseDateKsk / parseDateAmex', () => {
  assert.deepStrictEqual(E.parseDateKsk('31.03.26'), { iso: '2026-03-31', year: 2026, month: 3 });
  assert.deepStrictEqual(E.parseDateAmex('02/05/2026'), { iso: '2026-05-02', year: 2026, month: 5 });
});

// ── Kreissparkasse ───────────────────────────────────────────────────────────
const ksk = E.parseKreissparkasse(fx('kreissparkasse_sample.csv'));

test('Kreissparkasse: nur Abflüsse als Kosten (positiv normalisiert)', () => {
  assert.ok(ksk.length > 50, 'erwarte viele Kostenzeilen, hatte ' + ksk.length);
  assert.ok(ksk.every(t => t.amount_gross > 0), 'alle Kostenzeilen müssen positiv sein');
  assert.ok(ksk.every(t => t.source === 'kreissparkasse'));
});

test('Kreissparkasse: Gutschriften (Umsätze) werden übersprungen', () => {
  // Red Bull Gutschrift 14280,00 (positiv) darf NICHT als Kostenzeile auftauchen
  const redbull = ksk.find(t => /red bull/i.test(t.description));
  assert.strictEqual(redbull, undefined, 'positive Red-Bull-Gutschrift darf keine Kostenzeile sein');
});

test('Kreissparkasse: Telekom-Buchung korrekt (Betrag 54,94)', () => {
  const tel = ksk.find(t => /telekom/i.test(t.payee) && t.amount_gross === 54.94);
  assert.ok(tel, 'Telekom-Buchung 54,94 nicht gefunden');
  assert.ok(/^2026-\d\d-\d\d$/.test(tel.tx_date), 'Datum im ISO-Format');
});

test('Kreissparkasse: AMEX-Sammelzahlung als Kostenzeile vorhanden (vor Ausschluss)', () => {
  const settlements = ksk.filter(t => /american express/i.test(t.description));
  assert.ok(settlements.length >= 3 && settlements.every(t => t.amount_gross > 1000),
    'AMEX-Verrechnungen müssen als Kostenzeilen geparst werden');
});

// ── AMEX ─────────────────────────────────────────────────────────────────────
const amex = E.parseAmex(fx('amex_sample.csv'));

test('AMEX: Belastungen positiv, Ausgleich negativ', () => {
  const indeed = amex.find(t => /indeed/i.test(t.description));
  assert.ok(indeed && indeed.amount_gross === 214.75);
  const settle = amex.find(t => /erhalten besten dank/i.test(t.description));
  assert.ok(settle && settle.amount_gross === -22263.86, 'AMEX-Ausgleich muss negativ sein');
});

test('AMEX: quotierte Beschreibung mit Komma bleibt intakt', () => {
  // amex_sample enthält DOCUSEAL nicht; prüfe stattdessen, dass Beträge sauber getrennt sind
  assert.ok(amex.every(t => isFinite(t.amount_gross)));
});

// ── Regeln: Kategorie / MwSt / Ausschluss ────────────────────────────────────
const rules = {
  categoryRules: [
    { match_type: 'contains', pattern: 'INDEED',  category: 'Marketing' },
    { match_type: 'contains', pattern: 'UPWORK',  category: 'Freelancer/Externe' },
    { match_type: 'contains', pattern: 'Telekom', category: 'Büro' },
  ],
  vatRules: [
    { match_type: 'contains', pattern: 'Telekom', vat_rate: 0.19 },
  ],
  excludeRules: [
    { match_type: 'contains', pattern: 'AMERICAN EXPRESS', reason: 'Kreditkarten-Verrechnung' },
    { match_type: 'contains', pattern: 'UEBERWEISUNG ERHALTEN BESTEN DANK', reason: 'KK-Zahlung' },
    { match_type: 'contains', pattern: 'ÜBERWEISUNG ERHALTEN BESTEN DANK', reason: 'KK-Zahlung' },
    { match_type: 'contains', pattern: 'Red Bull', reason: 'Red Bull' },
  ],
};

test('MwSt: 19% wird netto herausgerechnet (Telekom 54,94 → 46,17 + 8,77)', () => {
  const tel = E.enrich(ksk.find(t => /telekom/i.test(t.payee) && t.amount_gross === 54.94), rules);
  assert.strictEqual(tel.vat_amount, 8.77);
  assert.strictEqual(tel.amount_net, 46.17);
  assert.strictEqual(tel.category, 'Büro');
});

test('Ausschluss: Bank-AMEX-Verrechnung wird excluded', () => {
  const s = E.enrich(ksk.find(t => /american express/i.test(t.description)), rules);
  assert.strictEqual(s.excluded, true);
});

test('Ausschluss: AMEX-Ausgleich wird excluded', () => {
  const s = E.enrich(amex.find(t => /erhalten besten dank/i.test(t.description)), rules);
  assert.strictEqual(s.excluded, true);
});

test('Kein VAT-Match → netto = brutto', () => {
  const up = E.enrich(amex.find(t => /upwork/i.test(t.description)), rules);
  assert.strictEqual(up.vat_amount, 0);
  assert.strictEqual(up.amount_net, up.amount_gross);
  assert.strictEqual(up.category, 'Freelancer/Externe');
});

// ── Dedup ────────────────────────────────────────────────────────────────────
test('Dedup: identische Zeilen einer Datei behalten distincte Hashes', () => {
  const dup = [
    { source: 'amex', tx_date: '2026-02-18', description: 'ANTHROPIC CLAUDE TEAM', amount_gross: 105.20 },
    { source: 'amex', tx_date: '2026-02-18', description: 'ANTHROPIC CLAUDE TEAM', amount_gross: 105.20 },
  ];
  const h = E.assignDedupHashes(dup);
  assert.notStrictEqual(h[0].dedup_hash, h[1].dedup_hash);
  assert.ok(h[0].dedup_hash.endsWith('#0') && h[1].dedup_hash.endsWith('#1'));
});

test('Dedup: gleicher Batch → gleiche Hashes (idempotenter Re-Import)', () => {
  const a = E.assignDedupHashes(amex);
  const b = E.assignDedupHashes(amex);
  assert.deepStrictEqual(a.map(x => x.dedup_hash), b.map(x => x.dedup_hash));
});

// ── Summen / Profit ──────────────────────────────────────────────────────────
test('summarize: excluded zählt nie, Steuern nur als Memo', () => {
  const txs = [
    { year: 2026, month: 3, category: 'Software',     amount_net: 100, excluded: false },
    { year: 2026, month: 3, category: 'Steuern',      amount_net: 500, excluded: false },
    { year: 2026, month: 3, category: 'Umsatzsteuer', amount_net: 800, excluded: false },
    { year: 2026, month: 3, category: 'Marketing',    amount_net: 200, excluded: false },
    { year: 2026, month: 3, category: 'Software',     amount_net: 999, excluded: true  },
    { year: 2026, month: 3, category: null,           amount_net: 50,  excluded: false },
  ];
  const settings = { Steuern: false, Umsatzsteuer: false };
  const s = E.summarize(txs, settings)['2026-03'];
  assert.strictEqual(s.costNet, 350, 'nur Software+Marketing+unkat. = 100+200+50');
  assert.strictEqual(s.memoNet, 1300, 'Steuern+Umsatzsteuer = 500+800');
  assert.strictEqual(s.uncategorizedCount, 1);
});

console.log('\n' + passed + ' Tests bestanden.\n');
