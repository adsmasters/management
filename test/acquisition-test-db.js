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
    { id: 'c-omr26',  source_name: 'OMR 2026',        source_type: 'messe',            amount: 23000, cost_date: '2026-05-05', notes: null },
    { id: 'c-seo',    source_name: 'Google Organic Search 2026', source_type: 'online-marketing', amount: 20000, cost_date: '2026-01-01', notes: null, is_recurring: true },
    { id: 'c-empf',   source_name: 'Empfehlungen',    source_type: 'empfehlung',       amount: 0,     cost_date: null,         notes: 'Ohne direkte Kosten' },
    { id: 'c-ki',     source_name: 'KI-Suche 2026',   source_type: 'ki',               amount: 4000,  cost_date: '2026-01-01', notes: 'ChatGPT, Perplexity & Co.', is_recurring: true },
    // Laufende Kanäle – Monatsraster statt Einmalbetrag
    { id: 'c-yt26',   source_name: 'YouTube 2026',    source_type: 'sonstige',         amount: 8000,  cost_date: '2026-01-01', notes: null, is_recurring: true },
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
      costMonths.push({ id: id(), acquisition_cost_id: costId, ym: year + '-' + (m < 10 ? '0' : '') + m, amount: amount });
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
      set: function (costId, ym, amount) {
        var now = new Date().toISOString();
        var row = costMonths.filter(function (m) { return m.acquisition_cost_id === costId && m.ym === ym; })[0];
        if (row) {
          if (Number(row.amount) !== Number(amount)) hist(costId, now, 'month', { ym: ym, old_amount: row.amount, new_amount: amount });
          row.amount = amount;
        } else {
          row = { id: id(), acquisition_cost_id: costId, ym: ym, amount: amount };
          costMonths.push(row);
          hist(costId, now, 'month', { ym: ym, new_amount: amount });
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
    acquisitionCostHistory: {
      available: function () { return ok([]); },
      listForCost: function (costId) {
        return ok(costHistory.filter(function (h) { return h.acquisition_cost_id === costId; })
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
