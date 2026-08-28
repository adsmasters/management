/* In-Memory-Stubs für die Cashflow-Testseite: ersetzt Supabase (window.db) und
 * auth.js, damit js/cashflow.js unverändert gegen Fixture-Daten läuft. */
(function () {
  'use strict';
  window.auth = { init: function () {}, getSession: function () { return null; } };

  // ?leer=1 startet mit leerem Fixkosten-Plan (Zustand direkt nach dem Anlegen)
  var LEER = /[?&]leer=1/.test(location.search);

  var store = {
    bank_accounts: [
      { id: 'acc-ksk', source: 'kreissparkasse', name: 'Kreissparkasse Geschäftskonto', kind: 'bank', opening_balance: 50000, opening_date: null, settlement_day: null },
      { id: 'acc-amex', source: 'amex', name: 'American Express', kind: 'credit_card', opening_balance: 0, opening_date: null, settlement_day: null },
    ],
    bank_transactions: [],
    bank_imports: [],
    fixed_costs: [
      { id: 'fc1', label: 'Gehälter Mitarbeiter', amount: 32000, pay_day: 27, rhythm: 'monthly', start_month: null, bucket: 'salary', active: true, sort: 10 },
      { id: 'fc2', label: 'Miete Büro', amount: 1999.2, pay_day: 30, rhythm: 'monthly', start_month: null, bucket: 'supplier', active: true, sort: 20 },
      { id: 'fc3', label: 'Software-Abos', amount: 2400, pay_day: 15, rhythm: 'monthly', start_month: null, bucket: 'supplier', active: true, sort: 30 },
    ],
    tax_dates: [
      { id: 'tx1', kind: 'gewst', label: 'Gewerbesteuer VZ', due_date: nextMonthDay(15), amount: 5775, auto_estimate: false },
    ],
    ap_invoices: [
      { id: 'ap1', kind: 'supplier', supplier: 'HLL Rechtsanwälte', amount: 2380, due_date: inDays(9), paid: false, source: 'manual' },
      { id: 'ap2', kind: 'adspend_amazon', supplier: 'Amazon Advertising', amount: 21000, due_date: inDays(16), paid: false, source: 'manual' },
    ],
    cashflow_settings: [],
    revenue: [],
  };
  if (LEER) store.fixed_costs.forEach(function (f) { f.amount = 0; });
  var seq = 0;
  function id() { return 'gen-' + (++seq); }
  function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function inDays(n) { var d = new Date(); d.setDate(d.getDate() + n); return iso(d); }
  function nextMonthDay(day) { var d = new Date(); d.setMonth(d.getMonth() + 1); d.setDate(day); return iso(d); }
  function copy(x) { return JSON.parse(JSON.stringify(x)); }
  function ok(v) { return Promise.resolve(copy(v)); }

  // Umsatz-Fixture für die UStVA-Schätzung (Netto je Monat)
  (function seedRevenue() {
    var now = new Date();
    for (var back = 0; back < 6; back++) {
      var d = new Date(now.getFullYear(), now.getMonth() - back, 1);
      store.revenue.push({ contact_name: 'Red Bull GmbH', year: d.getFullYear(), month: d.getMonth() + 1, total_amount: 24000 });
      store.revenue.push({ contact_name: 'Kreher Feinkost GmbH', year: d.getFullYear(), month: d.getMonth() + 1, total_amount: 38000 });
    }
  })();

  window.db = {
    revenue: { allRows: function () { return ok(store.revenue); } },
    cost: {
      categoryRules: { list: function () { return ok([
        { match_type: 'contains', pattern: 'Damian Zielinski', category: 'Employee' },
        { match_type: 'contains', pattern: 'Gabriele Dziuba', category: 'Employee' },
        { match_type: 'contains', pattern: 'Techniker Krankenkasse', category: 'Employee' },
        { match_type: 'contains', pattern: 'Gewerbemiete', category: 'Büro' },
        { match_type: 'contains', pattern: 'Telekom', category: 'Büro' },
        { match_type: 'contains', pattern: 'Gewerbesteuer', category: 'Steuern' },
        { match_type: 'contains', pattern: 'INDEED', category: 'Recruitment' },
        { match_type: 'contains', pattern: 'JOIN.COM', category: 'Marketing' },
        { match_type: 'contains', pattern: 'UPWORK', category: 'Freelancer/Externe' },
        { match_type: 'contains', pattern: 'ANTHROPIC', category: 'Software' },
        { match_type: 'contains', pattern: 'OPENAI', category: 'Software' },
      ]); } },
      vatRules: { list: function () { return ok([
        { match_type: 'contains', pattern: 'Gewerbemiete', vat_rate: 0.19 },
        { match_type: 'contains', pattern: 'Telekom', vat_rate: 0.19 },
      ]); } },
      excludeRules: { list: function () { return ok([]); } },
      transactions: {
        // Sechs Monate wiederkehrende Buchungen im Format von cost_transactions
        all: function () {
          var out = [], now = new Date();
          function ym(back) { var d = new Date(now.getFullYear(), now.getMonth() - back, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
          function row(m, day, payee, gross, cat, extra) {
            return Object.assign({ tx_date: m + '-' + String(day).padStart(2, '0'), payee: payee,
              description: payee + ' | Verwendungszweck', amount_gross: gross, amount_net: gross,
              category: cat, excluded: false }, extra || {});
          }
          for (var b = 1; b <= 6; b++) {
            var m = ym(b);
            out.push(row(m, 26, 'Christian Doennewald', 2608, 'Employee'));
            out.push(row(m, 27, 'Techniker Krankenkasse', 5238, 'Employee'));
            out.push(row(m, 29, 'D/P Communications & Media GmbH', 1999.2, 'Büro'));
            out.push(row(m, 4, 'OPTMYZR COPENHAGEN', 599, 'Software'));
            out.push(row(m, 10, 'Landeshauptstadt Duesseldorf', 5775, 'Steuern'));
            out.push(row(m, 6, 'PAYPAL *DOLIVE.YOURLIFE ' + (4029357733 + b), 7543, 'Freelancer/Externe'));
            // Finanzamt-Sammellastschrift: brutto USt + Lohnsteuer, netto = Lohnsteuer
            out.push(row(m, 15, 'STEUERVERWALTUNG NRW', 14914.02, 'Employee', {
              description: 'STEUERVERWALTUNG NRW | Umsatzsteuer ' + ['Jan.','Feb.','Mrz.','Apr.','Mai','Jun.'][b-1] + ' 26 10.106,41 Lohnsteuer Mrz. 26 4.807,61',
              amount_net: 4807.61 }));
          }
          return ok(out);
        },
      },
    },
    cashflow: {
      accounts: {
        list: function () { return ok(store.bank_accounts); },
        update: function (i, f) {
          var row = store.bank_accounts.filter(function (a) { return a.id === i; })[0];
          Object.assign(row, f); return ok(row);
        },
      },
      imports: {
        list: function () { return ok(store.bank_imports.slice().reverse()); },
        create: function (source, filename, fileHash, from, to, label) {
          var row = { id: id(), source: source, filename: filename, file_hash: fileHash, period_from: from, period_to: to, period_label: label, row_count: 0, skipped_count: 0, created_at: new Date().toISOString() };
          store.bank_imports.push(row); return ok(row);
        },
        update: function (i, f) {
          var row = store.bank_imports.filter(function (x) { return x.id === i; })[0];
          Object.assign(row, f); return ok(row);
        },
        delete: function (i) {
          store.bank_imports = store.bank_imports.filter(function (x) { return x.id !== i; });
          store.bank_transactions = store.bank_transactions.filter(function (t) { return t.import_id !== i; });
          return ok(null);
        },
        findByHash: function (h) { return ok(store.bank_imports.filter(function (x) { return x.file_hash === h; })); },
      },
      transactions: {
        all: function () { return ok(store.bank_transactions); },
        insertMany: function (rows) {
          var seen = {};
          store.bank_transactions.forEach(function (t) { seen[t.dedup_key] = 1; });
          var inserted = [];
          rows.forEach(function (r) {
            if (seen[r.dedup_key]) return;          // UNIQUE(dedup_key) wie in Postgres
            seen[r.dedup_key] = 1;
            var row = Object.assign({ id: id() }, r);
            store.bank_transactions.push(row); inserted.push(row);
          });
          return ok(inserted);
        },
        update: function (i, f) {
          var row = store.bank_transactions.filter(function (t) { return t.id === i; })[0];
          Object.assign(row, f); return ok(row);
        },
      },
      fixedCosts: {
        list: function () { return ok(store.fixed_costs); },
        create: function (f) { var row = Object.assign({ id: id(), active: true }, f); store.fixed_costs.push(row); return ok(row); },
        update: function (i, f) { var row = store.fixed_costs.filter(function (x) { return x.id === i; })[0]; Object.assign(row, f); return ok(row); },
        delete: function (i) { store.fixed_costs = store.fixed_costs.filter(function (x) { return x.id !== i; }); return ok(null); },
      },
      taxDates: {
        list: function () { return ok(store.tax_dates); },
        create: function (f) { var row = Object.assign({ id: id() }, f); store.tax_dates.push(row); return ok(row); },
        update: function (i, f) { var row = store.tax_dates.filter(function (x) { return x.id === i; })[0]; Object.assign(row, f); return ok(row); },
        delete: function (i) { store.tax_dates = store.tax_dates.filter(function (x) { return x.id !== i; }); return ok(null); },
      },
      apInvoices: {
        list: function () { return ok(store.ap_invoices); },
        create: function (f) { var row = Object.assign({ id: id(), paid: false, source: 'manual' }, f); store.ap_invoices.push(row); return ok(row); },
        update: function (i, f) { var row = store.ap_invoices.filter(function (x) { return x.id === i; })[0]; Object.assign(row, f); return ok(row); },
        delete: function (i) { store.ap_invoices = store.ap_invoices.filter(function (x) { return x.id !== i; }); return ok(null); },
        upsertFromLexoffice: function (rows) {
          var seen = {}; store.ap_invoices.forEach(function (a) { if (a.lexoffice_id) seen[a.lexoffice_id] = 1; });
          var ins = [];
          rows.forEach(function (r) {
            if (seen[r.lexoffice_id]) return;
            seen[r.lexoffice_id] = 1;
            var row = Object.assign({ id: id(), paid: false }, r);
            store.ap_invoices.push(row); ins.push(row);
          });
          return ok(ins);
        },
      },
      settings: {
        list: function () { return ok(store.cashflow_settings); },
        set: function (k, v) {
          var row = store.cashflow_settings.filter(function (s) { return s.key === k; })[0];
          if (row) row.value = v; else { row = { key: k, value: v }; store.cashflow_settings.push(row); }
          return ok(row);
        },
      },
    },
  };

  // Offene Rechnungen wie sie die Edge Function liefert (inkl. der beiden Red-Bull-Rechnungen)
  localStorage.setItem('cashflowInvoices', JSON.stringify({
    ts: new Date().toISOString(),
    invoices: [
      { id: 'i1', number: '2026-0501', contact: 'Red Bull GmbH', dueDate: inDays(12), open: 16562.66, openGross: 19708.57, isAdSpend: true },
      { id: 'i2', number: '2026-0502', contact: 'Red Bull GmbH', dueDate: inDays(26), open: 16197.75, openGross: 19275.32, isAdSpend: true },
      { id: 'i3', number: '2026-0503', contact: 'Kreher Feinkost GmbH', dueDate: inDays(5), open: 2000, openGross: 2380, isAdSpend: false },
      { id: 'i4', number: '2026-0490', contact: 'Pol-Power GmbH', dueDate: inDays(-14), open: 4000, openGross: 4760, isAdSpend: false },
      { id: 'i5', number: '2026-0510', contact: 'Bega Brands', dueDate: inDays(40), open: 8000, openGross: 9520, isAdSpend: false },
    ],
    purchases: [
      { id: 'p1', number: 'ER-2026-77', supplier: 'Visual Pursuit GmbH', dueDate: inDays(20), openGross: 1785, isAdSpend: false },
    ],
    purchaseError: null,
  }));
  localStorage.setItem('lexofficeKey', '');
  window.__cfStore = store;
})();
