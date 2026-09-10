/* In-Memory-Stubs für die Akquisitions-Testseite: ersetzt Supabase (window.db)
 * und auth.js, damit js/acquisition.js unverändert gegen Fixture-Daten läuft.
 * Schwerpunkt: der Hinweis auf Kunden ohne Akquisitionsquelle. */
(function () {
  'use strict';
  window.auth = { init: function () {}, getSession: function () { return null; } };

  function copy(x) { return JSON.parse(JSON.stringify(x)); }
  function ok(v) { return Promise.resolve(copy(v)); }
  var seq = 0;
  function id() { return 'gen-' + (++seq); }

  var costs = [
    { id: 'c-omr25',  source_name: 'OMR 2025',        source_type: 'messe',            amount: 23000, cost_date: '2025-05-06', notes: null },
    { id: 'c-omr26',  source_name: 'OMR 2026',        source_type: 'messe',            amount: 23000, cost_date: '2026-05-05', notes: null, updated_at: '2026-08-14T13:05:00Z' },
    { id: 'c-seo',    source_name: 'Google Organic Search 2026', source_type: 'online-marketing', amount: 20000, cost_date: '2026-01-01', notes: null, is_recurring: true },
    { id: 'c-empf',   source_name: 'Empfehlungen',    source_type: 'empfehlung',       amount: 0,     cost_date: null,         notes: 'Ohne direkte Kosten' },
    { id: 'c-ki',     source_name: 'KI-Suche 2026',   source_type: 'ki',               amount: 4000,  cost_date: '2026-01-01', notes: 'ChatGPT, Perplexity & Co.', is_recurring: true },
    // Laufende Kanäle – Monatsraster statt Einmalbetrag
    { id: 'c-yt26',   source_name: 'YouTube 2026',    source_type: 'sonstige',         amount: 8000,  cost_date: '2026-01-01', notes: null, is_recurring: true, updated_at: '2026-09-05T07:28:00Z' },
    { id: 'c-yt25',   source_name: 'YouTube 2025',    source_type: 'sonstige',         amount: 15000, cost_date: '2025-01-01', notes: null, is_recurring: true },
  ];

  // Monatswerte laufender Kosten ('YYYY-MM'). Deckt die drei Zustände ab:
  //   c-seo  → bis zum letzten abgeschlossenen Monat erfasst  → „aktuell"
  //   c-yt26 → hinkt hinterher                                → „x Mon. offen"
  //   c-ki   → laufend, aber noch kein Monat erfasst          → „nichts erfasst"
  //   c-yt25 → abgeschlossenes Vorjahr                        → keine Mahnung
  var costMonths = [];
  function addMonths(costId, year, fromM, toM, amount) {
    for (var m = fromM; m <= toM; m++) {
      costMonths.push({ id: id(), acquisition_cost_id: costId, ym: year + '-' + (m < 10 ? '0' : '') + m,
                        amount: amount, auto_amount: 0, manual_amount: amount });
    }
  }
  // Änderungsverlauf – in der echten DB von Triggern gefüllt, hier nachgebaut,
  // damit die Testseite dasselbe Verhalten zeigt.
  var costHistory = [];
  function hist(costId, when, field, extra) {
    var row = { id: id(), acquisition_cost_id: costId, changed_at: when, field: field,
                ym: null, old_amount: null, new_amount: null, old_text: null, new_text: null };
    Object.keys(extra || {}).forEach(function (k) { row[k] = extra[k]; });
    costHistory.push(row);
  }
  hist('c-yt26', '2026-06-02T09:12:00Z', 'baseline', { new_amount: 5000, new_text: 'YouTube 2026' });
  hist('c-yt26', '2026-07-24T12:44:00Z', 'amount',   { old_amount: 5000, new_amount: 6000 });
  hist('c-yt26', '2026-08-12T08:03:00Z', 'amount',   { old_amount: 6000, new_amount: 8000 });
  hist('c-yt26', '2026-09-05T07:28:00Z', 'name',     { old_text: 'YouTube 2026 (Bis Ende Juli)', new_text: 'YouTube 2026 (Bis Ende August)' });
  hist('c-seo',  '2026-09-01T06:00:00Z', 'baseline', { new_amount: 17500, new_text: 'Google Organic Search 2026' });
  hist('c-seo',  '2026-09-08T05:35:00Z', 'month',    { ym: '2026-08', new_amount: 2500 });
  hist('c-seo',  '2026-09-08T05:35:00Z', 'amount',   { old_amount: 17500, new_amount: 20000 });

  addMonths('c-seo',  2026, 1, 8, 2500);   // Jan–Aug 2026 – vollständig
  addMonths('c-yt26', 2026, 1, 6, 1000);   // nur Jan–Jun 2026
  addMonths('c-yt25', 2025, 1, 12, 1250);  // volles Vorjahr

  var links = [
    { id: 'l1', acquisition_cost_id: 'c-omr25', contact_name: 'Verapur Schlafsysteme GmbH', tag: null },
    { id: 'l2', acquisition_cost_id: 'c-omr25', contact_name: 'IBO International GmbH',     tag: 'Standgespräch' },
    { id: 'l3', acquisition_cost_id: 'c-seo',   contact_name: 'Kreher Feinkost GmbH',       tag: 'ChatGPT' },
  ];

  // status='excluded' → gar kein Umsatz; 'cat:Software' → PPC-Tool-Kunde
  var overrides = [
    { contact_name: 'Adsmasters Verrechnung', status: 'excluded' },
    { contact_name: 'Mädl Media GmbH',        status: 'cat:Software' },
  ];

  // contact → [ [jahr, monat, betrag], ... ]
  var REV = {
    'Verapur Schlafsysteme GmbH': months(2025, 6, 14, 3200),   // zugeordnet (OMR 2025)
    'IBO International GmbH':     months(2025, 8, 12, 2400),   // zugeordnet (OMR 2025)
    'Kreher Feinkost GmbH':       months(2026, 2, 7,  4100),   // zugeordnet (SEO)
    'Nordluft Handels GmbH':      months(2026, 3, 6,  2900),   // OHNE Quelle – neu
    'Pixxprint GmbH':             months(2026, 6, 3,  5200),   // OHNE Quelle – ganz neu
    'Bega Consult GmbH':          months(2023, 4, 30, 1800),   // OHNE Quelle – Altbestand vor Juni 2024 → ausblenden
    'Altbestand Mai GmbH':        months(2024, 5, 20, 1200),   // Erstrechnung Mai 2024 → knapp davor, ausblenden
    'MTS Group - Inter-Union Technohandel GmbH':      months(2024, 7, 20, 1500),   // Erstrechnung Juli 2024 → muss erscheinen
    'Adsmasters Verrechnung':     months(2026, 1, 8,  9000),   // excluded → darf NICHT auftauchen
    'Mädl Media GmbH':            months(2026, 1, 8,  99),     // cat:Software → darf NICHT auftauchen
    'Crazy Canvas UG':            months(2026, 2, 7,  99),     // Auto-Erkennung Software → nicht auftauchen
    'Storno Gutschrift GmbH':     [[2026, 4, -500]],           // nur negativer Umsatz → nicht auftauchen
  };

  function months(startYear, startMonth, count, amount) {
    var out = [], y = startYear, m = startMonth;
    for (var i = 0; i < count; i++) {
      out.push([y, m, amount]);
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  var revenue = [];
  Object.keys(REV).forEach(function (name) {
    REV[name].forEach(function (r) {
      revenue.push({ id: id(), contact_name: name, year: r[0], month: r[1], total_amount: r[2] });
    });
  });

  // Buchungen wie in cost_transactions – Schreibweisen bewusst gemischt,
  // genau wie in den echten Kreissparkasse-/Amex-Uploads.
  var costTx = [];
  function tx(date, payee, gross, net, cat, excluded) {
    costTx.push({
      id: id(), tx_date: date, year: +date.slice(0, 4), month: +date.slice(5, 7),
      source: 'amex', payee: payee, description: payee, amount_gross: gross,
      amount_net: net, category: cat, excluded: !!excluded,
    });
  }
  // Echte Werte aus cost_transactions (Jan–Aug 2026, netto) – als Monatssummen
  // gebucht, damit die Testseite dieselben Zahlen zeigt wie die Live-Daten.
  [['01',3450],['02',1250],['03',1200],['04',1300],['05',1250],['06',2700],['07',2750],['08',3050]]
    .forEach(function (m, i) { tx('2026-' + m[0] + '-15', i % 2 ? 'T & P Fotografie' : 'T&P Fotografie', m[1], m[1], 'Freelancer/Externe'); });
  [['01',1540],['02',2561],['05',2442.40],['06',5865],['07',2531],['08',626]]
    .forEach(function (m) { tx('2026-' + m[0] + '-12', 'PAYPAL *BACKLINKED 22828679560', Math.round(m[1] * 1.19 * 100) / 100, m[1], 'Marketing'); });
  [['02',2262.19],['05',1508.33]]
    .forEach(function (m) { tx('2026-' + m[0] + '-20', 'Baris Dag', m[1], m[1], 'Freelancer/Externe'); });
  tx('2026-06-03', 'Baris Dag', 37.00, 37.00, 'Reisekosten');           // andere Kategorie
  tx('2026-01-01', 'GOOGLE *ADS6354044357 CC@GOOGLE.COM', 143.86, 143.86, 'Software');
  tx('2026-05-01', 'GOOGLE*ADS6354044357 GO CC GOOGLE.COM', 80.71, 80.71, 'Software');
  tx('2026-06-01', 'GOOGLE*ADS6354044357 GO CC GOOGLE.COM', 278.19, 278.19, 'Software');
  tx('2025-11-04', 'PAYPAL *BACKLINKED 22828679560', 238, 200, 'Marketing');   // Vorjahr
  tx('2026-08-20', 'T & P Fotografie', 400, 400, 'Freelancer/Externe', true);  // ausgeschlossen

  var costRules = [
    { id: 'r-yt', acquisition_cost_id: 'c-yt26', match_type: 'contains', pattern: 'Fotografie', label: 'T&P Fotografie' },
  ];

  window.db = {
    acquisitionCosts: {
      list: function () { return ok(costs); },
      create: function (sourceName, sourceType, amount, costDate, notes, isRecurring) {
        var row = { id: id(), source_name: sourceName, source_type: sourceType, amount: amount || 0,
                    cost_date: costDate || null, notes: notes || null, is_recurring: !!isRecurring };
        costs.push(row);
        hist(row.id, new Date().toISOString(), 'created', { new_amount: row.amount, new_text: row.source_name });
        return ok(row);
      },
      update: function (i, fields) {
        var row = costs.filter(function (c) { return c.id === i; })[0];
        var now = new Date().toISOString();
        if (fields.amount !== undefined && Number(fields.amount) !== Number(row.amount)) {
          hist(i, now, 'amount', { old_amount: row.amount, new_amount: fields.amount });
        }
        if (fields.source_name !== undefined && fields.source_name !== row.source_name) {
          hist(i, now, 'name', { old_text: row.source_name, new_text: fields.source_name });
        }
        Object.assign(row, fields); return ok(row);
      },
      delete: function (i) {
        costs = costs.filter(function (c) { return c.id !== i; });
        costMonths = costMonths.filter(function (m) { return m.acquisition_cost_id !== i; });
        return ok(null);
      },
    },
    acquisitionCostMonths: {
      listAll: function () { return ok(costMonths); },
      set: function (costId, ym, amounts) {
        var now    = new Date().toISOString();
        var auto   = Math.round((Number(amounts.auto)   || 0) * 100) / 100;
        var manual = Math.round((Number(amounts.manual) || 0) * 100) / 100;
        var total  = Math.round((auto + manual) * 100) / 100;
        var row = costMonths.filter(function (m) { return m.acquisition_cost_id === costId && m.ym === ym; })[0];
        if (row) {
          if (Number(row.amount) !== total) hist(costId, now, 'month', { ym: ym, old_amount: row.amount, new_amount: total });
          row.amount = total; row.auto_amount = auto; row.manual_amount = manual;
        } else {
          row = { id: id(), acquisition_cost_id: costId, ym: ym, amount: total, auto_amount: auto, manual_amount: manual };
          costMonths.push(row);
          hist(costId, now, 'month', { ym: ym, new_amount: total });
        }
        return ok(row);
      },
      remove: function (costId, ym) {
        var row = costMonths.filter(function (m) { return m.acquisition_cost_id === costId && m.ym === ym; })[0];
        if (row) hist(costId, new Date().toISOString(), 'month', { ym: ym, old_amount: row.amount });
        costMonths = costMonths.filter(function (m) { return !(m.acquisition_cost_id === costId && m.ym === ym); });
        return ok(null);
      },
      removeAll: function (costId) {
        costMonths = costMonths.filter(function (m) { return m.acquisition_cost_id !== costId; });
        return ok(null);
      },
    },
    acquisitionCostRules: {
      listAll: function () { return ok(costRules); },
      create: function (costId, pattern, label, matchType) {
        var row = { id: id(), acquisition_cost_id: costId, pattern: pattern,
                    label: label || null, match_type: matchType || 'contains' };
        costRules.push(row); return ok(row);
      },
      remove: function (i) { costRules = costRules.filter(function (r) { return r.id !== i; }); return ok(null); },
    },
    cost: {
      transactions: { all: function () { return ok(costTx); } },
    },
    acquisitionCostHistory: {
      available: function () { return ok([]); },
      listAmountChanges: function (costId) {
        return ok(costHistory.filter(function (h) {
            return h.acquisition_cost_id === costId &&
                   ['amount', 'created', 'baseline'].indexOf(h.field) !== -1;
          })
          .slice().sort(function (a, b) { return b.changed_at.localeCompare(a.changed_at); }));
      },
    },
    acquisitionContactLinks: {
      listAll: function () { return ok(links); },
      create: function (costId, contactName, tag) {
        var row = { id: id(), acquisition_cost_id: costId, contact_name: contactName, tag: tag || null };
        links.push(row); return ok(row);
      },
      setTag: function (costId, contactName, tag) {
        var rows = links.filter(function (l) { return l.acquisition_cost_id === costId && l.contact_name === contactName; });
        rows.forEach(function (l) { l.tag = tag || null; });
        return ok(rows);
      },
      delete: function (costId, contactName) {
        links = links.filter(function (l) { return !(l.acquisition_cost_id === costId && l.contact_name === contactName); });
        return ok(null);
      },
    },
    contactOverrides: { listAll: function () { return ok(overrides); } },
    revenue: {
      allRows: function () { return ok(revenue); },
      forContacts: function (names) {
        return ok(revenue.filter(function (r) { return names.indexOf(r.contact_name) !== -1; }));
      },
      updateAmount: function (i, amt) {
        var row = revenue.filter(function (r) { return r.id === i; })[0];
        if (row) row.total_amount = amt; return ok(row);
      },
      insertRow: function (year, month, contactName, amount) {
        var row = { id: id(), year: year, month: month, contact_name: contactName, total_amount: amount };
        revenue.push(row); return ok(row);
      },
    },
  };
})();
