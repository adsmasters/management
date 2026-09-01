/* ===========================================================================
 * cashflow.js – Cashflow-Seite: Ist aus Kontoumsätzen + 13-Wochen-Vorschau
 * Rechenlogik steckt in cashflow-engine.js (dort getestet), hier nur Laden,
 * Speichern und Darstellung.
 * =========================================================================== */
(function () {
  'use strict';

  var E = window.CostEngine;
  var C = window.CashflowEngine;
  var MONTHS = window.MONTHS_DE;

  var state = {
    accounts: [], txs: [], imports: [], fixedCosts: [], taxDates: [], apInvoices: [],
    settings: {}, rules: { categoryRules: [], vatRules: [], excludeRules: [] },
    invoices: [], purchases: [], purchaseError: null, invoiceStamp: null,
    revenueRows: [], clientNames: [],
    costTxs: null,          // Kostenanalyse-Buchungen, erst bei Bedarf geladen
    fcSuggestions: [],
  };
  var charts = {};
  var lastData = { verlauf: null, forecast: null };   // für das Neuzeichnen beim Reiterwechsel
  var openWeeks = {}, openMonths = {};
  // Standard ist die Monatsansicht – Wochen machen bei einem Puffer von über
  // 100.000 € nur nervös. Auswahl bleibt im Browser gespeichert.
  var GRAIN_KEY = 'cashflowGrain';
  var RANGE_KEY = 'cashflowRange';
  var range = null;          // { from:'YYYY-MM', to:'YYYY-MM' } – null = alles
  function grain() { return localStorage.getItem(GRAIN_KEY) === 'week' ? 'week' : 'month'; }
  function grainCount() { return grain() === 'week' ? 13 : 6; }
  function grainLabel() { return grain() === 'week' ? '13 Wochen' : '6 Monate'; }

  // ── Helfer ────────────────────────────────────────────────────────────────
  var eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  function fmt(n) { return eur.format(Number(n) || 0); }
  function fmt0(n) { return Math.round(Number(n) || 0).toLocaleString('de-DE') + ' €'; }
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function fmtDate(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[3] + '.' + m[2] + '.' + m[1] : (iso || '—');
  }
  function fmtDateShort(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[3] + '.' + m[2] + '.' : (iso || '—');
  }
  function monthLabel(y, m) { return MONTHS[m - 1] + ' ' + y; }
  function num(v) { var n = E.parseGermanAmount(v); return isFinite(n) ? n : 0; }
  function showError(msg) {
    el('loading').classList.add('hidden');
    el('error').innerHTML = '<div class="alert alert-danger">⚠️ ' + esc(msg) + '</div>';
  }
  // djb2 – gleicher Datei-Fingerprint wie in der Kostenanalyse
  function hashStr(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return 'h' + (h >>> 0).toString(36) + '_' + str.length;
  }
  // Bytes lesen und Kodierung selbst bestimmen: Sparkassen-Exporte sind oft Latin-1.
  function readFile(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () {
        var buf = r.result;
        var utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
        if (utf8.indexOf('�') !== -1) {
          try { return res(new TextDecoder('iso-8859-1').decode(buf)); } catch (e) { /* weiter mit UTF-8 */ }
        }
        res(utf8);
      };
      r.onerror = rej;
      r.readAsArrayBuffer(file);
    });
  }

  function supaUrl() { return localStorage.getItem('supabaseUrl') || 'https://lgrnmiszhhahfcmctmwo.supabase.co'; }
  function supaKey() { return localStorage.getItem('supabaseKey') || ''; }
  function lexKey() { return (localStorage.getItem('lexofficeKey') || '').trim(); }
  function authToken() {
    try {
      var t = JSON.parse(localStorage.getItem('sb-lgrnmiszhhahfcmctmwo-auth-token'));
      return (t && (t.access_token || (t.currentSession && t.currentSession.access_token))) || supaKey();
    } catch (e) { return supaKey(); }
  }

  // ── Einstellungen ─────────────────────────────────────────────────────────
  function setting(key, fallback) {
    var v = state.settings[key];
    return v == null ? fallback : v;
  }
  function adSpendOut() { return setting('adspend', {}).out || C.DEFAULT_ADSPEND_PATTERNS; }
  function adSpendIn() { return setting('adspend', {}).in || C.DEFAULT_ADSPEND_INVOICE_KEYWORDS; }
  function ustCfg() {
    var d = setting('ustva', {});
    return {
      extension: d.extension !== false,
      // 'effective' = Satz aus der eigenen Zahlungshistorie (enthält die Vorsteuer
      // bereits), 'model' = Umsatz × Satz − Vorsteuer.
      mode: d.mode || 'model',
      rate: d.rate != null ? d.rate : 0.19,
      auto: d.auto !== false,
      samples: d.samples || [],
      derivedAt: d.derivedAt || null,
    };
  }

  // Die importierten Kontoumsätze im Format von cost_transactions: so kann
  // derselbe Vorschlags-Algorithmus auf beiden Quellen laufen. Nur Abflüsse,
  // Karten-Einzelposten bleiben draußen (die zahlt die Sammelabbuchung).
  function bankAsCostRows() {
    return state.txs.filter(function (t) {
      return t.amount < 0 && t.source !== 'amex';
    }).map(function (t) {
      var gross = Math.abs(Number(t.amount) || 0);
      var net = gross;
      if (E.isBundledTaxPayment(t)) {
        var lst = E.extractLohnsteuer(t.description);
        if (lst != null) net = lst;
      }
      return {
        tx_date: t.tx_date, payee: t.payee, description: t.description,
        amount_gross: gross, amount_net: net, category: t.category,
        is_card_settlement: t.is_card_settlement, excluded: false,
      };
    });
  }

  // Monate, die die importierten Kontoumsätze abdecken.
  function bankMonthCount() {
    var m = {};
    state.txs.forEach(function (t) { if (t.source !== 'amex') m[t.tx_date.slice(0, 7)] = 1; });
    return Object.keys(m).length;
  }

  // Kostenanalyse-Buchungen nachladen (1.900+ Zeilen) – nur wenn gebraucht.
  function ensureCostTxs() {
    if (state.costTxs) return Promise.resolve(state.costTxs);
    return window.db.cost.transactions.all().then(function (rows) {
      state.costTxs = (rows || []).map(function (r) {
        return Object.assign({}, r, {
          amount_gross: Number(r.amount_gross) || 0,
          amount_net: r.amount_net != null ? Number(r.amount_net) : Number(r.amount_gross) || 0,
        });
      });
      return state.costTxs;
    });
  }

  function revenueByPeriod() {
    var out = {};
    state.revenueRows.forEach(function (r) {
      var k = r.year + '-' + pad2(r.month);
      out[k] = C.round2((out[k] || 0) + (Number(r.total_amount) || 0));
    });
    return out;
  }
  function enrichOpts() {
    return {
      rules: state.rules,
      adspendPatterns: adSpendOut(),
      adspendInvoiceKeywords: adSpendIn(),
      clientNames: state.clientNames,
    };
  }

  // ── Laden ─────────────────────────────────────────────────────────────────
  function loadAll() {
    return Promise.all([
      window.db.cashflow.accounts.list(),
      window.db.cashflow.transactions.all(),
      window.db.cashflow.imports.list(),
      window.db.cashflow.fixedCosts.list(),
      window.db.cashflow.taxDates.list(),
      window.db.cashflow.apInvoices.list(),
      window.db.cashflow.settings.list(),
      window.db.cost.categoryRules.list().catch(function () { return []; }),
      window.db.cost.vatRules.list().catch(function () { return []; }),
      window.db.cost.excludeRules.list().catch(function () { return []; }),
      window.db.revenue.allRows().catch(function () { return []; }),
    ]).then(function (r) {
      state.accounts = r[0] || [];
      state.rules = { categoryRules: r[7] || [], vatRules: r[8] || [], excludeRules: r[9] || [] };
      // Kategorie wird beim Import gespeichert. Regeln, die es damals noch nicht
      // gab (z.B. 'Geldanlage'), greifen sonst nie – deshalb für Buchungen ohne
      // Kategorie einmal frisch bestimmen.
      state.txs = (r[1] || []).map(function (t) {
        return t.category ? t : Object.assign({}, t, { category: C.categoryOf(t, state.rules) });
      });
      state.imports = r[2] || [];
      state.fixedCosts = r[3] || [];
      state.taxDates = r[4] || [];
      state.apInvoices = r[5] || [];
      state.settings = {};
      (r[6] || []).forEach(function (s) { state.settings[s.key] = s.value; });
      state.revenueRows = r[10] || [];
      state.clientNames = [...new Set(state.revenueRows.map(function (x) { return x.contact_name; }).filter(Boolean))];
      loadCachedInvoices();
    });
  }

  function loadCachedInvoices() {
    try {
      var raw = JSON.parse(localStorage.getItem('cashflowInvoices') || 'null');
      if (raw && raw.invoices) {
        state.invoices = raw.invoices;
        state.purchases = raw.purchases || [];
        state.purchaseError = raw.purchaseError || null;
        state.invoiceStamp = raw.ts || null;
      }
    } catch (e) { /* kein Cache */ }
  }

  function fetchInvoices() {
    if (!lexKey()) {
      showError('LexOffice ist in diesem Browser nicht verbunden. Bitte in den <a href="settings.html">Einstellungen</a> den API-Key eintragen.');
      return Promise.resolve();
    }
    var btn = el('reloadInvoices');
    btn.disabled = true; btn.textContent = 'Lädt…';
    return fetch(supaUrl() + '/functions/v1/cashflow-invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken(), 'apikey': supaKey() },
      body: JSON.stringify({ lexofficeKey: lexKey(), adSpendKeywords: adSpendIn() }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      btn.disabled = false; btn.textContent = '↻ Rechnungen aus LexOffice';
      if (d.error) { showError('LexOffice: ' + d.error); return; }
      state.invoices = d.invoices || [];
      state.purchases = d.purchases || [];
      state.purchaseError = d.purchaseError || null;
      state.invoiceStamp = new Date().toISOString();
      try {
        localStorage.setItem('cashflowInvoices', JSON.stringify({
          ts: state.invoiceStamp, invoices: state.invoices,
          purchases: state.purchases, purchaseError: state.purchaseError,
        }));
      } catch (e) { /* Cache optional */ }
      render();
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = '↻ Rechnungen aus LexOffice';
      showError(e.message);
    });
  }

  // ── Ableitungen ───────────────────────────────────────────────────────────
  function balances() { return C.balances(state.txs, state.accounts); }
  function depot() { return C.depotValue(state.txs, setting('depot', {})); }

  function bankSources() {
    var out = {};
    state.accounts.forEach(function (a) { if ((a.kind || 'bank') !== 'credit_card') out[a.source] = 1; });
    if (!Object.keys(out).length) out.kreissparkasse = 1;
    return out;
  }

  // Nächste Sammelabbuchung der Kreditkarte: konfigurierter Abrechnungstag,
  // sonst der Tag der letzten erkannten Sammelabbuchung, sonst der 1.
  function nextSettlementDate() {
    var card = state.accounts.filter(function (a) { return a.kind === 'credit_card'; })[0];
    var day = card && card.settlement_day ? Number(card.settlement_day) : null;
    if (!day) {
      var last = state.txs.filter(function (t) { return t.is_card_settlement && t.source !== 'amex'; })
        .sort(function (a, b) { return a.tx_date < b.tx_date ? 1 : -1; })[0];
      day = last ? Number(last.tx_date.slice(8, 10)) : 1;
    }
    var t = todayIso(), y = +t.slice(0, 4), m = +t.slice(5, 7);
    var iso = C.isoOf(y, m, day);
    if (iso <= t) { m++; if (m > 12) { m = 1; y++; } iso = C.isoOf(y, m, day); }
    return iso;
  }

  // Vorsteuer eines Monats aus den eigenen Buchungen – gleiche MwSt-Regeln
  // wie in der Kostenanalyse (cost_vat_rules).
  function inputVatForMonth(year, month) {
    var sum = 0;
    state.txs.forEach(function (t) {
      if (t.is_card_settlement) return;
      var amt = Number(t.amount) || 0;
      if (amt >= 0) return;
      if (t.year !== year || t.month !== month) return;
      var v = E.applyVat({ description: t.description, tx_date: t.tx_date, amount_gross: Math.abs(amt) }, state.rules.vatRules || []);
      sum += v.vat_amount;
    });
    return C.round2(sum);
  }

  function netRevenueForMonth(year, month) {
    return C.round2(state.revenueRows.reduce(function (s, r) {
      return (r.year === year && r.month === month) ? s + (Number(r.total_amount) || 0) : s;
    }, 0));
  }

  // Automatisch geschätzte UStVA-Termine im Vorschau-Zeitraum.
  // Ein manuell erfasster Termin (tax_dates, kind='ustva') mit gleichem
  // Fälligkeitsdatum hat Vorrang.
  function autoUstvaRows(fromIso, toIso) {
    var cfg = ustCfg();
    if (!cfg.auto) return [];
    var manual = {};
    state.taxDates.forEach(function (t) { if (t.kind === 'ustva') manual[t.due_date] = 1; });
    var out = [];
    // Voranmeldungszeiträume: die letzten 4 Monate abdecken – der Zahltag liegt
    // je nach Fristverlängerung 1–2 Monate später.
    var t = todayIso(), y = +t.slice(0, 4), m = +t.slice(5, 7);
    for (var back = 4; back >= -3; back--) {
      var yy = y, mm = m - back;
      while (mm < 1) { mm += 12; yy--; }
      while (mm > 12) { mm -= 12; yy++; }
      var due = C.ustvaDueDate(yy, mm, cfg.extension);
      if (due < fromIso || due > toIso) continue;
      if (manual[due]) continue;
      var netRev = netRevenueForMonth(yy, mm);
      // Erfahrungswert: der abgeleitete Satz IST schon die Netto-Zahlung
      // (Vorsteuer steckt drin) → nicht zusätzlich abziehen.
      var vorsteuer = cfg.mode === 'effective' ? 0 : inputVatForMonth(yy, mm);
      var amount = C.estimateUstva({ netRevenue: netRev, vatRate: cfg.rate, inputVat: vorsteuer });
      out.push({
        auto: true, kind: 'ustva', due_date: due, amount: amount,
        label: 'UStVA ' + monthLabel(yy, mm) + ' (geschätzt)',
        period: { year: yy, month: mm }, netRevenue: netRev, inputVat: vorsteuer,
      });
    }
    return out;
  }

  // Erster und letzter Tag des Vorschau-Zeitraums (für Steuertermine etc.)
  function forecastSpan() {
    var list = C.periodsFor(todayIso(), grain(), grainCount());
    return { from: list[0].from, to: list[list.length - 1].to };
  }

  function forecast() {
    var b = balances();
    var span = forecastSpan();
    var start = span.from, lastDay = span.to;
    var cardOpen = b.cardOpen ? b.cardOpen.amount : 0;
    return C.buildForecast({
      today: todayIso(),
      granularity: grain(),
      periods: grainCount(),
      startBalance: b.bank,
      // Brutto einplanen – so kommt das Geld aufs Konto. Im Detail steht
      // zusätzlich der Netto-Betrag, mit dem die Rechnungsseite arbeitet.
      invoices: state.invoices.map(function (v) {
        var gross = v.openGross != null ? v.openGross : v.open;
        var label = v.contact + (v.number ? ' · ' + v.number : '');
        if (v.open != null && Math.abs(gross - v.open) > 0.01) label += ' (netto ' + fmt(v.open) + ')';
        return { contact: label, dueDate: v.dueDate, amount: gross, isAdSpend: !!v.isAdSpend };
      }),
      apInvoices: state.apInvoices,
      fixedCosts: state.fixedCosts,
      taxDates: state.taxDates.concat(autoUstvaRows(start, lastDay)),
      cardSettlement: cardOpen < 0 ? { amount: Math.abs(cardOpen), date: nextSettlementDate() } : null,
    });
  }

  // ── Rendern ───────────────────────────────────────────────────────────────
  function render() {
    // Erst sichtbar schalten, dann zeichnen: ein Chart, das in einem
    // display:none-Container entsteht, misst 0 px und staucht seine Achsen.
    el('loading').classList.add('hidden');
    el('content').classList.remove('hidden');
    var weeks = forecast();
    renderKpis();
    renderActuals();
    renderForecast(weeks);
    renderImports();
    renderFixed();
    renderTaxes();
    renderAp();
    renderAccounts();
    renderDepot();
    renderStamp();
  }

  // Vermögen = Bankkonten + Depot. Bewusst ohne Kreditkarte: die offenen
  // Kartenumsätze sind eine Verbindlichkeit und stehen in der Vorschau.
  function renderDepot() {
    var d = depot();
    var b = balances();
    el('depotOpening').value = d.opening_value ? String(d.opening_value.toFixed(2)).replace('.', ',') : '';
    el('depotDate').value = d.opening_date || '';
    el('depotNote').innerHTML = d.count
      ? 'Seit ' + (d.opening_date ? fmtDate(d.opening_date) : 'Beginn der Importe') + ' sind <strong>'
        + esc(fmt(d.deposits)) + '</strong> in ' + d.count + ' Zahlung(en) ins Depot geflossen · '
        + 'Depotwert <strong>' + esc(fmt(d.value)) + '</strong>. '
        + 'Das ist der Einstandswert – Kursgewinne stecken nicht drin. Für den echten Wert den Depotstand '
        + 'als Stichtagswert eintragen, ab da rechnet die Automatik weiter.'
      : 'Noch keine Buchung in der Kategorie <strong>Geldanlage</strong>. Die Kategorie kommt aus den Regeln der '
        + '<a href="kostenanalyse.html">Kostenanalyse</a> (z.B. „Sparplan ETF", „flatex").';

    // Ohne gepflegten Anfangssaldo ist der Kontostand nicht echt – dann wäre
    // auch das Vermögen nur eine Differenz seit dem ersten Import.
    var ohneStart = state.accounts.some(function (a) {
      return (a.kind || 'bank') !== 'credit_card' && !Number(a.opening_balance);
    });
    if (ohneStart) {
      el('kAssets').textContent = '—';
      el('kAssetsSub').textContent = 'Depot ' + fmt0(d.value)
        + ' · Kontostand fehlt: Anfangssaldo im Reiter Konten eintragen';
      return;
    }
    el('kAssets').textContent = fmt0(b.bank + d.value);
    el('kAssetsSub').textContent = 'Konto ' + fmt0(b.bank) + ' · Depot ' + fmt0(d.value);
  }

  function renderStamp() {
    el('stamp').textContent = state.invoiceStamp
      ? 'Rechnungen: ' + new Date(state.invoiceStamp).toLocaleString('de-DE') + ' · ' + state.invoices.length + ' offen'
      : 'Rechnungen noch nicht geladen';
  }

  // Die Kacheln beantworten die Frage des gewaehlten Zeitraums: was kam rein,
  // was ging raus, was blieb. Ein "Kontostand heute" stand hier frueher auch –
  // ohne gepflegten Anfangssaldo ist das aber nicht der echte Kontostand,
  // deshalb steht der Saldo nur noch im Reiter Konten.
  function renderKpis() {
    var months = applyRange(C.monthlyActuals(state.txs, state.accounts));
    if (!months.length) {
      ['kIn', 'kOut', 'kFlow', 'kTrend'].forEach(function (id) { el(id).textContent = '—'; });
      el('kInSub').textContent = el('kOutSub').textContent = el('kFlowSub').textContent = '';
      el('kTrendSub').textContent = 'Noch keine Kontoumsätze importiert';
      return;
    }
    var von = monthLabel(months[0].year, months[0].month);
    var bis = monthLabel(months[months.length - 1].year, months[months.length - 1].month);
    var zeitraum = months.length === 1 ? von : von + ' – ' + bis;
    var ein = C.round2(months.reduce(function (a, m) { return a + m.inflow; }, 0));
    var aus = C.round2(months.reduce(function (a, m) { return a + m.outflow; }, 0));
    var flow = C.round2(ein - aus);

    el('kIn').textContent = fmt(ein);
    el('kInSub').textContent = zeitraum;
    el('kOut').textContent = fmt(-aus);
    el('kOutSub').textContent = zeitraum;
    el('kFlow').textContent = (flow > 0 ? '+' : '') + fmt(flow);
    el('kFlowSub').textContent = zeitraum + ' · ' + months.length + ' Monate';
    el('kFlowCard').className = 'kpi-card' + (flow >= 0 ? ' good' : ' danger');

    var minus = months.filter(function (m) { return m.delta < 0; });
    var schnitt = C.round2(flow / months.length);
    el('kTrend').textContent = minus.length + ' von ' + months.length;
    el('kTrendSub').textContent = 'Schnitt ' + (schnitt >= 0 ? '+' : '') + fmt(schnitt) + ' pro Monat'
      + (minus.length ? ' · zuletzt ' + monthLabel(minus[minus.length - 1].year, minus[minus.length - 1].month) : '');
    el('kTrendCard').className = 'kpi-card' + (schnitt >= 0 ? ' good' : ' warn');
  }

  var COLS = [
    ['clientPayments', 'in'], ['adSpendRefunds', 'in'], ['otherIn', 'in'],
    ['salaries', 'out'], ['suppliers', 'out'], ['adSpendAmazon', 'out'], ['taxes', 'out'], ['otherOut', 'out'],
    ['savings', 'out'],
  ];
  var BUCKET_LABELS = {
    clientPayments: 'Kundenzahlungen', adSpendRefunds: 'Ad-Spend-Erstattung', otherIn: 'Sonstiger Eingang',
    salaries: 'Gehälter', suppliers: 'Lieferanten', adSpendAmazon: 'Ad-Spend an Amazon',
    taxes: 'Steuern', otherOut: 'Sonstige Ausgabe', savings: 'Geldanlage',
  };

  function cell(v) {
    if (!v) return '<td class="num zero">–</td>';
    return '<td class="num ' + (v > 0 ? 'in' : 'out') + '">' + fmt(v) + '</td>';
  }

  function renderForecast(weeks) {
    var b = balances();
    el('forecastGrain').value = grain();
    el('forecastTitle').textContent = grain() === 'week' ? '13-Wochen-Vorschau' : '6-Monats-Vorschau';
    el('forecastPeriodHead').textContent = grain() === 'week' ? 'Woche' : 'Monat';
    var aktiv = state.fixedCosts.filter(function (f) { return f.active !== false && Number(f.amount) > 0; });
    // Der Hinweis zaehlt nur die LAUFENDEN Kosten: eine einzelne Geldanlage-Zeile
    // ersetzt keine Gehaelter/Miete – sonst verschwindet die Warnung zu frueh.
    var laufend = aktiv.filter(function (f) { return f.bucket !== 'savings'; });
    var leer = state.fixedCosts.filter(function (f) { return f.active !== false && !Number(f.amount); });
    el('planEmpty').classList.toggle('hidden', laufend.length > 0 && !leer.length);
    el('forecastSub').textContent = 'Start: ' + fmt(b.bank) + ' · '
      + state.invoices.length + ' offene Rechnungen · '
      + aktiv.length + ' aktive Fixkosten';

    var rows = weeks.map(function (w) {
      var cls = w.endBalance < 0 ? ' neg' : '';
      var periodLabel = w.label || (fmtDate(w.from) + ' – ' + fmtDateShort(w.to));
      var main = '<tr class="week-row' + cls + '" data-week="' + w.index + '">' +
        '<td>' + esc(periodLabel) + '</td>' +
        '<td class="num">' + fmt(w.startBalance) + '</td>' +
        COLS.map(function (c) { return cell(w[c[0]]); }).join('') +
        '<td class="num end">' + fmt(w.endBalance) + '</td></tr>';
      if (!openWeeks[w.index]) return main;
      var items = w.items.length
        ? w.items.map(function (i) {
            return '<div class="detail-line"><span class="lbl">' + fmtDate(i.date) + ' · ' +
              esc(BUCKET_LABELS[i.bucket] || i.bucket) + ' · ' + esc(i.label) + '</span>' +
              '<span class="' + (i.amount > 0 ? 'in' : 'out') + '">' + fmt(i.amount) + '</span></div>';
          }).join('')
        : '<div class="detail-line"><span class="lbl">Keine geplanten Zahlungen in dieser Woche.</span></div>';
      return main + '<tr class="detail-row"><td colspan="12"><div class="detail-inner">' + items + '</div></td></tr>';
    }).join('');
    el('forecastBody').innerHTML = rows;

    Array.prototype.forEach.call(document.querySelectorAll('#forecastBody tr.week-row'), function (tr) {
      tr.addEventListener('click', function () {
        var i = tr.getAttribute('data-week');
        openWeeks[i] = !openWeeks[i];
        renderForecast(weeks);
      });
    });

    var neg = weeks.filter(function (w) { return w.endBalance < 0; });
    var cardOpen = balances().cardOpen;
    var notes = [];
    if (neg.length) notes.push('⚠️ ' + neg.length + ' ' + (grain() === 'week' ? 'Woche(n)' : 'Monat(e)')
      + ' mit negativem Endsaldo – erste(r) am ' + fmtDate(neg[0].from) + '.');
    if (cardOpen && cardOpen.amount < 0) notes.push('Offene Kartenumsätze ' + fmt(Math.abs(cardOpen.amount)) + ' sind als Sammelabbuchung am ' + fmtDate(nextSettlementDate()) + ' eingeplant (Zeile „Sonstige Ausgaben").');
    if (!state.invoices.length) notes.push('Noch keine Rechnungen aus LexOffice geladen – die Eingangsseite der Vorschau ist dadurch leer.');
    var spar = weeks.reduce(function (s, w) { return s + (w.savings || 0); }, 0);
    if (spar) notes.push('Geldanlage ' + fmt(Math.abs(spar)) + ' im Vorschauzeitraum: Umbuchung aufs eigene Depot. '
      + 'Das Geld ist vom Konto weg (deshalb in der Vorschau), aber kein Aufwand – es liegt im Depot.');
    notes.push('Kundenzahlungen stehen brutto (inkl. USt) – so kommen sie aufs Konto. Die Seite „Offene Rechnungen" zeigt dieselben Rechnungen netto; im Wochendetail steht der Netto-Betrag dahinter.');
    el('forecastNote').innerHTML = notes.map(esc).join('<br>');

    drawForecastChart(weeks);
  }

  function drawForecastChart(weeks) {
    lastData.forecast = weeks;
    if (typeof Chart === 'undefined') return;      // Chart.js nicht geladen → Tabelle reicht
    var ctx = resetCanvas('forecastChart');
    var labels = weeks.map(function (w) {
      return w.label ? w.label.replace(' (ab heute)', '').replace(/ \d{4}$/, '') : fmtDateShort(w.from);
    });
    var data = weeks.map(function (w) { return C.round2(w.endBalance); });
    var cfg = {
      type: 'line',
      data: { labels: labels, datasets: [{
        label: 'Endsaldo', data: data, borderColor: '#4f46e5', borderWidth: 2,
        pointBackgroundColor: data.map(function (v) { return v < 0 ? '#dc2626' : '#4f46e5'; }),
        pointRadius: 3, tension: .25, fill: true,
        backgroundColor: 'rgba(79,70,229,.08)',
      }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (c) { return 'Endsaldo: ' + fmt(c.parsed.y); } } },
        },
        scales: {
          y: { ticks: { callback: function (v) { return fmt0(v); } }, grid: { color: function (c) { return c.tick.value === 0 ? '#ef4444' : 'rgba(0,0,0,.06)'; } } },
          x: { grid: { display: false } },
        },
      },
    };
    if (charts.forecast) charts.forecast.destroy();
    charts.forecast = new Chart(ctx, cfg);
  }

  function renderActuals() {
    var alle = C.monthlyActuals(state.txs, state.accounts);
    var chrono = applyRange(alle);
    if (!chrono.length) chrono = alle;
    var months = chrono.slice().reverse();
    var cats = C.monthlyCategories(state.txs);
    if (!months.length) {
      el('actualsBody').innerHTML = '<tr><td colspan="5" class="muted">Noch keine Kontoumsätze importiert – im Reiter „Import" CSV-Dateien hochladen.</td></tr>';
      el('verlaufSub').textContent = 'Noch keine Kontoumsätze importiert.';
      return;
    }
    renderRangeControls(alle);
    var von = monthLabel(chrono[0].year, chrono[0].month);
    var bis = monthLabel(chrono[chrono.length - 1].year, chrono[chrono.length - 1].month);
    el('verlaufSub').innerHTML = esc(von + ' bis ' + bis) + ' · ' + chrono.length + ' Monate'
      + (chrono.length < alle.length ? ' <span class="muted">(gefilterter Zeitraum)</span>' : '');
    el('actualsSub').textContent = chrono.length + ' Monate im gewählten Zeitraum · '
      + state.txs.length + ' importierte Buchungen insgesamt';
    drawVerlaufChart(chrono);

    // Anfangssaldo-Hinweis: ohne ihn ist die Kurve nur um einen festen Betrag verschoben.
    var ohneStart = state.accounts.some(function (a) {
      return (a.kind || 'bank') !== 'credit_card' && !Number(a.opening_balance);
    });
    var hint = el('saldoHint');
    hint.innerHTML = 'Grün = im Monat kam mehr rein als raus, Rot = mehr abgeflossen. '
      + 'Die Balken zeigen die Differenz; Eingänge und Ausgänge einzeln stehen in der Tabelle darunter.'
      + (ohneStart ? ' Die Spalte „Endsaldo" rechnet ab der ersten importierten Buchung bei 0 € los – '
          + 'für den echten Kontostand den Anfangssaldo im Reiter <strong>Konten</strong> eintragen.' : '');

    el('actualsBody').innerHTML = months.map(function (m) {
      var row = '<tr class="month-row" data-month="' + m.key + '">' +
        '<td>' + monthLabel(m.year, m.month) + '</td>' +
        '<td class="num in">' + fmt(m.inflow) + '</td>' +
        '<td class="num out">' + fmt(-m.outflow) + '</td>' +
        '<td class="num ' + (m.delta >= 0 ? 'in' : 'out') + '">' + fmt(m.delta) + '</td>' +
        '<td class="num end">' + fmt(m.endBalance) + '</td></tr>';
      if (!openMonths[m.key]) return row;
      var c = cats[m.key] || {};
      var keys = Object.keys(c).sort(function (a, b) { return c[b] - c[a]; });
      var inner = keys.length
        ? keys.map(function (k) {
            return '<div class="detail-line"><span class="lbl">' + esc(k) + '</span><span class="out">' + fmt(-c[k]) + '</span></div>';
          }).join('')
        : '<div class="detail-line"><span class="lbl">Keine Ausgaben in diesem Monat.</span></div>';
      return row + '<tr class="detail-row"><td colspan="5"><div class="detail-inner">' + inner + '</div></td></tr>';
    }).join('');

    Array.prototype.forEach.call(document.querySelectorAll('#actualsBody tr.month-row'), function (tr) {
      tr.addEventListener('click', function () {
        var k = tr.getAttribute('data-month');
        openMonths[k] = !openMonths[k];
        renderActuals();
      });
    });
  }

  // Chart.js schreibt die berechnete Größe als Inline-Style auf die Canvas.
  // Entsteht ein Chart, während sein Reiter ausgeblendet ist, steht dort
  // width:0px – und bleibt dort, weil die Canvas dann nie wieder wächst.
  // Vor jedem Neuaufbau deshalb die Größenangaben entfernen.
  function resetCanvas(id) {
    var cv = el(id);
    cv.removeAttribute('style');
    cv.removeAttribute('width');
    cv.removeAttribute('height');
    return cv.getContext('2d');
  }

  // ── Zeitraum ──────────────────────────────────────────────────────────────
  function loadRange() {
    if (range) return range;
    try { range = JSON.parse(localStorage.getItem(RANGE_KEY) || 'null'); } catch (e) { range = null; }
    return range;
  }
  function saveRange(r) {
    range = r;
    try { r ? localStorage.setItem(RANGE_KEY, JSON.stringify(r)) : localStorage.removeItem(RANGE_KEY); } catch (e) {}
  }
  function applyRange(chrono) {
    var r = loadRange();
    if (!r || !chrono.length) return chrono;
    return chrono.filter(function (m) { return m.key >= r.from && m.key <= r.to; });
  }
  // Schnellauswahl: Anzahl Monate ab dem letzten vorhandenen Monat zurück.
  function setRangeMonths(n, chrono) {
    if (!chrono.length) return;
    if (n === 'all') { saveRange(null); return; }
    var letzter = chrono[chrono.length - 1];
    if (n === 'ytd') { saveRange({ from: letzter.year + '-01', to: letzter.key }); return; }
    var idx = Math.max(0, chrono.length - n);
    saveRange({ from: chrono[idx].key, to: letzter.key });
  }
  function renderRangeControls(chrono) {
    var r = loadRange();
    var opts = function (sel) {
      return chrono.map(function (m) {
        return '<option value="' + m.key + '"' + (m.key === sel ? ' selected' : '') + '>'
          + monthLabel(m.year, m.month) + '</option>';
      }).join('');
    };
    var von = r ? r.from : chrono[0].key;
    var bis = r ? r.to : chrono[chrono.length - 1].key;
    el('rangeFrom').innerHTML = opts(von);
    el('rangeTo').innerHTML = opts(bis);
  }

  function drawVerlaufChart(chrono) {
    lastData.verlauf = chrono;
    if (typeof Chart === 'undefined') return;
    var ctx = resetCanvas('verlaufChart');
    var labels = chrono.map(function (m) { return MONTHS[m.month - 1].slice(0, 3) + ' ' + String(m.year).slice(2); });
    // Bewusst KEIN kumulierter Kontostand: der haengt am Anfangssaldo und
    // startet sonst willkuerlich bei 0. Die Frage ist "kam mehr rein als raus".
    var werte = chrono.map(function (m) { return C.round2(m.delta); });
    var cfg = {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Veränderung',
          data: werte,
          backgroundColor: werte.map(function (v) { return v >= 0 ? 'rgba(16,185,129,.75)' : 'rgba(239,68,68,.75)'; }),
          borderRadius: 4,
          // Ein Monat mit -480 € neben Balken von 100.000 € waere sonst
          // unsichtbar und saehe aus, als fehlten die Daten.
          minBarLength: 3,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (c) {
            var m = chrono[c.dataIndex];
            return [(c.parsed.y >= 0 ? 'Plus: ' : 'Minus: ') + fmt(c.parsed.y),
                    'Eingänge: ' + fmt(m.inflow), 'Ausgänge: ' + fmt(-m.outflow)];
          } } },
        },
        scales: {
          y: { ticks: { callback: function (v) { return fmt0(v); } },
               grid: { color: function (c) { return c.tick.value === 0 ? '#475569' : 'rgba(0,0,0,.06)'; },
                       lineWidth: function (c) { return c.tick.value === 0 ? 1.5 : 1; } } },
          x: { grid: { display: false } },
        },
      },
    };
    cfg.plugins = [balkenBeschriftung];
    if (charts.verlauf) charts.verlauf.destroy();
    charts.verlauf = new Chart(ctx, cfg);
  }

  // Schreibt den Betrag an jeden Balken – sonst sind kleine Monate nicht ablesbar.
  var balkenBeschriftung = {
    id: 'balkenBeschriftung',
    afterDatasetsDraw: function (chart) {
      var ctx = chart.ctx;
      var meta = chart.getDatasetMeta(0);
      var daten = chart.data.datasets[0].data;
      ctx.save();
      ctx.font = '600 10px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      meta.data.forEach(function (bar, i) {
        var v = daten[i];
        if (v == null) return;
        var oben = v >= 0;
        ctx.fillStyle = oben ? '#047857' : '#b91c1c';
        ctx.textBaseline = oben ? 'bottom' : 'top';
        ctx.fillText(kurzBetrag(v), bar.x, oben ? bar.y - 3 : bar.y + 3);
      });
      ctx.restore();
    },
  };

  // 102.171 € → "+102,2k", -480 € → "-480"
  function kurzBetrag(v) {
    var vz = v > 0 ? '+' : v < 0 ? '−' : '';
    var a = Math.abs(v);
    if (a >= 1000) return vz + (a / 1000).toFixed(1).replace('.', ',') + 'k';
    return vz + Math.round(a);
  }

  // ── Import ────────────────────────────────────────────────────────────────
  function renderImports() {
    el('cImports').textContent = state.imports.length;
    var rows = state.imports.map(function (im) {
      return '<tr><td>' + esc(im.period_label || '–') + '</td><td>' + esc(im.source) + '</td>' +
        '<td>' + esc(im.filename || '') + '</td>' +
        '<td class="num">' + im.row_count + '</td>' +
        '<td class="num muted">' + im.skipped_count + '</td>' +
        '<td>' + new Date(im.created_at).toLocaleDateString('de-DE') + '</td>' +
        '<td><button class="btn btn-ghost btn-sm" data-del-import="' + im.id + '">löschen</button></td></tr>';
    }).join('');
    el('importsTable').innerHTML =
      '<thead><tr><th>Zeitraum</th><th>Quelle</th><th>Datei</th><th>Neu</th><th>Übersprungen</th><th>Importiert am</th><th></th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="7" class="muted">Noch nichts importiert.</td></tr>') + '</tbody>';
    Array.prototype.forEach.call(document.querySelectorAll('[data-del-import]'), function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Diesen Import samt zugehörigen Buchungen löschen?')) return;
        window.db.cashflow.imports.delete(b.dataset.delImport).then(reload).catch(function (e) { alert(e.message); });
      });
    });
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    var override = el('importSource').value;
    var signMode = el('amexSign').value;
    var preview = el('importPreview');
    preview.innerHTML = '<div class="muted">Verarbeite …</div>';

    var accBySource = {};
    state.accounts.forEach(function (a) { accBySource[a.source] = a.id; });

    var summaries = [];
    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        return readFile(file).then(function (text) {
          var source = override === 'auto' ? C.detectSource(text) : override;
          if (!source) { summaries.push('⚠️ ' + esc(file.name) + ': Format nicht erkannt – Quelle oben manuell wählen.'); return; }
          var parsed = C.parseCsv(text, source, signMode);
          if (!parsed.length) { summaries.push('⚠️ ' + esc(file.name) + ': keine Buchungen gefunden.'); return; }
          var enriched = C.assignDedupKeys(C.enrichAll(parsed, enrichOpts()));
          var dates = enriched.map(function (t) { return t.tx_date; }).sort();
          var from = dates[0], to = dates[dates.length - 1];
          var period = fmtDate(from) + ' – ' + fmtDate(to);
          var fileHash = hashStr(text);
          var rows = enriched.map(function (t) {
            return {
              tx_date: t.tx_date, value_date: t.value_date || t.tx_date, year: t.year, month: t.month,
              source: t.source, account_id: accBySource[t.source] || null,
              booking_text: t.booking_text, purpose: t.purpose, payee: t.payee, description: t.description,
              amount: t.amount, category: t.category, flow_type: t.flow_type,
              is_card_settlement: t.is_card_settlement, dedup_key: t.dedup_key,
            };
          });
          return window.db.cashflow.imports.findByHash(fileHash).then(function (dupes) {
            var warn = (dupes && dupes.length) ? ' (Datei war schon einmal importiert)' : '';
            return window.db.cashflow.imports.create(source, file.name, fileHash, from, to, period).then(function (imp) {
              rows.forEach(function (r) { r.import_id = imp.id; });
              return window.db.cashflow.transactions.insertMany(rows).then(function (inserted) {
                var ins = (inserted || []).length, skip = rows.length - ins;
                return window.db.cashflow.imports.update(imp.id, { row_count: ins, skipped_count: skip }).then(function () {
                  summaries.push('✅ ' + esc(file.name) + ' (' + source + '): ' + rows.length + ' Zeilen gelesen, ' +
                    ins + ' neu, ' + skip + ' übersprungen · Zeitraum ' + period + warn);
                });
              });
            });
          });
        });
      });
    });

    chain.then(reload).then(function () {
      preview.innerHTML = '<div class="alert alert-success">' + summaries.join('<br>') + '</div>';
      el('csvFile').value = '';
      // Solange kein Fixkosten-Betrag gepflegt ist, direkt aus den frisch
      // importierten Buchungen vorschlagen – ohne Abtippen.
      var leer = !state.fixedCosts.some(function (f) { return Number(f.amount) > 0; });
      if (leer && bankMonthCount() >= 3) {
        return loadFcSuggestions().then(function () { showTab('fixed'); });
      }
    }).catch(function (e) {
      preview.innerHTML = '<div class="alert alert-danger">Fehler: ' + esc(e.message) + '</div>';
    });
  }

  // Kategorien/Flow-Typen mit dem aktuellen Regelstand neu setzen.
  function reapplyRules() {
    var rows = state.txs.map(function (t) {
      var e = C.enrich(t, enrichOpts());
      return { id: t.id, category: e.category, flow_type: e.flow_type, is_card_settlement: e.is_card_settlement };
    }).filter(function (r, i) {
      var t = state.txs[i];
      return r.category !== t.category || r.flow_type !== t.flow_type || r.is_card_settlement !== t.is_card_settlement;
    });
    if (!rows.length) return Promise.resolve(0);
    var chunks = [];
    for (var i = 0; i < rows.length; i += 200) chunks.push(rows.slice(i, i + 200));
    return chunks.reduce(function (p, c) {
      return p.then(function () {
        return Promise.all(c.map(function (r) {
          return window.db.cashflow.transactions.update(r.id, {
            category: r.category, flow_type: r.flow_type, is_card_settlement: r.is_card_settlement,
          });
        }));
      });
    }, Promise.resolve()).then(function () { return rows.length; });
  }

  // ── Fixkosten ─────────────────────────────────────────────────────────────
  var RHYTHM_LABEL = { monthly: 'monatlich', quarterly: 'quartalsweise', yearly: 'jährlich' };
  var BUCKET_OPTIONS = [
    ['salary', 'Gehälter'], ['supplier', 'Lieferanten'], ['adspend_amazon', 'Ad-Spend an Amazon'],
    ['tax', 'Steuern'], ['other_out', 'Sonstige Ausgaben'], ['card_settlement', 'Kartenabrechnung'],
    ['savings', 'Geldanlage (Sparplan)'],
  ];

  function renderFixed() {
    el('cFixed').textContent = state.fixedCosts.filter(function (f) { return f.active !== false; }).length;
    var rows = state.fixedCosts.map(function (f) {
      return '<tr>' +
        '<td><input class="inp" style="width:200px" data-fc="' + f.id + '" data-field="label" value="' + esc(f.label) + '"></td>' +
        '<td class="num"><input class="inp sm" data-fc="' + f.id + '" data-field="amount" value="' + String(Number(f.amount).toFixed(2)).replace('.', ',') + '"></td>' +
        '<td class="num"><input class="inp sm" type="number" min="1" max="31" data-fc="' + f.id + '" data-field="pay_day" value="' + f.pay_day + '"></td>' +
        '<td><select class="inp" data-fc="' + f.id + '" data-field="rhythm">' +
          Object.keys(RHYTHM_LABEL).map(function (k) { return '<option value="' + k + '"' + (f.rhythm === k ? ' selected' : '') + '>' + RHYTHM_LABEL[k] + '</option>'; }).join('') +
        '</select></td>' +
        '<td><select class="inp" data-fc="' + f.id + '" data-field="start_month">' +
          '<option value="">–</option>' +
          MONTHS.map(function (m, i) { return '<option value="' + (i + 1) + '"' + (Number(f.start_month) === i + 1 ? ' selected' : '') + '>' + m + '</option>'; }).join('') +
        '</select></td>' +
        '<td><select class="inp" data-fc="' + f.id + '" data-field="bucket">' +
          BUCKET_OPTIONS.map(function (b) { return '<option value="' + b[0] + '"' + (f.bucket === b[0] ? ' selected' : '') + '>' + b[1] + '</option>'; }).join('') +
        '</select></td>' +
        '<td><input type="checkbox" data-fc="' + f.id + '" data-field="active"' + (f.active !== false ? ' checked' : '') + '></td>' +
        '<td><button class="btn btn-ghost btn-sm" data-del-fc="' + f.id + '">löschen</button></td></tr>';
    }).join('');
    el('fixedTable').innerHTML =
      '<thead><tr><th>Bezeichnung</th><th>Betrag</th><th>Zahltag</th><th>Rhythmus</th><th>Startmonat</th><th>Vorschau-Zeile</th><th>Aktiv</th><th></th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="8" class="muted">Noch keine Fixkosten erfasst.</td></tr>') + '</tbody>';

    Array.prototype.forEach.call(document.querySelectorAll('[data-fc]'), function (inp) {
      inp.addEventListener('change', function () {
        var id = inp.dataset.fc, field = inp.dataset.field, val;
        if (field === 'active') val = inp.checked;
        else if (field === 'amount') val = num(inp.value);
        else if (field === 'pay_day') val = Math.max(1, Math.min(31, parseInt(inp.value, 10) || 1));
        else if (field === 'start_month') val = inp.value ? parseInt(inp.value, 10) : null;
        else val = inp.value;
        var patch = {}; patch[field] = val;
        window.db.cashflow.fixedCosts.update(id, patch).then(reload).catch(function (e) { alert(e.message); });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-del-fc]'), function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Diese Fixkosten-Zeile löschen?')) return;
        window.db.cashflow.fixedCosts.delete(b.dataset.delFc).then(reload).catch(function (e) { alert(e.message); });
      });
    });
  }

  // ── Steuern ───────────────────────────────────────────────────────────────
  function renderTaxes() {
    var cfg = ustCfg();
    el('ustExt').value = cfg.extension ? '1' : '0';
    el('ustAuto').value = cfg.auto ? '1' : '0';
    el('ustMode').value = cfg.mode;
    el('ustRate').value = String(Math.round(cfg.rate * 1000) / 10).replace('.', ',');
    renderUstHistory(cfg);

    var span = forecastSpan();
    var auto = autoUstvaRows(span.from, span.to);
    if (!cfg.auto) {
      el('ustNote').innerHTML = 'Automatische Schätzung ist aus – nur manuell erfasste Termine zählen.';
    } else if (cfg.mode === 'effective') {
      el('ustNote').innerHTML = 'Schätzung = Netto-Umsatz des Zeitraums × <strong>'
        + esc(String(Math.round(cfg.rate * 1000) / 10).replace('.', ',')) + ' %</strong> – abgeleitet aus '
        + cfg.samples.length + ' tatsächlichen Finanzamt-Zahlungen'
        + (cfg.derivedAt ? ' (Stand ' + fmtDate(cfg.derivedAt.slice(0, 10)) + ')' : '')
        + '. Die Vorsteuer steckt in diesem Satz bereits drin und wird nicht noch einmal abgezogen.';
    } else {
      el('ustNote').innerHTML = 'Schätzung = Netto-Umsatz × Satz − Vorsteuer aus den importierten Buchungen. '
        + '<strong>Achtung:</strong> mit 19 % überschätzt das die Zahlung, sobald ein Teil des Umsatzes Reverse-Charge ist '
        + '(EU/UK ohne deutsche USt). Über „Satz aus Zahlungen ableiten" wird der Erfahrungswert aus deinen echten '
        + 'Finanzamt-Lastschriften berechnet.';
    }

    var manualUst = state.taxDates.filter(function (t) { return t.kind === 'ustva'; });
    var rows = auto.map(function (a) {
      var hint = a.netRevenue ? '' : ' <span class="muted">(Umsatz für diesen Monat noch nicht erfasst)</span>';
      return '<tr><td>' + esc(a.label) + hint + '</td><td>' + fmtDate(a.due_date) + '</td>' +
        '<td class="num">' + fmt(a.netRevenue) + '</td>' +
        '<td class="num' + (a.inputVat ? '' : ' muted') + '">' +
          (cfg.mode === 'effective' ? '<span class="muted">im Satz enthalten</span>' : fmt(a.inputVat)) + '</td>' +
        '<td class="num out">' + fmt(-a.amount) + '</td>' +
        '<td><button class="btn btn-ghost btn-sm" data-fix-ust="' + a.due_date + '" data-amount="' + a.amount + '" data-label="' + esc(a.label.replace(' (geschätzt)', '')) + '">Betrag festschreiben</button></td></tr>';
    }).join('') + manualUst.map(function (t) {
      return '<tr><td>' + esc(t.label) + ' <span class="pill pill-out">fest</span></td><td>' + fmtDate(t.due_date) + '</td>' +
        '<td class="num muted">–</td><td class="num muted">–</td>' +
        '<td class="num out"><input class="inp sm" data-tx="' + t.id + '" data-field="amount" value="' + String(Number(t.amount).toFixed(2)).replace('.', ',') + '"></td>' +
        '<td><button class="btn btn-ghost btn-sm" data-del-tx="' + t.id + '">löschen</button></td></tr>';
    }).join('');
    el('ustTable').innerHTML =
      '<thead><tr><th>Zeitraum</th><th>Zahltag</th><th>Netto-Umsatz</th><th>Vorsteuer</th><th>Zahlung</th><th></th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="6" class="muted">Keine UStVA-Termine im Vorschau-Zeitraum.</td></tr>') + '</tbody>';

    var other = state.taxDates.filter(function (t) { return t.kind !== 'ustva'; });
    var KIND = { kst: 'Körperschaftsteuer', gewst: 'Gewerbesteuer', other: 'Sonstige Steuer' };
    el('taxTable').innerHTML =
      '<thead><tr><th>Art</th><th>Bezeichnung</th><th>Fällig am</th><th>Betrag</th><th></th></tr></thead><tbody>' +
      (other.map(function (t) {
        return '<tr><td>' + esc(KIND[t.kind] || t.kind) + '</td><td>' + esc(t.label) + '</td>' +
          '<td><input class="inp md" type="date" data-tx="' + t.id + '" data-field="due_date" value="' + esc(t.due_date) + '"></td>' +
          '<td class="num"><input class="inp sm" data-tx="' + t.id + '" data-field="amount" value="' + String(Number(t.amount).toFixed(2)).replace('.', ',') + '"></td>' +
          '<td><button class="btn btn-ghost btn-sm" data-del-tx="' + t.id + '">löschen</button></td></tr>';
      }).join('') || '<tr><td colspan="5" class="muted">Noch keine Termine erfasst.</td></tr>') + '</tbody>';

    el('cTaxes').textContent = state.taxDates.length + auto.length;

    Array.prototype.forEach.call(document.querySelectorAll('[data-fix-ust]'), function (b) {
      b.addEventListener('click', function () {
        window.db.cashflow.taxDates.create({
          kind: 'ustva', label: b.dataset.label, due_date: b.dataset.fixUst,
          amount: Number(b.dataset.amount) || 0, auto_estimate: false,
        }).then(reload).catch(function (e) { alert(e.message); });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-tx]'), function (inp) {
      inp.addEventListener('change', function () {
        var patch = {};
        patch[inp.dataset.field] = inp.dataset.field === 'amount' ? num(inp.value) : inp.value;
        window.db.cashflow.taxDates.update(inp.dataset.tx, patch).then(reload).catch(function (e) { alert(e.message); });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-del-tx]'), function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Diesen Steuertermin löschen?')) return;
        window.db.cashflow.taxDates.delete(b.dataset.delTx).then(reload).catch(function (e) { alert(e.message); });
      });
    });
  }

  // Tatsächlich gezahlte Umsatzsteuer als Referenz neben der Schätzung.
  function renderUstHistory(cfg) {
    var t = el('ustHistoryTable');
    if (!cfg.samples.length) {
      t.innerHTML = '<thead><tr><th>Zahlungshistorie</th></tr></thead><tbody><tr><td class="muted">'
        + 'Noch nicht abgeleitet – Button „Satz aus Zahlungen ableiten" nutzt die Finanzamt-Lastschriften aus der Kostenanalyse.'
        + '</td></tr></tbody>';
      return;
    }
    var rows = cfg.samples.slice(-12).map(function (x) {
      return '<tr><td>' + esc(x.period) + '</td>' +
        '<td class="num out">' + fmt(-x.vat) + '</td>' +
        '<td class="num">' + fmt(x.revenue) + '</td>' +
        '<td class="num">' + (x.rate * 100).toFixed(1).replace('.', ',') + ' %</td></tr>';
    }).join('');
    t.innerHTML = '<thead><tr><th>Voranmeldungszeitraum</th><th>Tatsächlich gezahlt</th><th>Netto-Umsatz</th><th>Satz</th></tr></thead>'
      + '<tbody>' + rows + '</tbody>';
  }

  function deriveVatRate() {
    var btn = el('ustDerive');
    btn.disabled = true; btn.textContent = 'Rechnet…';
    return ensureCostTxs().then(function (txs) {
      var res = C.effectiveVatRate(txs, revenueByPeriod());
      if (res.rate == null) {
        alert('Keine Finanzamt-Zahlungen mit passendem Umsatzmonat gefunden – Satz bleibt unverändert.');
        return null;
      }
      return window.db.cashflow.settings.set('ustva', {
        extension: ustCfg().extension, auto: ustCfg().auto,
        mode: 'effective', rate: C.round2(res.rate * 10000) / 10000,
        samples: res.samples, derivedAt: new Date().toISOString(),
      });
    }).then(function () {
      btn.disabled = false; btn.textContent = 'Satz aus Zahlungen ableiten';
      return reload();
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = 'Satz aus Zahlungen ableiten';
      alert(e.message);
    });
  }

  // ── Fixkosten-Vorschlag aus der Kostenanalyse ─────────────────────────────
  function renderFcSuggestions() {
    var existing = {};
    state.fixedCosts.forEach(function (f) { existing[E.norm(f.label)] = 1; });
    var fresh = state.fcSuggestions.filter(function (x) { return !existing[E.norm(x.label)]; });
    var known = state.fcSuggestions.length - fresh.length;

    el('fcSuggestNote').innerHTML = 'Aus ' + (state.fcSource === 'bank' ? 'deinen importierten Kontoumsätzen' : 'den Buchungen der Kostenanalyse')
      + ': <strong>' + fresh.length + '</strong> wiederkehrende '
      + 'Zahlungen der letzten 6 Monate' + (known ? ' (' + known + ' stehen schon im Plan)' : '') + '. '
      + 'Betrag und Zahltag sind der <strong>Median</strong> der Monate, nicht der letzte Wert – Ausreißer verzerren so nichts. '
      + 'Steuern fehlen bewusst: die laufen über den Reiter Steuertermine, sonst zählt die Umsatzsteuer doppelt.';

    if (!fresh.length) {
      el('fcSuggestTable').innerHTML = '<tbody><tr><td class="muted">Nichts Neues gefunden.</td></tr></tbody>';
      return;
    }
    el('fcSuggestTable').innerHTML =
      '<thead><tr><th><input type="checkbox" id="fcSuggestAll" checked></th><th>Bezeichnung</th><th>Kategorie</th>'
      + '<th>Betrag (Median)</th><th>Zahltag</th><th>Zeile</th><th>Monate</th><th>Streuung</th></tr></thead><tbody>' +
      fresh.map(function (x, i) {
        var unsicher = x.spread >= 3;
        return '<tr' + (unsicher ? ' title="Betrag schwankt stark – bitte prüfen"' : '') + '>' +
          '<td><input type="checkbox" class="fc-sug" data-i="' + i + '"' + (unsicher ? '' : ' checked') + '></td>' +
          '<td>' + esc(x.label) + '</td>' +
          '<td class="muted">' + esc(x.category || '—') + '</td>' +
          '<td class="num">' + fmt(x.amount) + '</td>' +
          '<td class="num">' + x.pay_day + '.</td>' +
          '<td>' + esc((BUCKET_OPTIONS.filter(function (b) { return b[0] === x.bucket; })[0] || ['', x.bucket])[1]) + '</td>' +
          '<td class="num">' + x.monthsSeen + '/' + x.monthsChecked + '</td>' +
          '<td class="num' + (unsicher ? ' out' : ' muted') + '">' + x.spread.toFixed(1).replace('.', ',') + '×</td></tr>';
      }).join('') + '</tbody>';
    state.fcFresh = fresh;

    el('fcSuggestAll').addEventListener('change', function (e) {
      Array.prototype.forEach.call(document.querySelectorAll('.fc-sug'), function (cb) { cb.checked = e.target.checked; });
    });
  }

  // Quelle für den Vorschlag: die eigenen Kontoumsätze, sobald genug Monate
  // importiert sind – sonst die Buchungshistorie der Kostenanalyse.
  function suggestionSource() {
    if (bankMonthCount() >= 3) return Promise.resolve({ rows: bankAsCostRows(), from: 'bank' });
    return ensureCostTxs().then(function (txs) { return { rows: txs, from: 'cost' }; });
  }

  function loadFcSuggestions() {
    var btn = el('fcSuggest');
    btn.disabled = true; btn.textContent = 'Lädt…';
    return suggestionSource().then(function (src) {
      state.fcSource = src.from;
      state.fcSuggestions = C.suggestFixedCosts(src.rows, { today: todayIso(), months: 6 });
      btn.disabled = false; btn.textContent = 'Aus Buchungen vorschlagen';
      el('fcSuggestPanel').classList.remove('hidden');
      renderFcSuggestions();
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = 'Aus Buchungen vorschlagen';
      alert(e.message);
    });
  }

  function applyFcSuggestions() {
    var picked = Array.prototype.filter.call(document.querySelectorAll('.fc-sug'), function (cb) { return cb.checked; })
      .map(function (cb) { return state.fcFresh[+cb.dataset.i]; });
    if (!picked.length) { alert('Nichts ausgewählt.'); return; }
    var base = state.fixedCosts.length;
    Promise.all(picked.map(function (x, i) {
      return window.db.cashflow.fixedCosts.create({
        label: x.label, amount: x.amount, pay_day: x.pay_day, rhythm: 'monthly',
        bucket: x.bucket, sort: (base + i + 1) * 10,
        note: 'aus Kostenanalyse, Median ' + x.monthsSeen + '/' + x.monthsChecked + ' Monate',
      });
    })).then(function () {
      el('fcSuggestPanel').classList.add('hidden');
      return reload();
    }).catch(function (e) { alert(e.message); });
  }

  // ── Eingangsrechnungen ────────────────────────────────────────────────────
  var AP_KIND = { supplier: 'Lieferant', adspend_amazon: 'Ad-Spend an Amazon', other_income: 'Sonstiger Eingang' };

  function renderAp() {
    var open = state.apInvoices.filter(function (a) { return !a.paid; });
    el('cAp').textContent = open.length;
    el('apSource').innerHTML = state.purchaseError
      ? 'LexOffice liefert keine Eingangsrechnungen (' + esc(state.purchaseError) + ') – bitte manuell pflegen.'
      : (state.purchases.length
        ? state.purchases.length + ' offene Eingangsrechnungen in LexOffice gefunden – über den Button übernehmen.'
        : 'Manuell gepflegt; bei geladenen Rechnungen erscheinen hier die offenen LexOffice-Eingangsrechnungen.');

    el('apTable').innerHTML =
      '<thead><tr><th>Art</th><th>Lieferant / Quelle</th><th>Fällig am</th><th>Betrag</th><th>Quelle</th><th>Bezahlt</th><th></th></tr></thead><tbody>' +
      (state.apInvoices.map(function (a) {
        var pill = a.kind === 'adspend_amazon' ? '<span class="pill pill-ad">Ad-Spend</span>'
          : a.kind === 'other_income' ? '<span class="pill pill-in">Eingang</span>'
          : '<span class="pill pill-out">Ausgang</span>';
        return '<tr' + (a.paid ? ' class="muted"' : '') + '><td>' + pill + ' ' + esc(AP_KIND[a.kind] || a.kind) + '</td>' +
          '<td><input class="inp" style="width:200px" data-ap="' + a.id + '" data-field="supplier" value="' + esc(a.supplier) + '"></td>' +
          '<td><input class="inp md" type="date" data-ap="' + a.id + '" data-field="due_date" value="' + esc(a.due_date) + '"></td>' +
          '<td class="num"><input class="inp sm" data-ap="' + a.id + '" data-field="amount" value="' + String(Number(a.amount).toFixed(2)).replace('.', ',') + '"></td>' +
          '<td class="muted">' + esc(a.source === 'lexoffice' ? 'LexOffice' : 'manuell') + '</td>' +
          '<td><input type="checkbox" data-ap="' + a.id + '" data-field="paid"' + (a.paid ? ' checked' : '') + '></td>' +
          '<td><button class="btn btn-ghost btn-sm" data-del-ap="' + a.id + '">löschen</button></td></tr>';
      }).join('') || '<tr><td colspan="7" class="muted">Noch nichts erfasst.</td></tr>') + '</tbody>';

    Array.prototype.forEach.call(document.querySelectorAll('[data-ap]'), function (inp) {
      inp.addEventListener('change', function () {
        var field = inp.dataset.field, val;
        if (field === 'paid') val = inp.checked;
        else if (field === 'amount') val = num(inp.value);
        else val = inp.value;
        var patch = {}; patch[field] = val;
        window.db.cashflow.apInvoices.update(inp.dataset.ap, patch).then(reload).catch(function (e) { alert(e.message); });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-del-ap]'), function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Diesen Eintrag löschen?')) return;
        window.db.cashflow.apInvoices.delete(b.dataset.delAp).then(reload).catch(function (e) { alert(e.message); });
      });
    });
  }

  function syncPurchases() {
    if (!state.purchases.length) {
      alert('Keine offenen Eingangsrechnungen aus LexOffice geladen. Zuerst oben „Rechnungen aus LexOffice" klicken.');
      return;
    }
    var rows = state.purchases.filter(function (p) { return p.openGross > 0; }).map(function (p) {
      return {
        kind: p.isAdSpend ? 'adspend_amazon' : 'supplier',
        supplier: p.supplier,
        amount: p.openGross,
        due_date: p.dueDate || todayIso(),
        source: 'lexoffice',
        lexoffice_id: p.id,
        note: p.number || null,
      };
    });
    if (!rows.length) { alert('Keine offenen Beträge zu übernehmen.'); return; }
    window.db.cashflow.apInvoices.upsertFromLexoffice(rows).then(function (ins) {
      alert((ins || []).length + ' Eingangsrechnung(en) übernommen, ' + (rows.length - (ins || []).length) + ' waren bereits vorhanden.');
      return reload();
    }).catch(function (e) { alert(e.message); });
  }

  // ── Konten ────────────────────────────────────────────────────────────────
  function renderAccounts() {
    var b = balances();
    var byS = {}; b.accounts.forEach(function (a) { byS[a.source] = a; });
    el('accountsTable').innerHTML =
      '<thead><tr><th>Konto</th><th>Art</th><th>Anfangssaldo</th><th>gültig ab</th><th>Abrechnungstag</th><th>Buchungen</th><th>Zeitraum</th><th>Saldo</th></tr></thead><tbody>' +
      (state.accounts.map(function (a) {
        var s = byS[a.source] || { balance: 0, count: 0, first: null, last: null };
        return '<tr><td>' + esc(a.name) + '</td>' +
          '<td>' + (a.kind === 'credit_card' ? 'Kreditkarte' : 'Bankkonto') + '</td>' +
          '<td class="num"><input class="inp sm" data-acc="' + a.id + '" data-field="opening_balance" value="' + String(Number(a.opening_balance).toFixed(2)).replace('.', ',') + '"></td>' +
          '<td><input class="inp md" type="date" data-acc="' + a.id + '" data-field="opening_date" value="' + esc(a.opening_date || '') + '"></td>' +
          '<td class="num">' + (a.kind === 'credit_card'
            ? '<input class="inp sm" type="number" min="1" max="31" data-acc="' + a.id + '" data-field="settlement_day" value="' + (a.settlement_day || '') + '">'
            : '<span class="muted">–</span>') + '</td>' +
          '<td class="num">' + s.count + '</td>' +
          '<td>' + (s.first ? fmtDate(s.first) + ' – ' + fmtDate(s.last) : '<span class="muted">–</span>') + '</td>' +
          '<td class="num end">' + fmt(s.balance) + '</td></tr>';
      }).join('')) + '</tbody>';

    Array.prototype.forEach.call(document.querySelectorAll('[data-acc]'), function (inp) {
      inp.addEventListener('change', function () {
        var field = inp.dataset.field, val;
        if (field === 'opening_balance') val = num(inp.value);
        else if (field === 'settlement_day') val = inp.value ? parseInt(inp.value, 10) : null;
        else val = inp.value || null;
        var patch = {}; patch[field] = val;
        window.db.cashflow.accounts.update(inp.dataset.acc, patch).then(reload).catch(function (e) { alert(e.message); });
      });
    });

    el('adOutPatterns').value = adSpendOut().join(', ');
    el('adInPatterns').value = adSpendIn().join(', ');
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────
  function showTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.cf-tab'), function (t) {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-panel]'), function (p) {
      p.classList.toggle('hidden', p.dataset.panel !== name);
    });
    // Jetzt ist die Canvas sichtbar und hat eine Breite – Chart (neu) zeichnen.
    if (name === 'verlauf' && lastData.verlauf) drawVerlaufChart(lastData.verlauf);
    if (name === 'forecast' && lastData.forecast) drawForecastChart(lastData.forecast);
  }

  // ── Neu laden ─────────────────────────────────────────────────────────────
  function reload() { return loadAll().then(render); }

  // ── Ereignisse ────────────────────────────────────────────────────────────
  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('.cf-tab'), function (t) {
      t.addEventListener('click', function () { showTab(t.dataset.tab); });
    });

    el('reloadInvoices').addEventListener('click', function () { fetchInvoices(); });

    Array.prototype.forEach.call(document.querySelectorAll('[data-range]'), function (b) {
      b.addEventListener('click', function () {
        var v = b.dataset.range;
        setRangeMonths(v === 'all' || v === 'ytd' ? v : parseInt(v, 10), C.monthlyActuals(state.txs, state.accounts));
        render();
      });
    });
    ['rangeFrom', 'rangeTo'].forEach(function (id) {
      el(id).addEventListener('change', function () {
        var f = el('rangeFrom').value, t = el('rangeTo').value;
        if (f > t) { if (id === 'rangeFrom') t = f; else f = t; }
        saveRange({ from: f, to: t });
        render();
      });
    });

    el('forecastGrain').addEventListener('change', function () {
      localStorage.setItem(GRAIN_KEY, el('forecastGrain').value);
      openWeeks = {};
      render();
    });

    el('planEmptyFix').addEventListener('click', function () {
      showTab('fixed');
      loadFcSuggestions();
    });

    var drop = el('drop'), input = el('csvFile');
    drop.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { handleFiles(input.files); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) { handleFiles(e.dataTransfer.files); });

    // Fixkosten anlegen
    var monthSel = el('fcStartMonth');
    monthSel.innerHTML = '<option value="">–</option>' + MONTHS.map(function (m, i) {
      return '<option value="' + (i + 1) + '">' + m + '</option>';
    }).join('');
    el('fcAdd').addEventListener('click', function () {
      var label = el('fcLabel').value.trim();
      if (!label) { alert('Bezeichnung fehlt.'); return; }
      window.db.cashflow.fixedCosts.create({
        label: label,
        amount: num(el('fcAmount').value),
        pay_day: Math.max(1, Math.min(31, parseInt(el('fcDay').value, 10) || 1)),
        rhythm: el('fcRhythm').value,
        start_month: el('fcStartMonth').value ? parseInt(el('fcStartMonth').value, 10) : null,
        bucket: el('fcBucket').value,
        sort: (state.fixedCosts.length + 1) * 10,
      }).then(function () {
        el('fcLabel').value = ''; el('fcAmount').value = '';
        return reload();
      }).catch(function (e) { alert(e.message); });
    });

    // Steuertermin anlegen
    el('txAdd').addEventListener('click', function () {
      var label = el('txLabel').value.trim(), due = el('txDue').value;
      if (!label || !due) { alert('Bezeichnung und Fälligkeit werden gebraucht.'); return; }
      window.db.cashflow.taxDates.create({
        kind: el('txKind').value, label: label, due_date: due, amount: num(el('txAmount').value),
      }).then(function () {
        el('txLabel').value = ''; el('txAmount').value = '';
        return reload();
      }).catch(function (e) { alert(e.message); });
    });

    // UStVA-Einstellungen
    function saveUst() {
      var rate = num(el('ustRate').value);
      var cur = ustCfg();
      window.db.cashflow.settings.set('ustva', {
        extension: el('ustExt').value === '1',
        auto: el('ustAuto').value === '1',
        mode: el('ustMode').value,
        rate: rate > 1 ? rate / 100 : rate,
        samples: cur.samples, derivedAt: cur.derivedAt,
      }).then(reload).catch(function (e) { alert(e.message); });
    }
    ['ustExt', 'ustAuto', 'ustRate', 'ustMode'].forEach(function (id) { el(id).addEventListener('change', saveUst); });
    el('ustDerive').addEventListener('click', deriveVatRate);

    // Fixkosten-Vorschlag
    el('fcSuggest').addEventListener('click', loadFcSuggestions);
    el('fcSuggestApply').addEventListener('click', applyFcSuggestions);
    el('fcSuggestClose').addEventListener('click', function () { el('fcSuggestPanel').classList.add('hidden'); });

    // Eingangsrechnungen
    el('apAdd').addEventListener('click', function () {
      var supplier = el('apSupplier').value.trim(), due = el('apDue').value;
      if (!supplier || !due) { alert('Lieferant und Fälligkeit werden gebraucht.'); return; }
      window.db.cashflow.apInvoices.create({
        kind: el('apKind').value, supplier: supplier,
        amount: Math.abs(num(el('apAmount').value)), due_date: due,
      }).then(function () {
        el('apSupplier').value = ''; el('apAmount').value = '';
        return reload();
      }).catch(function (e) { alert(e.message); });
    });
    el('apSync').addEventListener('click', syncPurchases);

    // Depot-Stichtagswert
    el('depotSave').addEventListener('click', function () {
      window.db.cashflow.settings.set('depot', {
        opening_value: num(el('depotOpening').value),
        opening_date: el('depotDate').value || null,
      }).then(reload).catch(function (e) { alert(e.message); });
    });

    // Ad-Spend-Muster
    el('adSave').addEventListener('click', function () {
      var split = function (v) { return v.split(',').map(function (x) { return x.trim(); }).filter(Boolean); };
      window.db.cashflow.settings.set('adspend', {
        out: split(el('adOutPatterns').value),
        in: split(el('adInPatterns').value),
      }).then(function () {
        return loadAll();          // erst den neuen Regelstand laden …
      }).then(function () {
        return reapplyRules();     // … dann damit neu einordnen
      }).then(function (n) {
        alert('Gespeichert. ' + (n || 0) + ' Buchungen neu eingeordnet.');
        return reload();
      }).catch(function (e) { alert(e.message); });
    });
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  wire();
  loadAll().then(function () {
    render();
    if (!state.invoices.length && lexKey()) fetchInvoices();
  }).catch(function (e) { showError(e.message || String(e)); });
})();
