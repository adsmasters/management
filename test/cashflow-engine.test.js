/* Node-Tests für cashflow-engine.js – ohne externe Abhängigkeiten.
 * Ausführen:  node test/cashflow-engine.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../js/cashflow-engine.js');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ✓ ' + name); }

console.log('cashflow-engine');

// ── Kreissparkasse: beide Richtungen ────────────────────────────────────────
const kskCsv = fx('kreissparkasse_sample.csv');
const ksk = C.parseKreissparkasse(kskCsv);

test('Kreissparkasse: jede Datenzeile wird gelesen', () => {
  const dataRows = kskCsv.trim().split('\n').length - 1;
  assert.strictEqual(ksk.length, dataRows, `erwartet ${dataRows}, gelesen ${ksk.length}`);
});

test('Kreissparkasse: Vorzeichen bleibt wie im Auszug (Ausgang negativ)', () => {
  const miete = ksk.find(t => /Gewerbemiete/i.test(t.description));
  assert.strictEqual(miete.amount, -1999.2);
  assert.strictEqual(miete.tx_date, '2026-03-30');
  assert.strictEqual(miete.payee, 'D/P Communications & Media GmbH,');
});

// Echte Auszüge enthalten auch Eingänge – der Testauszug ist reine Ausgabenseite,
// deshalb hier eine Zeile mit Gutschrift ergänzen (gleiches Format).
const header = kskCsv.split('\n')[0];
const inflowRows = [
  'DE78312512201400306302;15.03.26;15.03.26;GUTSCHRIFT;Rechnung 2026-0412 Media-Budget Ausgleich;;;;;;;Red Bull GmbH;DE11222222220000000000;TESTDEFF;19708,57;EUR;Umsatz gebucht',
  'DE78312512201400306302;14.03.26;14.03.26;GUTSCHRIFT;Rechnung 2026-0388 Full Service;;;;;;;Kreher Feinkost GmbH;DE11222222220000000001;TESTDEFF;2380,00;EUR;Umsatz gebucht',
];
const kskMixed = C.parseKreissparkasse([header, ...inflowRows, ...kskCsv.split('\n').slice(1)].join('\n'));

test('Kreissparkasse: Eingänge werden importiert (nicht wie in der Kostenanalyse verworfen)', () => {
  const rb = kskMixed.find(t => /red bull/i.test(t.description));
  assert.ok(rb, 'Gutschrift muss als Buchung erscheinen');
  assert.strictEqual(rb.amount, 19708.57);
  assert.strictEqual(kskMixed.length, ksk.length + 2);
});

// ── Amex ────────────────────────────────────────────────────────────────────
const amexCsv = fx('amex_sample.csv');
const amex = C.parseAmex(amexCsv);

test('Amex: Belastungen positiv im Export → intern negativ', () => {
  const indeed = amex.find(t => /INDEED/i.test(t.description));
  assert.strictEqual(indeed.amount, -214.75);
  assert.strictEqual(indeed.tx_date, '2026-03-02');
  assert.ok(amex.filter(t => t.amount < 0).length > amex.filter(t => t.amount > 0).length);
});

test('Amex: Vorzeichen-Modus überschreibbar', () => {
  const asIs = C.parseAmex(amexCsv, 'charge_negative');
  assert.strictEqual(asIs.find(t => /INDEED/i.test(t.description)).amount, 214.75);
});

test('Amex: Zusatzspalten im Export (Karteninhaber, Konto) brechen den Import nicht', () => {
  const wide = [
    'Datum,Beschreibung,Karteninhaber,Konto,Betrag,Erweiterte Details',
    '02/03/2026,INDEED IRELAND OPERATIO DUBLIN,TOBIAS DZIUBA,-41003,"214,75",Referenz 12345',
    '03/03/2026,GUTSCHRIFT RUECKERSTATTUNG,TOBIAS DZIUBA,-41003,"-30,00",Referenz 12346',
  ].join('\n');
  const rows = C.parseAmex(wide);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].amount, -214.75);
  assert.strictEqual(rows[0].description, 'INDEED IRELAND OPERATIO DUBLIN');
  assert.strictEqual(rows[1].amount, 30);          // Gutschrift → Eingang
});

test('Quellen-Erkennung', () => {
  assert.strictEqual(C.detectSource(kskCsv), 'kreissparkasse');
  assert.strictEqual(C.detectSource(amexCsv), 'amex');
});

// ── Dedup ───────────────────────────────────────────────────────────────────
test('Dedup: identische Datei zweimal → identische Schlüssel (kein Doppel-Insert)', () => {
  const a = C.assignDedupKeys(C.parseKreissparkasse(kskCsv)).map(t => t.dedup_key);
  const b = C.assignDedupKeys(C.parseKreissparkasse(kskCsv)).map(t => t.dedup_key);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(new Set(a).size, a.length, 'Schlüssel müssen innerhalb der Datei eindeutig sein');
});

test('Dedup: zwei echte gleiche Buchungen bleiben erhalten', () => {
  const rows = [
    { source: 'kreissparkasse', tx_date: '2026-03-27', amount: -603, purpose: 'Mini-Jobber-Gehalt' },
    { source: 'kreissparkasse', tx_date: '2026-03-27', amount: -603, purpose: 'Mini-Jobber-Gehalt' },
  ];
  const keys = C.assignDedupKeys(rows).map(t => t.dedup_key);
  assert.notStrictEqual(keys[0], keys[1]);
  assert.ok(keys[0].endsWith('#0') && keys[1].endsWith('#1'));
});

test('Dedup: Schlüssel nutzt Buchungstag, Betrag und Verwendungszweck', () => {
  const base = { source: 'kreissparkasse', tx_date: '2026-03-27', amount: -603, purpose: 'Gehalt' };
  const sig = C.dedupSignature(base);
  assert.notStrictEqual(sig, C.dedupSignature({ ...base, tx_date: '2026-03-28' }));
  assert.notStrictEqual(sig, C.dedupSignature({ ...base, amount: -604 }));
  assert.notStrictEqual(sig, C.dedupSignature({ ...base, purpose: 'Miete' }));
});

// ── Kreditkarten-Sammelabbuchung ────────────────────────────────────────────
test('Sammelabbuchung der Karte wird erkannt', () => {
  const settle = kskMixed.find(t => /KREDITKARTENABRECHN/i.test(t.booking_text));
  assert.ok(settle, 'Sammelabbuchung muss im Auszug vorkommen');
  assert.strictEqual(C.isCardSettlement(settle), true);
  assert.strictEqual(C.isCardSettlement(amex[0]), false);
});

// ── Kontostand ──────────────────────────────────────────────────────────────
const accounts = [
  { source: 'kreissparkasse', name: 'KSK', kind: 'bank', opening_balance: 50000 },
  { source: 'amex', name: 'Amex', kind: 'credit_card', opening_balance: 0 },
];
const enriched = C.enrichAll([...kskMixed, ...amex], { rules: {} });

test('Kontostand: Anfangssaldo + Summe der Bank-Buchungen', () => {
  const sum = kskMixed.reduce((s, t) => s + t.amount, 0);
  const b = C.balances(enriched, accounts);
  assert.strictEqual(b.bank, C.round2(50000 + sum));
  const ksk = b.accounts.find(a => a.source === 'kreissparkasse');
  assert.strictEqual(ksk.count, kskMixed.length);
});

test('Kontostand: Kartenumsätze zählen NICHT im Bankkonto (sonst doppelt)', () => {
  const b = C.balances(enriched, accounts);
  const nurBank = C.balances(enriched.filter(t => t.source === 'kreissparkasse'), accounts);
  assert.strictEqual(b.bank, nurBank.bank);
  assert.strictEqual(b.card, C.round2(amex.reduce((s, t) => s + t.amount, 0)));
});

test('Karte: gezahlte Kartenrechnung ist Abrechnung, keine Ausgabe', () => {
  const zahlung = amex.find(t => /ERHALTEN BESTEN DANK/i.test(t.description));
  assert.strictEqual(zahlung.amount, 22263.86, 'Zahlung reduziert die Kartenschuld');
  assert.strictEqual(C.isCardPayment(zahlung), true);
  assert.strictEqual(C.enrich(zahlung, { rules: {} }).flow_type, 'card_settlement');
});

test('Kontostand: Buchungen vor dem Anfangssaldo-Datum zählen nicht doppelt', () => {
  const withDate = [{ source: 'kreissparkasse', name: 'KSK', kind: 'bank', opening_balance: 10000, opening_date: '2026-03-01' }];
  const b = C.balances(enriched, withDate);
  const seit = kskMixed.filter(t => t.tx_date >= '2026-03-01').reduce((s, t) => s + t.amount, 0);
  assert.strictEqual(b.bank, C.round2(10000 + seit));
});

test('Offene Kartenumsätze = alles nach der letzten Abrechnung', () => {
  const open = C.cardOpenBalance(enriched);
  assert.strictEqual(open.since, '2026-03-31');    // Sammelabbuchung im Bankkonto
  assert.strictEqual(open.amount, 0, 'nach dem 31.03. liegen keine Kartenumsätze vor');
  // Ohne Bank-Sammelabbuchung greift der Zahlungseingang auf der Karte (22.02.)
  const nurKarte = C.cardOpenBalance(C.enrichAll(amex, { rules: {} }));
  assert.strictEqual(nurKarte.since, '2026-02-22');
  const erwartet = amex.filter(t => t.tx_date > '2026-02-22').reduce((s, t) => s + t.amount, 0);
  assert.strictEqual(nurKarte.amount, C.round2(erwartet));
  assert.ok(nurKarte.amount < 0, 'offene Kartenumsätze sind eine Verbindlichkeit');
});

// ── Ist-Cashflow je Monat ───────────────────────────────────────────────────
test('Monats-Ist: Eingänge, Ausgänge, Veränderung, fortlaufender Endsaldo', () => {
  const months = C.monthlyActuals(enriched, accounts);
  assert.ok(months.length >= 4);
  const maerz = months.find(m => m.year === 2026 && m.month === 3);
  assert.strictEqual(maerz.inflow, C.round2(19708.57 + 2380));
  assert.strictEqual(maerz.delta, C.round2(maerz.inflow - maerz.outflow));
  // Endsaldo der letzten Zeile = Gesamt-Kontostand
  const last = months[months.length - 1];
  assert.strictEqual(last.endBalance, C.balances(enriched, accounts).bank);
});

test('Monats-Kategorien: Sammelabbuchung raus, Kartenposten einzeln', () => {
  const rules = { categoryRules: [{ match_type: 'contains', pattern: 'INDEED', category: 'Recruitment' }] };
  const e2 = C.enrichAll([...kskMixed, ...amex], { rules });
  const cats = C.monthlyCategories(e2);
  assert.strictEqual(cats['2026-03'].Recruitment, 214.75);
  const alleWerte = Object.values(cats).flatMap(m => Object.values(m));
  assert.ok(!alleWerte.includes(612.81), 'Sammelabbuchung darf nicht als Kategorie-Ausgabe auftauchen');
});

// ── Flow-Typen ──────────────────────────────────────────────────────────────
test('Flow-Typ: Kundenzahlung, Ad-Spend, Gehalt, Steuer getrennt', () => {
  const opts = {
    rules: { categoryRules: [
      { match_type: 'contains', pattern: 'Damian Zielinski', category: 'Employee' },
      { match_type: 'contains', pattern: 'Gewerbesteuer', category: 'Steuern' },
    ] },
    clientNames: ['Kreher Feinkost GmbH', 'Red Bull GmbH'],
  };
  const e = C.enrichAll(kskMixed, opts);
  assert.strictEqual(e.find(t => /Kreher/i.test(t.description)).flow_type, 'client_payment');
  assert.strictEqual(e.find(t => /Red Bull/i.test(t.description)).flow_type, 'adspend_refund');
  assert.strictEqual(e.find(t => /Damian Zielinski/i.test(t.description)).flow_type, 'salary');
  assert.strictEqual(e.find(t => /Gewerbesteuer VZ 01\/2026/i.test(t.description)).flow_type, 'tax');
  assert.strictEqual(e.find(t => /KREDITKARTENABRECHN/i.test(t.description)).flow_type, 'card_settlement');
});

test('Flow-Typ: Amazon-Ad-Spend nicht mit eigenen Marketingkosten vermischt', () => {
  const rows = C.enrichAll([
    { source: 'kreissparkasse', tx_date: '2026-04-02', year: 2026, month: 4, amount: -18500, description: 'AMAZON ADVERTISING EMEA | Rechnung 4711', purpose: 'Rechnung 4711', payee: 'Amazon Advertising EMEA' },
    { source: 'amex', tx_date: '2026-04-03', year: 2026, month: 4, amount: -75, description: 'JOIN.COM PFAFFIKON SZ', purpose: 'JOIN.COM', payee: 'JOIN.COM' },
  ], { rules: { categoryRules: [{ match_type: 'contains', pattern: 'JOIN.COM', category: 'Marketing' }] } });
  assert.strictEqual(rows[0].flow_type, 'adspend_amazon');
  assert.strictEqual(rows[1].flow_type, 'other_out');
  assert.strictEqual(rows[1].category, 'Marketing');
});

// ── Fixkosten-Termine ───────────────────────────────────────────────────────
test('Fixkosten: Zahltage 1–9 ergeben gültige Daten und fallen nicht raus', () => {
  // Regression: isoOf lieferte '2026-09-4' → Datumsvergleich und toDate() brachen,
  // der Posten verschwand kommentarlos aus der Vorschau.
  const dates = C.fixedCostDates({ pay_day: 4, rhythm: 'monthly' }, '2026-08-24', '2026-10-31');
  assert.deepStrictEqual(dates, ['2026-09-04', '2026-10-04']);
  assert.ok(dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
  const w = C.buildForecast({
    today: '2026-08-27', startBalance: 0, invoices: [], apInvoices: [], taxDates: [],
    fixedCosts: [{ label: 'Optmyzr', amount: 599, pay_day: 4, rhythm: 'monthly', bucket: 'supplier' }],
  });
  assert.strictEqual(w.filter((x) => x.from === '2026-08-31')[0].suppliers, -599, 'Zahltag 4 muss ankommen');
});

test('Fixkosten: monatlich / quartalsweise / jährlich', () => {
  const m = C.fixedCostDates({ pay_day: 27, rhythm: 'monthly' }, '2026-08-24', '2026-11-22');
  assert.deepStrictEqual(m, ['2026-08-27', '2026-09-27', '2026-10-27', '2026-11-27'].filter(d => d <= '2026-11-22'));
  const q = C.fixedCostDates({ pay_day: 10, rhythm: 'quarterly', start_month: 1 }, '2026-08-24', '2027-02-28');
  assert.deepStrictEqual(q, ['2026-10-10', '2027-01-10']);
  const y = C.fixedCostDates({ pay_day: 15, rhythm: 'yearly', start_month: 12 }, '2026-08-24', '2026-12-31');
  assert.deepStrictEqual(y, ['2026-12-15']);
  // Zahltag 31 im Februar → letzter Monatstag
  assert.deepStrictEqual(C.fixedCostDates({ pay_day: 31, rhythm: 'monthly' }, '2027-02-01', '2027-02-28'), ['2027-02-28']);
});

// ── Umsatzsteuer ────────────────────────────────────────────────────────────
test('UStVA-Termin: 10. des Folgemonats, mit Dauerfristverlängerung übernächster', () => {
  assert.strictEqual(C.ustvaDueDate(2026, 7, false), '2026-08-10');
  assert.strictEqual(C.ustvaDueDate(2026, 7, true), '2026-09-10');
  assert.strictEqual(C.ustvaDueDate(2026, 12, true), '2027-02-10');
});

test('UStVA-Schätzung: USt aus Rechnungen minus Vorsteuer', () => {
  assert.strictEqual(C.estimateUstva({ netRevenue: 100000, inputVat: 4000 }), 15000);
  assert.strictEqual(C.estimateUstva({ netRevenue: 10000, inputVat: 5000 }), 0, 'nie negativ in der Planung');
});

// ── 13-Wochen-Vorschau ──────────────────────────────────────────────────────
const forecast = C.buildForecast({
  today: '2026-08-27',
  startBalance: 40000,
  invoices: [
    { contact: 'Red Bull GmbH', dueDate: '2026-09-10', amount: 19708.57, isAdSpend: true },
    { contact: 'Red Bull GmbH', dueDate: '2026-09-24', amount: 19275.32, isAdSpend: true },
    { contact: 'Kreher Feinkost', dueDate: '2026-09-05', amount: 2380 },
    { contact: 'Alt-Rechnung', dueDate: '2026-07-01', amount: 1190 },          // überfällig
    { contact: 'Zu weit weg', dueDate: '2027-06-01', amount: 99999 },          // außerhalb 13 Wochen
  ],
  apInvoices: [
    { supplier: 'Amazon Advertising', due_date: '2026-09-15', amount: 21000, kind: 'adspend_amazon' },
    { supplier: 'Anwalt', due_date: '2026-09-02', amount: 1500, kind: 'supplier' },
    { supplier: 'Fördermittel', due_date: '2026-10-01', amount: 5000, kind: 'other_income' },
    { supplier: 'Schon bezahlt', due_date: '2026-09-03', amount: 800, kind: 'supplier', paid: true },
  ],
  fixedCosts: [
    { label: 'Gehälter', amount: 30000, pay_day: 27, rhythm: 'monthly', bucket: 'salary' },
    { label: 'Miete', amount: 1999.2, pay_day: 30, rhythm: 'monthly', bucket: 'supplier' },
    { label: 'Inaktiv', amount: 5000, pay_day: 5, rhythm: 'monthly', bucket: 'supplier', active: false },
    { label: 'ETF-Sparplan (flatex)', amount: 25000, pay_day: 12, rhythm: 'monthly', bucket: 'savings' },
  ],
  taxDates: [{ label: 'UStVA Juli', due_date: '2026-09-10', amount: 8000, kind: 'ustva' }],
  cardSettlement: { amount: 3500, date: '2026-09-30' },
});

test('Vorschau: 13 Wochen ab Montag der aktuellen Woche', () => {
  assert.strictEqual(forecast.length, 13);
  assert.strictEqual(forecast[0].from, '2026-08-24');
  assert.strictEqual(forecast[0].to, '2026-08-30');
  assert.strictEqual(forecast[12].to, '2026-11-22');
});

test('Vorschau: enthält die offenen Red-Bull-Rechnungen', () => {
  const alle = forecast.flatMap(w => w.items);
  const rb = alle.filter(i => /Red Bull/.test(i.label));
  assert.strictEqual(rb.length, 2);
  assert.deepStrictEqual(rb.map(i => i.amount).sort((a, b) => a - b), [19275.32, 19708.57]);
  assert.ok(rb.every(i => i.bucket === 'adSpendRefunds'), 'Red Bull ist Ad-Spend-Weiterberechnung');
});

test('Vorschau: Ad-Spend läuft getrennt von den eigenen Kosten', () => {
  const w = forecast.find(x => x.from === '2026-09-14');
  assert.strictEqual(w.adSpendAmazon, -21000);
  assert.strictEqual(w.suppliers, 0, 'Amazon-Ad-Spend darf nicht bei Lieferanten landen');
  const wRefund = forecast.find(x => x.from === '2026-09-07');
  assert.strictEqual(wRefund.adSpendRefunds, 19708.57);
  assert.strictEqual(wRefund.clientPayments, 0);
});

// ── Depot: Stand aus Stichtagswert + Sparplan-Einzahlungen ──────────────────
test('depotValue: Einzahlungen ab Stichtag, Rueckbuchung mindert', () => {
  const txs = [
    { tx_date: '2026-07-12', amount: -20000, category: 'Geldanlage' },   // vor dem Stichtag
    { tx_date: '2026-08-13', amount: -25000, category: 'Geldanlage' },
    { tx_date: '2026-09-12', amount: -22000, category: 'Geldanlage' },
    { tx_date: '2026-09-20', amount: 5000, category: 'Geldanlage' },     // Rueckbuchung aufs Konto
    { tx_date: '2026-09-01', amount: -3000, category: 'Software' },      // keine Geldanlage
  ];
  const d = C.depotValue(txs, { opening_value: 100000, opening_date: '2026-08-01' });
  assert.strictEqual(d.deposits, 42000, '25.000 + 22.000 - 5.000');
  assert.strictEqual(d.value, 142000);
  assert.strictEqual(d.count, 3, 'die Juli-Zahlung liegt vor dem Stichtag');
  assert.strictEqual(d.first, '2026-08-13');
});

test('depotValue: ohne Stichtag zaehlen alle Einzahlungen', () => {
  const d = C.depotValue([{ tx_date: '2026-08-13', amount: -25000, category: 'Geldanlage' }], {});
  assert.strictEqual(d.value, 25000);
  assert.strictEqual(C.depotValue([], {}).value, 0);
});

// ── Geldanlage: Umbuchung aufs Depot ────────────────────────────────────────
test('Vorschau: ETF-Sparplan zieht Geld ab, aber in eigener Zeile', () => {
  const w = forecast.find(x => x.from === '2026-09-07');   // 12.09. liegt in dieser Woche
  assert.strictEqual(w.savings, -25000, 'Sparplan mindert den Saldo');
  assert.strictEqual(w.otherOut, 0, 'Sparplan darf nicht unter Sonstige Ausgaben laufen');
  assert.strictEqual(w.suppliers, 0);
  const spar = forecast.flatMap(x => x.items).filter(i => i.bucket === 'savings');
  assert.ok(spar.length >= 1 && spar.every(i => /Sparplan/.test(i.label)));
});

test('Fixkosten-Vorschlag: Kategorie Geldanlage landet im Bucket savings', () => {
  const txs = ['2026-05', '2026-06', '2026-07', '2026-08'].map((m) => ({
    tx_date: m + '-12', description: 'Adsmasters GmbH | SVWZ+Sparplan ETF | ONLINE-UEBERWEISUNG',
    payee: 'Adsmasters GmbH', amount_gross: 25000, amount_net: 25000, category: 'Geldanlage', excluded: false,
  }));
  const s = C.suggestFixedCosts(txs, { today: '2026-09-01', months: 6 });
  const etf = s.find((x) => /Adsmasters/.test(x.label));
  assert.ok(etf, 'Sparplan muss vorgeschlagen werden');
  assert.strictEqual(etf.bucket, 'savings');
  assert.strictEqual(etf.amount, 25000);
});

test('Vorschau: überfällige Rechnungen landen in Woche 1, ferne Termine fallen raus', () => {
  assert.strictEqual(forecast[0].clientPayments, 1190);
  assert.ok(!forecast.flatMap(w => w.items).some(i => i.label === 'Zu weit weg'));
});

test('Vorschau: Fixkosten, Steuern, Kartenabrechnung in den richtigen Zeilen', () => {
  assert.strictEqual(forecast[0].salaries, -30000);                      // 27.08.
  assert.strictEqual(forecast.find(w => w.from === '2026-09-07').taxes, -8000);
  assert.strictEqual(forecast.find(w => w.from === '2026-09-28').otherOut, -3500);
  assert.ok(!forecast.flatMap(w => w.items).some(i => i.label === 'Inaktiv'));
  assert.ok(!forecast.flatMap(w => w.items).some(i => i.label === 'Schon bezahlt'));
});

test('Vorschau: Salden schreiben sich fort', () => {
  assert.strictEqual(forecast[0].startBalance, 40000);
  forecast.forEach((w, i) => {
    assert.strictEqual(w.endBalance, C.round2(w.startBalance + w.net));
    if (i > 0) assert.strictEqual(w.startBalance, forecast[i - 1].endBalance);
  });
});

test('Vorschau: tiefster Punkt wird gefunden', () => {
  const low = C.lowestPoint(forecast);
  assert.ok(low && forecast.every(w => w.endBalance >= low.endBalance));
});

// ── Fixkosten-Vorschlag aus der Kostenanalyse ───────────────────────────────
// Buchungen im Format von cost_transactions (amount_gross positiv = Kosten).
function costTx(date, payee, gross, category, opts) {
  return Object.assign({
    tx_date: date, payee: payee, description: payee + ' | Verwendungszweck',
    amount_gross: gross, amount_net: gross, category: category, excluded: false,
  }, opts || {});
}
const HISTORY = [];
['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].forEach((m, i) => {
  HISTORY.push(costTx(m + '-26', 'Christian Doennewald', 2608, 'Employee'));
  HISTORY.push(costTx(m + '-29', 'D/P Communications & Media GmbH', 1999.2, 'Büro'));
  HISTORY.push(costTx(m + '-04', 'OPTMYZR COPENHAGEN', 599 + i, 'Software'));
  HISTORY.push(costTx(m + '-11', 'REWE SAGT DANKE ' + (100000 + i), 42 + i, 'Restaurant'));   // unregelmäßig, klein
  HISTORY.push(costTx(m + '-10', 'Landeshauptstadt Duesseldorf', 5775, 'Steuern'));
});
// Sammellastschrift Finanzamt: brutto USt+LSt, netto = Lohnsteuer-Anteil
['2026-04', '2026-05', '2026-06', '2026-07'].forEach((m) => {
  HISTORY.push(costTx(m + '-15', 'STEUERVERWALTUNG NRW', 14914.02, 'Employee', {
    description: 'STEUERVERWALTUNG NRW | Stnr 103/5710/2946 Umsatzsteuer Jan. 26 10.106,41 Lohnsteuer Mrz. 26 4.807,61',
    amount_net: 4807.61,
  }));
});
// reine Lohnsteuer-Lastschrift in einem Monat
HISTORY.push(costTx('2026-03-13', 'STEUERVERWALTUNG NRW', 4807.61, 'Employee', {
  description: 'STEUERVERWALTUNG NRW | Stnr 103/5710/2946 Lohnsteuer Feb. 26 4.807,61',
}));

const suggestions = C.suggestFixedCosts(HISTORY, { today: '2026-08-28', months: 6 });
const byLabel = (l) => suggestions.filter((x) => x.label === l)[0];

test('Fixkosten-Vorschlag: wiederkehrende Zahlungen mit Median-Betrag und -Zahltag', () => {
  const gehalt = byLabel('Christian Doennewald');
  assert.ok(gehalt, 'wiederkehrendes Gehalt muss vorgeschlagen werden');
  assert.strictEqual(gehalt.amount, 2608);
  assert.strictEqual(gehalt.pay_day, 26);
  assert.strictEqual(gehalt.rhythm, 'monthly');
  assert.strictEqual(gehalt.bucket, 'salary');
  assert.strictEqual(gehalt.monthsSeen, 6);
  const miete = byLabel('D/P Communications & Media GmbH');
  assert.strictEqual(miete.bucket, 'supplier');
  assert.strictEqual(miete.amount, 1999.2);
});

test('Fixkosten-Vorschlag: Median statt Durchschnitt (Ausreißer ziehen nicht)', () => {
  const rows = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']
    .map((m, i) => costTx(m + '-05', 'Alfahosting GmbH', i === 5 ? 9000 : 120, 'Software'));
  const s = C.suggestFixedCosts(rows, { today: '2026-08-28', months: 6 });
  assert.strictEqual(byLabelIn(s, 'Alfahosting GmbH').amount, 120);
});
function byLabelIn(list, l) { return list.filter((x) => x.label === l)[0]; }

test('Fixkosten-Vorschlag: Steuern bleiben draußen (kommen aus den Steuerterminen)', () => {
  assert.strictEqual(byLabel('Landeshauptstadt Duesseldorf'), undefined);
  assert.ok(suggestions.every((x) => x.category !== 'Steuern' && x.category !== 'Umsatzsteuer'));
});

test('Fixkosten-Vorschlag: Finanzamt-Sammellastschrift nur mit Lohnsteuer-Anteil', () => {
  const lst = byLabel('Lohnsteuer (Finanzamt)');
  assert.ok(lst, 'Lohnsteuer muss als Personalzahlung vorgeschlagen werden');
  assert.strictEqual(lst.amount, 4807.61, 'nicht der Bruttobetrag der Lastschrift');
  assert.strictEqual(lst.bucket, 'salary');
  assert.strictEqual(lst.monthsSeen, 5, 'reine und gebündelte Lohnsteuer in einer Gruppe');
  assert.strictEqual(byLabel('STEUERVERWALTUNG NRW'), undefined, 'nicht zusätzlich als eigener Lieferant');
});

test('Fixkosten-Vorschlag: seltene Kleinbeträge fliegen raus', () => {
  assert.strictEqual(suggestions.filter((x) => /REWE/i.test(x.label)).length, 0);
  assert.ok(suggestions.every((x) => x.amount >= 50));
});

test('Fixkosten-Vorschlag: Transaktions-IDs werden vom Lieferantennamen abgeschnitten', () => {
  // Satzzeichen am Ende fallen weg – gleiches Verhalten wie suggestPattern in kostenanalyse.js
  assert.strictEqual(C.vendorName('PAYPAL *FLASCHENP. 17642964006'), 'PAYPAL *FLASCHENP');
  assert.strictEqual(C.vendorName('Telekom Deutschland GmbH | Festnetz'), 'Telekom Deutschland GmbH');
});

// ── Umsatzsteuer aus der Zahlungshistorie ───────────────────────────────────
test('UStVA: Voranmeldungszeitraum aus dem Buchungstext', () => {
  assert.strictEqual(C.ustPeriod('Umsatzsteuer Jan. 26 10.106,41 Lohnsteuer Mrz. 26 4.807,61'), '2026-01');
  assert.strictEqual(C.ustPeriod('Umsatzsteuer Mrz. 26 6.513,21'), '2026-03');
  assert.strictEqual(C.ustPeriod('Koerperschaftst. 1.Vj.26 4.687,00'), null);
});

test('UStVA: tatsächliche Zahlungen – Sammellastschrift wird aufgeteilt', () => {
  const zahlungen = C.actualVatPayments([
    costTx('2026-04-15', 'STEUERVERWALTUNG NRW', 14914.02, 'Employee', {
      description: 'Umsatzsteuer Jan. 26 10.106,41 Lohnsteuer Mrz. 26 4.807,61', amount_net: 4807.61 }),
    costTx('2026-05-18', 'STEUERVERWALTUNG NRW', 11738.33, 'Umsatzsteuer', {
      description: 'Umsatzsteuer Feb. 26 11.738,33' }),
    costTx('2026-06-10', 'STEUERVERWALTUNG NRW', 6791, 'Steuern', {
      description: 'Koerperschaftst. 2.Vj.26 6.437,00' }),
  ]);
  assert.strictEqual(zahlungen.length, 2, 'Körperschaftsteuer ist keine Umsatzsteuer');
  assert.strictEqual(zahlungen[0].amount, 10106.41, 'nur der USt-Anteil, nicht die ganze Lastschrift');
  assert.strictEqual(zahlungen[0].period, '2026-01');
  assert.strictEqual(zahlungen[1].amount, 11738.33);
});

test('median: rundet Quoten nicht kaputt, Beträge bleiben auf Cent', () => {
  // gerade Anzahl → Mittel der beiden mittleren Werte, ohne 2-Stellen-Rundung
  assert.strictEqual(C.median([0.163, 0.163, 0.163, 0.163]), 0.163);
  assert.strictEqual(C.median([0.12, 0.16]), 0.14);
  assert.strictEqual(C.median([100, 200, 300]), 200);
});

test('UStVA: effektiver Satz aus Zahlung ÷ Netto-Umsatz', () => {
  const txs = [
    costTx('2026-04-15', 'FA', 10000, 'Umsatzsteuer', { description: 'Umsatzsteuer Jan. 26 10.000,00' }),
    costTx('2026-05-15', 'FA', 14000, 'Umsatzsteuer', { description: 'Umsatzsteuer Feb. 26 14.000,00' }),
    costTx('2026-06-15', 'FA', 12000, 'Umsatzsteuer', { description: 'Umsatzsteuer Mrz. 26 12.000,00' }),
  ];
  const r = C.effectiveVatRate(txs, { '2026-01': 100000, '2026-02': 100000, '2026-03': 100000 });
  assert.strictEqual(r.samples.length, 3);
  assert.strictEqual(C.round2(r.rate * 100), 12);       // Median 12 %, nicht die vollen 19 %
  // ohne passenden Umsatz keine Stichprobe → kein Satz
  assert.strictEqual(C.effectiveVatRate(txs, {}).rate, null);

  // gerade Stichprobenzahl: Satz darf nicht auf 2 Nachkommastellen gerundet
  // werden – 16,3 % wären sonst 16 % und die Schätzung läge dauerhaft daneben.
  const zwei = [
    costTx('2026-04-15', 'FA', 10106.41, 'Umsatzsteuer', { description: 'Umsatzsteuer Jan. 26 10.106,41' }),
    costTx('2026-05-15', 'FA', 10106.41, 'Umsatzsteuer', { description: 'Umsatzsteuer Feb. 26 10.106,41' }),
  ];
  const r2 = C.effectiveVatRate(zwei, { '2026-01': 62000, '2026-02': 62000 });
  assert.ok(Math.abs(r2.rate - 0.1630066) < 1e-6, 'erwartet ~16,3 %, bekam ' + r2.rate);
});

test('Fixkosten-Vorschlag: Kartenabrechnung wird eigene Zeile', () => {
  const rows = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].map((m) =>
    costTx(m + '-31', 'Kr Spk Heinsberg Erkelenz', 3500, null, {
      description: 'EIGENE KREDITKARTENABRECHN. | KREDITKARTENABRECHNUNG', is_card_settlement: true }));
  const s = C.suggestFixedCosts(rows, { today: '2026-08-28', months: 6 });
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].label, 'Amex-Sammelabbuchung');
  assert.strictEqual(s[0].bucket, 'card_settlement');
  assert.strictEqual(s[0].amount, 3500);
});

test('Vorschau: geplante Kartenabrechnung kollidiert nicht mit dem offenen Saldo', () => {
  const opts = {
    today: '2026-08-27', weeks: 13, startBalance: 0, invoices: [], apInvoices: [], taxDates: [],
    fixedCosts: [{ label: 'Amex-Sammelabbuchung', amount: 3500, pay_day: 30, rhythm: 'monthly', bucket: 'card_settlement' }],
    cardSettlement: { amount: 4200, date: '2026-08-30' },
  };
  const w = C.buildForecast(opts);
  const august = w.filter((x) => x.from === '2026-08-24')[0];
  assert.strictEqual(august.otherOut, -4200, 'erste Abrechnung mit echtem offenem Saldo, nicht zusätzlich geplant');
  const september = w.filter((x) => x.from === '2026-09-28')[0];
  assert.strictEqual(september.otherOut, -3500, 'spätere Monate laufen über den Planwert');
});

// ── Monatsraster ────────────────────────────────────────────────────────────
const monatlich = C.buildForecast({
  today: '2026-08-27',
  granularity: 'month',
  periods: 6,
  startBalance: 141499.98,
  invoices: [
    { contact: 'Kunde A', dueDate: '2026-08-31', amount: 8250 },
    { contact: 'Kunde B', dueDate: '2026-09-30', amount: 2975 },
    { contact: 'Alt', dueDate: '2026-06-01', amount: 1000 },          // überfällig
    { contact: 'Zu spät', dueDate: '2027-05-01', amount: 50000 },     // außerhalb
  ],
  apInvoices: [],
  fixedCosts: [
    { label: 'Gehälter', amount: 34000, pay_day: 26, rhythm: 'monthly', bucket: 'salary' },
    { label: 'Miete', amount: 1999.2, pay_day: 30, rhythm: 'monthly', bucket: 'supplier' },
    { label: 'Buchführung', amount: 1250, pay_day: 15, rhythm: 'quarterly', start_month: 2, bucket: 'supplier' },
  ],
  taxDates: [{ label: 'UStVA Juli', due_date: '2026-09-10', amount: 10106 }],
  cardSettlement: { amount: 1162.6, date: '2026-09-21' },
});

test('Monatsraster: laufender Monat ab heute, danach volle Kalendermonate', () => {
  assert.strictEqual(monatlich.length, 6);
  assert.strictEqual(monatlich[0].from, '2026-08-27');
  assert.strictEqual(monatlich[0].to, '2026-08-31');
  assert.strictEqual(monatlich[0].label, 'August 2026 (ab heute)');
  assert.strictEqual(monatlich[1].from, '2026-09-01');
  assert.strictEqual(monatlich[1].to, '2026-09-30');
  assert.strictEqual(monatlich[1].label, 'September 2026');
  assert.strictEqual(monatlich[5].label, 'Januar 2027');
});

test('Monatsraster: jeder Posten landet im richtigen Monat', () => {
  assert.strictEqual(monatlich[0].clientPayments, 8250 + 1000, 'Überfälliges zählt sofort');
  assert.strictEqual(monatlich[1].clientPayments, 2975);
  // Zahltag 26 liegt VOR dem Stichtag 27.08. – dieses Gehalt ist schon geflossen
  // und steckt im Kontostand. Offene Rechnungen dagegen zählen weiter (siehe oben):
  // unbezahlt bleibt unbezahlt, eine getätigte Zahlung nicht doppelt planen.
  assert.strictEqual(monatlich[0].salaries, 0);
  assert.strictEqual(monatlich[1].salaries, -34000);
  assert.strictEqual(monatlich[1].taxes, -10106);
  assert.strictEqual(monatlich[1].otherOut, -1162.6);
  assert.ok(!monatlich.flatMap((p) => p.items).some((i) => i.label === 'Zu spät'));
});

test('Monatsraster: Quartals-Fixkosten nur im Quartalsmonat', () => {
  const buchfuehrung = monatlich.map((p) => p.items.filter((i) => i.label === 'Buchführung').length);
  assert.deepStrictEqual(buchfuehrung, [0, 0, 0, 1, 0, 0], 'nur November (Anker Februar → Feb/Mai/Aug/Nov)');
});

test('Monatsraster: Salden schreiben sich fort wie im Wochenraster', () => {
  assert.strictEqual(monatlich[0].startBalance, 141499.98);
  monatlich.forEach((p, i) => {
    assert.strictEqual(p.endBalance, C.round2(p.startBalance + p.net));
    if (i > 0) assert.strictEqual(p.startBalance, monatlich[i - 1].endBalance);
  });
});

test('Wochenraster bleibt unverändert der Standard', () => {
  const w = C.buildForecast({ today: '2026-08-27', startBalance: 0, invoices: [], apInvoices: [], fixedCosts: [], taxDates: [] });
  assert.strictEqual(w.length, 13);
  assert.strictEqual(w[0].from, '2026-08-24');
  assert.strictEqual(w[0].label, null);
});

console.log('\n' + passed + ' Tests bestanden.\n');
