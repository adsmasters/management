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
    { id: 'c-seo',    source_name: 'Google Organic Search 2026', source_type: 'online-marketing', amount: 21885, cost_date: '2026-01-01', notes: null },
    { id: 'c-empf',   source_name: 'Empfehlungen',    source_type: 'empfehlung',       amount: 0,     cost_date: null,         notes: 'Ohne direkte Kosten' },
    { id: 'c-ki',     source_name: 'KI-Suche 2026',   source_type: 'ki',               amount: 4000,  cost_date: '2026-01-01', notes: 'ChatGPT, Perplexity & Co.' },
  ];

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
    'Frischstart Juli GmbH':      months(2024, 7, 20, 1500),   // Erstrechnung Juli 2024 → muss erscheinen
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
      create: function (sourceName, sourceType, amount, costDate, notes) {
        var row = { id: id(), source_name: sourceName, source_type: sourceType, amount: amount || 0, cost_date: costDate || null, notes: notes || null };
        costs.push(row); return ok(row);
      },
      update: function (i, fields) {
        var row = costs.filter(function (c) { return c.id === i; })[0];
        Object.assign(row, fields); return ok(row);
      },
      delete: function (i) { costs = costs.filter(function (c) { return c.id !== i; }); return ok(null); },
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
