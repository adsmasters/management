/* ===========================================================================
 * kostenanalyse.js – UI-Controller für die Kostenanalyse-Seite.
 * Nutzt window.db.cost (Supabase) und window.CostEngine (Parsing/Logik).
 * =========================================================================== */
(function () {
  'use strict';

  var E = window.CostEngine;
  var MONTHS = window.MONTHS_DE;
  var MANUAL_REASON = 'Manuell ausgeschlossen';   // Sentinel: einzeln ausgeschlossen
  var ADJUSTED_REASON = 'Angepasst';              // Sentinel: Betrag manuell angepasst (anteilig)
  var CAT_PREFIX = 'cat:';                          // Sentinel-Prefix: Kategorie manuell gesetzt
  function isManualCat(r) { return typeof r === 'string' && r.indexOf(CAT_PREFIX) === 0; }
  var lastMissing = [];                            // gerenderte Gruppen (für Aktionen)

  var state = {
    categoryRules: [], vatRules: [], excludeRules: [],
    settings: {},            // category → include_in_profit
    transactions: [],
    imports: [],
    revenueByMonth: {},      // 'YYYY-MM' → Umsatz (Lexoffice, Ausschlüsse berücksichtigt)
  };

  // ── Hilfen ─────────────────────────────────────────────────────────────────
  var eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  function fmt(n) { return eur.format(Number(n) || 0); }
  function pct(n) { return (Number(n) || 0).toFixed(1).replace('.', ',') + ' %'; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function monthLabel(y, m) { return MONTHS[m - 1] + ' ' + y; }

  function hashStr(str) {                 // djb2 – stabiler Datei-Fingerprint
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return 'h' + (h >>> 0).toString(36) + '_' + str.length;
  }
  function readFile(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () {
        var buf = r.result;
        var utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
        if (utf8.indexOf('�') !== -1) {       // ungültige UTF-8-Bytes → Datei ist Latin-1
          try { return res(new TextDecoder('iso-8859-1').decode(buf)); } catch (e) { /* fallthrough */ }
        }
        res(utf8);
      };
      r.onerror = rej;
      r.readAsArrayBuffer(file);   // Bytes lesen, Kodierung selbst bestimmen (UTF-8 oder Latin-1)
    });
  }
  function detectSource(text) {
    var head = (text || '').slice(0, 300).toLowerCase();
    if (head.indexOf('auftragskonto') !== -1 || head.indexOf('buchungstag') !== -1) return 'kreissparkasse';
    if (head.indexOf('beschreibung') !== -1 && head.indexOf('betrag') !== -1) return 'amex';
    return null;
  }
  function rulesObj() {
    return { categoryRules: state.categoryRules, vatRules: state.vatRules, excludeRules: state.excludeRules };
  }
  // Sinnvolles Regel-Pattern: Anbietername ohne angehängte Transaktions-IDs.
  // "PAYPAL *FLASCHENP. 17642964006" → "PAYPAL *FLASCHENP."
  // "PAYPAL *A24 4029357733" → "PAYPAL *A24"   (kurze Codes wie A24 bleiben)
  function suggestPattern(text) {
    var s = String(text || '').split('|')[0].trim();
    var toks = s.split(/\s+/);
    var out = [];
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      var digitCount = (t.match(/\d/g) || []).length;
      var pureDigits = /^\d+$/.test(t);
      if ((pureDigits && t.length >= 4) || digitCount >= 5) break;   // ID-Token → abschneiden
      out.push(t);
    }
    var p = out.join(' ').replace(/[\s.,;:_\-]+$/, '').trim();
    return p || s;
  }

  function isExcludedRevenue(name) {
    var kws = (localStorage.getItem('revenueExcludeKeywords') || '')
      .split('\n').map(function (k) { return k.trim().toLowerCase(); }).filter(Boolean);
    var n = (name || '').toLowerCase();
    return kws.some(function (k) { return n.indexOf(k) !== -1; });
  }

  function showError(msg) {
    el('loading').style.display = 'none';
    var e = el('error'); e.style.display = ''; e.textContent = 'Fehler: ' + msg;
  }

  // ── Laden ──────────────────────────────────────────────────────────────────
  function loadAll() {
    return Promise.all([
      window.db.cost.categoryRules.list(),
      window.db.cost.vatRules.list(),
      window.db.cost.excludeRules.list(),
      window.db.cost.categorySettings.list(),
      window.db.cost.transactions.all(),
      window.db.cost.imports.list(),
    ]).then(function (r) {
      state.categoryRules = r[0] || [];
      state.vatRules      = r[1] || [];
      state.excludeRules  = r[2] || [];
      state.settings = {};
      (r[3] || []).forEach(function (s) { state.settings[s.category] = s.include_in_profit; });
      state.transactions = r[4] || [];
      state.imports      = r[5] || [];
      return loadRevenue();
    });
  }

  // Umsatz (Lexoffice) für alle Monate mit Kostenbuchungen.
  function loadRevenue() {
    var months = {};
    state.transactions.forEach(function (t) { months[t.year + '-' + pad2(t.month)] = { y: t.year, m: t.month }; });
    var keys = Object.keys(months);
    return Promise.all(keys.map(function (k) {
      return window.db.revenue.forMonth(months[k].y, months[k].m).catch(function () { return []; });
    })).then(function (results) {
      state.revenueByMonth = {};
      keys.forEach(function (k, i) {
        var sum = 0;
        (results[i] || []).forEach(function (row) {
          if (isExcludedRevenue(row.contact_name)) return;
          sum += Number(row.total_amount) || 0;
        });
        state.revenueByMonth[k] = sum;
      });
    });
  }

  // ── Dashboards (Profit & Spend) ─────────────────────────────────────────────
  var dash = { from: null, to: null };
  var charts = {};
  var currentTab = 'profit';

  var CATEGORY_COLORS = {
    'Employee': '#2563eb', 'Freelancer/Externe': '#7c3aed', 'Marketing': '#16a34a',
    'Software': '#0891b2', 'Reisekosten': '#db2777', 'Equipment': '#ca8a04', 'Büro': '#0d9488',
    'Restaurant': '#dc2626', 'PayPal': '#64748b', 'Andere': '#94a3b8', 'Hotel': '#e11d48',
    'Steuern': '#9333ea', 'Umsatzsteuer': '#f59e0b', 'Team-Event': '#10b981',
  };
  var PALETTE = ['#2563eb', '#7c3aed', '#16a34a', '#0891b2', '#db2777', '#ca8a04', '#0d9488',
    '#dc2626', '#64748b', '#9333ea', '#f59e0b', '#e11d48', '#10b981', '#475569', '#a16207'];
  function catColor(cat, i) { return CATEGORY_COLORS[cat] || PALETTE[i % PALETTE.length]; }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function fmtShort(n) {
    var a = Math.abs(n);
    if (a >= 1000) return Math.round(n / 1000) + 'k';
    return '' + Math.round(n);
  }
  function ymOf(t) { return t.year + '-' + pad2(t.month); }
  function vendorName(t) { return suggestPattern(t.payee || t.description) || '(unbekannt)'; }

  function availableMonths() {
    var s = {};
    state.transactions.forEach(function (t) { s[ymOf(t)] = 1; });
    Object.keys(state.revenueByMonth).forEach(function (k) { s[k] = 1; });
    return Object.keys(s).sort();
  }
  function monthSeq(from, to) {     // durchgehend (Lücken inklusive)
    if (!from || !to) return [];
    var out = [], y = +from.slice(0, 4), m = +from.slice(5), ey = +to.slice(0, 4), em = +to.slice(5);
    var guard = 0;
    while ((y < ey || (y === ey && m <= em)) && guard++ < 240) { out.push(y + '-' + pad2(m)); if (++m > 12) { m = 1; y++; } }
    return out;
  }
  function ensureRange() {
    var av = availableMonths();
    if (!av.length) return [];
    if (!dash.from || dash.from < av[0]) dash.from = av[0];
    if (!dash.to || dash.to > av[av.length - 1]) dash.to = av[av.length - 1];
    if (dash.from > dash.to) dash.from = av[0];
    return monthSeq(av[0], av[av.length - 1]);
  }
  function selectedMonths() { return monthSeq(dash.from, dash.to); }

  function renderDashFilter(id) {
    if (!el(id)) return;
    var full = ensureRange();
    var opts = function (sel) {
      return full.map(function (m) { var p = m.split('-'); return '<option value="' + m + '"' + (m === sel ? ' selected' : '') + '>' + esc(monthLabel(+p[0], +p[1])) + '</option>'; }).join('');
    };
    el(id).innerHTML = '<span class="df-label">Zeitraum</span>' +
      '<select class="df-sel" data-df="from">' + opts(dash.from) + '</select>' +
      '<span class="df-arrow">→</span>' +
      '<select class="df-sel" data-df="to">' + opts(dash.to) + '</select>';
    Array.prototype.forEach.call(el(id).querySelectorAll('.df-sel'), function (s) {
      s.addEventListener('change', function () {
        dash[s.dataset.df] = s.value;
        if (dash.from > dash.to) { if (s.dataset.df === 'from') dash.to = dash.from; else dash.from = dash.to; }
        renderProfitStats(); renderSpendStats(); drawCharts(currentTab);
      });
    });
  }

  function kpiCard(label, value, cls, sub) {
    return '<div class="kpi ' + (cls || '') + '"><div class="kpi-l">' + label + '</div><div class="kpi-v">' + value +
      '</div>' + (sub ? '<div class="kpi-s">' + sub + '</div>' : '') + '</div>';
  }

  function labelTick(value) { return this.getLabelForValue(value); }   // Kategorie-Achse → echtes Label
  function valueTick(value) { return fmtShort(value); }                 // Werte-Achse → €-Kurzform
  function baseOpts(o) {
    o = o || {};
    var h = !!o.horizontal;   // horizontal: x = Werte, y = Kategorie
    return {
      responsive: true, maintainAspectRatio: false, indexAxis: h ? 'y' : 'x',
      animation: { duration: 350 },
      plugins: {
        legend: { display: o.legend !== false, position: 'bottom', labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true, font: { size: 11 } } },
        tooltip: { callbacks: { label: function (ctx) { var v = ctx.parsed[h ? 'x' : 'y']; if (v == null) v = ctx.parsed; return (ctx.dataset.label ? ctx.dataset.label + ': ' : '') + fmt(v); } } },
      },
      scales: {
        x: { stacked: !!o.stacked, grid: { display: h, color: '#eef2f7' }, ticks: { font: { size: 11 }, autoSkip: !h, maxRotation: 0, callback: h ? valueTick : labelTick } },
        y: { stacked: !!o.stacked, grid: { display: !h, color: '#eef2f7' }, ticks: { font: { size: 11 }, callback: h ? labelTick : valueTick } },
      },
    };
  }
  function chart(id, config) {
    var cv = document.getElementById(id); if (!cv || !window.Chart) return;
    if (charts[id]) charts[id].destroy();
    charts[id] = new window.Chart(cv.getContext('2d'), config);
  }
  function drawCharts(name) { if (name === 'profit') drawProfitCharts(); else if (name === 'spend') drawSpendCharts(); }

  // ── Profit ──────────────────────────────────────────────────────────────────
  function profitData() {
    var by = E.summarize(state.transactions, state.settings);
    return selectedMonths().map(function (m) {
      var p = m.split('-');
      var rev = state.revenueByMonth[m] || 0;
      var cost = (by[m] && by[m].costNet) || 0;
      return { ym: m, label: monthLabel(+p[0], +p[1]), rev: rev, cost: cost, profit: rev - cost };
    });
  }
  function renderProfitStats() {
    renderDashFilter('profitFilter');
    var d = profitData(), tRev = 0, tCost = 0;
    d.forEach(function (r) { tRev += r.rev; tCost += r.cost; });
    var tProfit = tRev - tCost;
    el('profitKpis').innerHTML =
      kpiCard('Umsatz (netto)', fmt(tRev), 'rev') +
      kpiCard('Kosten (netto)', fmt(tCost), 'cost') +
      kpiCard('Gewinn vor Steuern', fmt(tProfit), tProfit >= 0 ? 'profit-pos' : 'profit-neg') +
      kpiCard('Marge', tRev ? pct(tProfit / tRev * 100) : '—', tProfit >= 0 ? 'profit-pos' : 'profit-neg');
    var rows = d.map(function (r) {
      var gap = (r.rev === 0 && r.cost === 0);
      return '<tr' + (gap ? ' class="gap-row"' : '') + '><td>' + esc(r.label) + (gap ? ' <span class="pill">keine Daten</span>' : '') + '</td>' +
        '<td class="num revenue">' + fmt(r.rev) + '</td><td class="num cost">' + fmt(r.cost) + '</td>' +
        '<td class="num ' + (r.profit >= 0 ? 'pos' : 'neg') + '">' + fmt(r.profit) + '</td>' +
        '<td class="num ' + (r.profit >= 0 ? 'pos' : 'neg') + '">' + (r.rev ? pct(r.profit / r.rev * 100) : '—') + '</td></tr>';
    }).join('');
    el('profitTable').innerHTML = '<thead><tr><th>Monat</th><th>Umsatz</th><th>Kosten</th><th>Gewinn v. St.</th><th>Marge</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5" class="muted">Keine Daten.</td></tr>') + '</tbody>';
  }
  function drawProfitCharts() {
    var d = profitData(), labels = d.map(function (r) { return r.label; });
    chart('chProfitMonth', { type: 'bar', data: { labels: labels, datasets: [{ label: 'Gewinn', data: d.map(function (r) { return round2(r.profit); }), backgroundColor: d.map(function (r) { return r.profit >= 0 ? '#16a34a' : '#dc2626'; }), borderRadius: 6 }] }, options: baseOpts({ money: true, legend: false }) });
    chart('chRevCost', { type: 'bar', data: { labels: labels, datasets: [
      { label: 'Umsatz', data: d.map(function (r) { return round2(r.rev); }), backgroundColor: '#84cc16', borderRadius: 6 },
      { label: 'Kosten', data: d.map(function (r) { return round2(r.cost); }), backgroundColor: '#f87171', borderRadius: 6 },
    ] }, options: baseOpts({ money: true, legend: true }) });
  }

  // ── Spend ───────────────────────────────────────────────────────────────────
  function spendData() {
    var months = selectedMonths(), set = {}; months.forEach(function (m) { set[m] = 1; });
    var tx = state.transactions.filter(function (t) { return !t.excluded && set[ymOf(t)]; });
    var net = function (t) { return Number(t.amount_net != null ? t.amount_net : t.amount_gross) || 0; };
    var byCat = {}, byVendor = {}, byMonthCat = {};
    months.forEach(function (m) { byMonthCat[m] = {}; });
    tx.forEach(function (t) {
      var c = t.category || '(unkategorisiert)', v = vendorName(t), m = ymOf(t), a = net(t);
      byCat[c] = (byCat[c] || 0) + a; byVendor[v] = (byVendor[v] || 0) + a;
      byMonthCat[m][c] = (byMonthCat[m][c] || 0) + a;
    });
    var total = Object.keys(byCat).reduce(function (s, k) { return s + byCat[k]; }, 0);
    return { months: months, tx: tx, net: net, byCat: byCat, byVendor: byVendor, byMonthCat: byMonthCat, total: total };
  }
  function renderSpendStats() {
    renderDashFilter('spendFilter');
    var s = spendData();
    var cats = Object.keys(s.byCat).sort(function (a, b) { return s.byCat[b] - s.byCat[a]; });
    var nMonths = s.months.filter(function (m) { return s.tx.some(function (t) { return ymOf(t) === m; }); }).length || 1;
    el('spendKpis').innerHTML =
      kpiCard('Ausgaben gesamt', fmt(s.total), 'cost') +
      kpiCard('Buchungen', String(s.tx.length), '') +
      kpiCard('Ø pro Monat', fmt(s.total / nMonths), '') +
      kpiCard('Größte Kategorie', cats[0] || '—', '', cats[0] ? fmt(s.byCat[cats[0]]) : '');
    // Top-Lieferanten-Tabelle
    var vend = Object.keys(s.byVendor).map(function (k) { return [k, s.byVendor[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
    var vrows = vend.slice(0, 15).map(function (x, i) {
      return '<tr><td>' + (i + 1) + '. ' + esc(x[0]) + '</td><td class="num cost">' + fmt(x[1]) + '</td><td class="num muted">' + (s.total ? pct(x[1] / s.total * 100) : '—') + '</td></tr>';
    }).join('');
    el('vendorTable').innerHTML = '<thead><tr><th>Lieferant</th><th>Ausgaben</th><th>%</th></tr></thead><tbody>' +
      (vrows || '<tr><td colspan="3" class="muted">Keine Daten.</td></tr>') + '</tbody>';
    // Detailtabelle (letzte Buchungen)
    var recent = s.tx.slice().sort(function (a, b) { return a.tx_date < b.tx_date ? 1 : -1; }).slice(0, 80);
    var drows = recent.map(function (t) {
      return '<tr><td>' + esc(t.tx_date) + '</td><td>' + esc(vendorName(t).slice(0, 32)) + '</td><td>' + esc(t.category || '—') +
        '</td><td class="muted">' + esc(t.source === 'kreissparkasse' ? 'Bank' : 'AMEX') + '</td><td class="num cost">' + fmt(s.net(t)) + '</td></tr>';
    }).join('');
    el('spendDetailTable').innerHTML = '<thead><tr><th>Datum</th><th>Lieferant</th><th>Kategorie</th><th>Quelle</th><th>Betrag</th></tr></thead><tbody>' +
      (drows || '<tr><td colspan="5" class="muted">Keine Daten.</td></tr>') + '</tbody>';
  }
  function drawSpendCharts() {
    var s = spendData();
    var cats = Object.keys(s.byCat).sort(function (a, b) { return s.byCat[b] - s.byCat[a]; });
    chart('chSpendCat', { type: 'doughnut', data: { labels: cats, datasets: [{ data: cats.map(function (c) { return round2(s.byCat[c]); }), backgroundColor: cats.map(function (c, i) { return catColor(c, i); }), borderWidth: 2, borderColor: '#fff' }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '58%', plugins: { legend: { position: 'right', labels: { boxWidth: 12, usePointStyle: true, font: { size: 11 } } }, tooltip: { callbacks: { label: function (ctx) { return ctx.label + ': ' + fmt(ctx.parsed) + ' (' + (s.total ? (ctx.parsed / s.total * 100).toFixed(1) : 0) + '%)'; } } } } } });
    var vend = Object.keys(s.byVendor).map(function (k) { return [k, s.byVendor[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 12);
    chart('chSpendVendor', { type: 'bar', data: { labels: vend.map(function (x) { return x[0].slice(0, 22); }), datasets: [{ label: 'Ausgaben', data: vend.map(function (x) { return round2(x[1]); }), backgroundColor: '#2563eb', borderRadius: 5 }] }, options: baseOpts({ horizontal: true, legend: false }) });
    // Monatlich gestapelt nach Kategorie
    var ds = cats.map(function (c, i) { return { label: c, data: s.months.map(function (m) { return round2(s.byMonthCat[m][c] || 0); }), backgroundColor: catColor(c, i), borderRadius: 3 }; });
    chart('chSpendMonth', { type: 'bar', data: { labels: s.months.map(function (m) { var p = m.split('-'); return monthLabel(+p[0], +p[1]); }), datasets: ds }, options: baseOpts({ stacked: true, legend: true }) });
  }

  // ── Datenabdeckung (welche Monate/Quellen sind vorhanden, wo sind Lücken) ────
  function renderCoverage() {
    if (!el('coverage')) return;
    var av = availableMonths();
    if (!av.length) { el('coverage').innerHTML = '<div class="muted">Noch keine Daten importiert.</div>'; return; }
    var months = monthSeq(av[0], av[av.length - 1]);
    var sources = [['kreissparkasse', 'Kreissparkasse'], ['amex', 'AMEX']];
    var cnt = {}, imps = {};
    state.transactions.forEach(function (t) {
      var s = t.source, m = ymOf(t);
      cnt[s] = cnt[s] || {}; cnt[s][m] = (cnt[s][m] || 0) + 1;
      imps[s] = imps[s] || {}; imps[s][m] = imps[s][m] || {}; imps[s][m][t.import_id] = 1;
    });
    var head = '<th></th>' + months.map(function (m) { var p = m.split('-'); return '<th>' + MONTHS[+p[1] - 1].slice(0, 3) + '<div class="cov-y">' + p[0].slice(2) + '</div></th>'; }).join('');
    var gaps = [], dbls = [];
    var bodyRows = sources.map(function (s) {
      var cells = months.map(function (m) {
        var c = (cnt[s[0]] && cnt[s[0]][m]) || 0;
        var nImp = (imps[s[0]] && imps[s[0]][m]) ? Object.keys(imps[s[0]][m]).length : 0;
        var p = m.split('-'), lbl = MONTHS[+p[1] - 1].slice(0, 3) + ' ' + p[0];
        if (!c) { gaps.push(s[1] + ' ' + lbl); return '<td class="cov-cell cov-gap" title="keine Daten">–</td>'; }
        if (nImp > 1) { dbls.push(s[1] + ' ' + lbl + ' (' + nImp + ' Importe)'); return '<td class="cov-cell cov-dbl" title="' + c + ' Buchungen aus ' + nImp + ' Importen">' + c + '</td>'; }
        return '<td class="cov-cell cov-ok" title="' + c + ' Buchungen">' + c + '</td>';
      }).join('');
      return '<tr><td class="cov-src">' + s[1] + '</td>' + cells + '</tr>';
    }).join('');
    var note = '<div class="muted" style="margin-top:12px;line-height:1.6">' +
      '<span class="cov-key cov-ok"></span> Daten vorhanden &nbsp; <span class="cov-key cov-gap"></span> Lücke &nbsp; <span class="cov-key cov-dbl"></span> mehrere Importe';
    if (gaps.length) note += '<br><strong style="color:#b91c1c">Lücken:</strong> ' + esc(gaps.join(' · '));
    if (dbls.length) note += '<br><strong style="color:#854d0e">Mehrfach abgedeckt:</strong> ' + esc(dbls.join(' · ')) + ' — exakte Dubletten sind ausgeschlossen; bei AMEX überlappen sich Auszüge normal.';
    note += '</div>';
    el('coverage').innerHTML = '<div class="cov-wrap"><table class="cov"><thead><tr>' + head + '</tr></thead><tbody>' + bodyRows + '</tbody></table></div>' + note;
  }

  // ── Import ─────────────────────────────────────────────────────────────────
  function renderImports() {
    renderCoverage();
    var rows = state.imports.map(function (im) {
      return '<tr><td>' + esc(im.period_label || '–') + '</td><td>' + esc(im.source) + '</td>' +
        '<td>' + esc(im.filename || '') + '</td><td class="num">' + im.row_count + '</td>' +
        '<td class="num muted">' + im.skipped_count + '</td>' +
        '<td class="right"><button class="btn btn-ghost btn-sm" data-del-import="' + im.id + '">löschen</button></td></tr>';
    }).join('');
    el('importsTable').innerHTML =
      '<thead><tr><th>Zeitraum</th><th>Quelle</th><th>Datei</th><th>Neu</th><th>Duplikate</th><th></th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="6" class="muted">Noch nichts importiert.</td></tr>') + '</tbody>';
    Array.prototype.forEach.call(document.querySelectorAll('[data-del-import]'), function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Diesen Import samt zugehörigen Buchungen löschen?')) return;
        window.db.cost.imports.delete(b.dataset.delImport).then(reloadAndRender).catch(function (e) { alert(e.message); });
      });
    });
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    var override = el('importSource').value;
    var preview = el('importPreview');
    preview.innerHTML = '<div class="muted">Verarbeite …</div>';

    var summaries = [];
    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        return readFile(file).then(function (text) {
          var source = override === 'auto' ? detectSource(text) : override;
          if (!source) { summaries.push('⚠️ ' + esc(file.name) + ': Quelle nicht erkannt – bitte oben manuell wählen.'); return; }
          var parsed = E.parseCsv(text, source);
          if (!parsed.length) { summaries.push('⚠️ ' + esc(file.name) + ': keine Buchungen gefunden.'); return; }
          var enriched = E.assignDedupHashes(E.enrichAll(parsed, rulesObj()));
          var fileHash = hashStr(text);
          var dates = enriched.map(function (t) { return t.tx_date; }).sort();
          var period = monthFromIso(dates[0]) + ' – ' + monthFromIso(dates[dates.length - 1]);
          var rows = enriched.map(function (t) {
            return { tx_date: t.tx_date, year: t.year, month: t.month, source: t.source,
              description: t.description, payee: t.payee, purpose: t.purpose, booking_text: t.booking_text,
              amount_gross: t.amount_gross, category: t.category, vat_rate: t.vat_rate,
              vat_amount: t.vat_amount, amount_net: t.amount_net, excluded: t.excluded,
              exclude_reason: t.exclude_reason, dedup_hash: t.dedup_hash };
          });
          return window.db.cost.imports.findByHash(fileHash).then(function (dupes) {
            var warnDup = (dupes && dupes.length) ? ' (Datei war schon mal importiert – Duplikate werden übersprungen)' : '';
            return window.db.cost.imports.create(source, file.name, fileHash, 0, 0, period).then(function (imp) {
              rows.forEach(function (r) { r.import_id = imp.id; });
              return window.db.cost.transactions.insertMany(rows).then(function (inserted) {
                var ins = (inserted || []).length, skip = rows.length - ins;
                return window.db.cost.imports.update(imp.id, { row_count: ins, skipped_count: skip }).then(function () {
                  summaries.push('✅ ' + esc(file.name) + ' (' + source + '): ' + ins + ' neu, ' + skip + ' Duplikate' + warnDup);
                });
              });
            });
          });
        });
      });
    });

    chain.then(reloadData)
      .then(function () { return reapplyRules(); })   // vorhandene Regeln direkt anwenden
      .then(reloadData)
      .then(function () {
        preview.innerHTML = '<div class="alert alert-success">' + summaries.join('<br>') + '</div>';
        renderImports(); renderProfitStats(); renderSpendStats(); drawCharts(currentTab); renderMissing(); renderCategories(); renderTransactions();
        el('csvFile').value = '';
      }).catch(function (e) { preview.innerHTML = '<div class="alert alert-danger">Fehler: ' + esc(e.message) + '</div>'; });
  }
  function monthFromIso(iso) { var p = (iso || '').split('-'); return p.length === 3 ? MONTHS[+p[1] - 1] + ' ' + p[0] : iso; }

  // ── Unkategorisiert ────────────────────────────────────────────────────────
  function renderMissing() {
    var groups = {};
    state.transactions.forEach(function (t) {
      if (t.category != null || t.excluded) return;
      var pat = suggestPattern(t.payee || t.description);
      var key = E.norm(pat);
      (groups[key] = groups[key] || { sample: t, pattern: pat, sum: 0, count: 0, ids: [], txs: [] });
      groups[key].sum += Number(t.amount_net != null ? t.amount_net : t.amount_gross) || 0;
      groups[key].count++;
      groups[key].ids.push(t.id);
      groups[key].txs.push(t);
    });
    var keys = Object.keys(groups).sort(function (a, b) { return groups[b].sum - groups[a].sum; });
    lastMissing = keys.map(function (k) { return groups[k]; });
    el('missingCount').textContent = keys.length;

    var nSugg = 0;
    var rows = lastMissing.map(function (g, i) {
      var suggest = esc(g.pattern);
      var catSugg = E.suggestCategory(g.sample.description) || '';
      if (catSugg) nSugg++;
      return '<tr><td>' + esc(g.sample.description.slice(0, 70)) + '</td>' +
        '<td class="num">' + g.count + '</td><td class="num cost">' + fmt(g.sum) + '</td>' +
        '<td class="right"><input id="mp' + i + '" class="miss-pat" data-i="' + i + '" value="' + suggest + '" size="18" style="padding:5px 7px;border:1px solid var(--border);border-radius:6px">' +
        ' → <input id="mc' + i + '" class="miss-cat" data-i="' + i + '" value="' + esc(catSugg) + '" placeholder="Kategorie" size="16" list="catList" style="padding:5px 7px;border:1px solid var(--border);border-radius:6px' + (catSugg ? ';background:#fffbe6' : '') + '">' +
        ' <button class="btn btn-primary btn-sm" data-assign="' + i + '">anlegen</button>' +
        ' <button class="btn btn-secondary btn-sm" data-adjust="' + i + '" title="Betrag anteilig anpassen, z.B. nur dein 1/3 (Rest erstattet)">✎ anpassen</button>' +
        ' <button class="btn btn-ghost btn-sm" data-exclude="' + i + '" title="Diese Buchung(en) nicht als Kosten zählen (Durchlaufposten)">⊘ ausschließen</button></td></tr>';
    }).join('');
    el('missingTable').innerHTML =
      '<thead><tr><th>Beispiel-Buchung</th><th>Anzahl</th><th>Summe</th><th class="right">Regel anlegen (enthält → Kategorie) · oder ausschließen</th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="4" class="muted">Alles kategorisiert 🎉</td></tr>') + '</tbody>';
    if (el('missingBulkHint')) el('missingBulkHint').textContent =
      nSugg ? (nSugg + ' Vorschläge (gelb) vorausgefüllt – bitte prüfen, dann „Alle ausgefüllten anlegen".') : '';

    Array.prototype.forEach.call(document.querySelectorAll('[data-exclude]'), function (b) {
      b.addEventListener('click', function () {
        var g = lastMissing[b.dataset.exclude];
        if (!g) return;
        if (!confirm('„' + g.pattern + '" (' + g.count + ' Buchung(en), ' + fmt(g.sum) + ') als Durchlaufposten ausschließen? Zählt dann nicht als Kosten.')) return;
        b.disabled = true;
        window.db.cost.transactions.bulkExclude(g.ids, true, MANUAL_REASON).then(reloadAndRender).catch(function (e) { alert(e.message); b.disabled = false; });
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-adjust]'), function (b) {
      b.addEventListener('click', function () {
        var g = lastMissing[b.dataset.adjust];
        if (!g) return;
        var ans = prompt(
          'Wie viel von „' + g.pattern + '" soll als Kosten zählen?\n\n' +
          '• Anteil als Bruch, z.B.  1/3   (ein Drittel, Rest wurde erstattet)\n' +
          '• oder Prozent, z.B.  33%\n' +
          '• oder fester Euro-Betrag, z.B.  1332,00\n\n' +
          'Aktuell: ' + fmt(g.sum) + (g.count > 1 ? ' (' + g.count + ' Buchungen, Anteil/Prozent gilt je Buchung)' : ''), '1/3');
        if (ans == null) return;
        ans = ans.trim();
        var frac = null, abs = null;
        var mFrac = ans.match(/^(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)$/);
        var mPct = ans.match(/^(\d+(?:[.,]\d+)?)\s*%$/);
        if (mFrac) frac = parseFloat(mFrac[1].replace(',', '.')) / parseFloat(mFrac[2].replace(',', '.'));
        else if (mPct) frac = parseFloat(mPct[1].replace(',', '.')) / 100;
        else { abs = parseFloat(ans.replace(/[^0-9,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')); }
        if (frac == null && !isFinite(abs)) { alert('Bitte „1/3", „33%" oder einen Euro-Betrag eingeben.'); return; }
        if (abs != null && g.count > 1) { alert('Bei mehreren Buchungen bitte einen Anteil/Prozent angeben (gilt je Buchung).'); return; }
        b.disabled = true;
        var rules = rulesObj();
        Promise.all(g.txs.map(function (t) {
          var orig = E.enrich(t, rules).amount_net;                 // immer vom Originalbetrag rechnen
          var nn = frac != null ? Math.round(orig * frac * 100) / 100 : abs;
          return window.db.cost.transactions.update(t.id, { amount_net: nn, exclude_reason: ADJUSTED_REASON });
        })).then(reloadAndRender).catch(function (e) { alert(e.message); b.disabled = false; });
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-assign]'), function (b) {
      b.addEventListener('click', function () {
        var i = b.dataset.assign;
        var pattern = el('mp' + i).value.trim(), category = el('mc' + i).value.trim();
        if (!pattern || !category) { alert('Bitte Text und Kategorie angeben.'); return; }
        b.disabled = true;
        window.db.cost.categoryRules.add('contains', pattern, category)
          .then(function () { return reapplyRules(); })
          .then(reloadAndRender)
          .catch(function (e) { alert(e.message); b.disabled = false; });
      });
    });
  }

  // ── Regeln ─────────────────────────────────────────────────────────────────
  function renderRules() {
    // Kategorie-Regeln
    el('catRulesTable').innerHTML = ruleTable(state.categoryRules, function (r) {
      return '<td>' + esc(r.match_type) + '</td><td>' + esc(r.pattern) + '</td><td>' + esc(r.category) + '</td>';
    }, 'cat', ['Typ', 'Text', 'Kategorie']);
    // MwSt
    el('vatRulesTable').innerHTML = ruleTable(state.vatRules, function (r) {
      return '<td>' + esc(r.match_type) + '</td><td>' + esc(r.pattern) + '</td><td class="num">' + (Number(r.vat_rate) * 100).toFixed(0) + ' %</td>';
    }, 'vat', ['Typ', 'Lieferant', 'MwSt']);
    // Ausschluss
    el('excRulesTable').innerHTML = ruleTable(state.excludeRules, function (r) {
      return '<td>' + esc(r.match_type) + '</td><td>' + esc(r.pattern) + (r.builtin ? ' <span class="pill">System</span>' : '') +
        '</td><td>' + esc(r.reason || '') + '</td>';
    }, 'exc', ['Typ', 'Text', 'Grund']);

    // datalist Kategorien
    var cats = {};
    state.categoryRules.forEach(function (r) { cats[r.category] = 1; });
    Object.keys(state.settings).forEach(function (c) { cats[c] = 1; });
    el('catList').innerHTML = Object.keys(cats).sort().map(function (c) { return '<option value="' + esc(c) + '">'; }).join('');

    bindDelete('cat', window.db.cost.categoryRules);
    bindDelete('vat', window.db.cost.vatRules);
    bindDelete('exc', window.db.cost.excludeRules);

    // Einzeln (manuell) ausgeschlossene Buchungen
    var manual = state.transactions.filter(function (t) { return t.excluded && t.exclude_reason === MANUAL_REASON; })
      .sort(function (a, b) { return (a.tx_date < b.tx_date) ? 1 : -1; });
    var mBody = manual.map(function (t) {
      return '<tr><td>' + esc(t.tx_date) + '</td><td>' + esc((t.description || '').slice(0, 60)) +
        '</td><td class="num cost">' + fmt(t.amount_net != null ? t.amount_net : t.amount_gross) + '</td>' +
        '<td class="right"><button class="btn btn-ghost btn-sm" data-reinc="' + t.id + '">wieder einrechnen</button></td></tr>';
    }).join('');
    el('manualExclTable').innerHTML =
      '<thead><tr><th>Datum</th><th>Buchung</th><th>Betrag (netto)</th><th></th></tr></thead><tbody>' +
      (mBody || '<tr><td colspan="4" class="muted">Keine einzeln ausgeschlossenen Buchungen.</td></tr>') + '</tbody>';
    Array.prototype.forEach.call(document.querySelectorAll('[data-reinc]'), function (b) {
      b.addEventListener('click', function () {
        b.disabled = true;
        window.db.cost.transactions.bulkExclude([b.dataset.reinc], false, null).then(reloadAndRender).catch(function (e) { alert(e.message); b.disabled = false; });
      });
    });

    // Angepasste Buchungen (anteilig)
    var rules = rulesObj();
    var adjusted = state.transactions.filter(function (t) { return !t.excluded && t.exclude_reason === ADJUSTED_REASON; })
      .sort(function (a, b) { return (a.tx_date < b.tx_date) ? 1 : -1; });
    var aBody = adjusted.map(function (t) {
      var orig = E.enrich(t, rules).amount_net;
      return '<tr><td>' + esc(t.tx_date) + '</td><td>' + esc((t.description || '').slice(0, 55)) +
        '</td><td class="num muted">' + fmt(orig) + '</td><td class="num cost">' + fmt(t.amount_net) + '</td>' +
        '<td class="right"><button class="btn btn-ghost btn-sm" data-reset="' + t.id + '" data-orig="' + orig + '">zurücksetzen</button></td></tr>';
    }).join('');
    el('adjustedTable').innerHTML =
      '<thead><tr><th>Datum</th><th>Buchung</th><th>Original</th><th>Angepasst</th><th></th></tr></thead><tbody>' +
      (aBody || '<tr><td colspan="5" class="muted">Keine angepassten Buchungen.</td></tr>') + '</tbody>';
    Array.prototype.forEach.call(document.querySelectorAll('[data-reset]'), function (b) {
      b.addEventListener('click', function () {
        b.disabled = true;
        window.db.cost.transactions.update(b.dataset.reset, { amount_net: parseFloat(b.dataset.orig), exclude_reason: null })
          .then(reloadAndRender).catch(function (e) { alert(e.message); b.disabled = false; });
      });
    });

    // Finanzamt-Sammelzahlungen (USt + Lohnsteuer): nur Lohnsteuer zählt
    var bundles = state.transactions.filter(function (t) {
      return /lohnsteuer/i.test(t.description || '') && /umsatzsteuer/i.test(t.description || '');
    }).sort(function (a, b) { return (a.tx_date < b.tx_date) ? 1 : -1; });
    var bBody = bundles.map(function (t) {
      var ls = E.extractLohnsteuer(t.description);
      var ust = ls != null ? (Number(t.amount_gross) - ls) : null;
      return '<tr><td>' + esc(t.tx_date) + '</td><td class="num">' + fmt(t.amount_gross) + '</td>' +
        '<td class="num cost">' + (ls != null ? fmt(ls) : '?') + '</td>' +
        '<td class="num muted">' + (ust != null ? fmt(ust) : '?') + '</td></tr>';
    }).join('');
    el('bundleTable').innerHTML =
      '<thead><tr><th>Datum</th><th>Gesamt (brutto)</th><th>zählt: Lohnsteuer</th><th>Durchlauf: Umsatzsteuer</th></tr></thead><tbody>' +
      (bBody || '<tr><td colspan="4" class="muted">Keine Finanzamt-Sammelzahlungen gefunden.</td></tr>') + '</tbody>';
  }
  function ruleTable(rules, cells, ns, headers) {
    var body = rules.map(function (r) {
      return '<tr>' + cells(r) + '<td class="right">' +
        (r.builtin ? '<span class="muted">–</span>' : '<button class="btn btn-ghost btn-sm" data-del-' + ns + '="' + r.id + '">löschen</button>') +
        '</td></tr>';
    }).join('');
    return '<thead><tr><th>' + headers.join('</th><th>') + '</th><th></th></tr></thead><tbody>' +
      (body || '<tr><td colspan="' + (headers.length + 1) + '" class="muted">Keine Regeln.</td></tr>') + '</tbody>';
  }
  function bindDelete(ns, api) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-del-' + ns + ']'), function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Regel löschen? (greift erst nach „Regeln neu anwenden")')) return;
        api.delete(b.dataset['del' + ns.charAt(0).toUpperCase() + ns.slice(1)]).then(reloadAndRender).catch(function (e) { alert(e.message); });
      });
    });
  }

  // ── Kategorien (Schalter) ──────────────────────────────────────────────────
  function renderCategories() {
    var cats = {};
    state.transactions.forEach(function (t) { if (t.category) cats[t.category] = (cats[t.category] || 0); });
    state.categoryRules.forEach(function (r) { cats[r.category] = cats[r.category] || 0; });
    Object.keys(state.settings).forEach(function (c) { cats[c] = cats[c] || 0; });
    // Netto-Summe je Kategorie (nicht ausgeschlossen)
    state.transactions.forEach(function (t) {
      if (t.excluded || !t.category) return;
      cats[t.category] = (cats[t.category] || 0) + (Number(t.amount_net) || 0);
    });
    var names = Object.keys(cats).sort();
    el('categoriesList').innerHTML = names.length ? names.map(function (c) {
      var on = state.settings[c] !== false;
      return '<div class="toggle-row"><div><strong>' + esc(c) + '</strong> <span class="muted">' + fmt(cats[c]) + '</span></div>' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
        '<input type="checkbox" data-cat="' + esc(c) + '"' + (on ? ' checked' : '') + '> ' +
        '<span class="' + (on ? '' : 'muted') + '">' + (on ? 'zählt als Kosten' : 'nur Memo') + '</span></label></div>';
    }).join('') : '<div class="muted">Noch keine Kategorien.</div>';

    Array.prototype.forEach.call(document.querySelectorAll('[data-cat]'), function (cb) {
      cb.addEventListener('change', function () {
        window.db.cost.categorySettings.set(cb.dataset.cat, cb.checked).then(function () {
          state.settings[cb.dataset.cat] = cb.checked;
          renderProfitStats(); renderSpendStats(); drawCharts(currentTab); renderCategories();
        }).catch(function (e) { alert(e.message); });
      });
    });
  }

  // ── Buchungen (alle Transaktionen) ──────────────────────────────────────────
  function allCategories() {
    var s = {};
    state.categoryRules.forEach(function (r) { s[r.category] = 1; });
    Object.keys(state.settings).forEach(function (c) { s[c] = 1; });
    state.transactions.forEach(function (t) { if (t.category) s[t.category] = 1; });
    return Object.keys(s).sort();
  }
  function txStatusOf(t) {
    if (t.excluded) return 'excluded';
    if (t.exclude_reason === ADJUSTED_REASON) return 'adjusted';
    if (isManualCat(t.exclude_reason)) return 'manualcat';
    if (t.category == null) return 'uncat';
    return 'ok';
  }
  function txById(id) { for (var i = 0; i < state.transactions.length; i++) if (state.transactions[i].id === id) return state.transactions[i]; return null; }

  function renderTransactions() {
    if (!el('txTable')) return;
    var cats = allCategories();
    var catSel = el('txCat');
    if (catSel) {
      var cur = catSel.value;
      catSel.innerHTML = '<option value="">Alle Kategorien</option><option value="__uncat__">(unkategorisiert)</option>' +
        cats.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
      catSel.value = cur;
    }
    var q = ((el('txSearch') && el('txSearch').value) || '').toLowerCase().trim();
    var fCat = catSel ? catSel.value : '', fSrc = el('txSource') ? el('txSource').value : '', fStat = el('txStatus') ? el('txStatus').value : '';
    var rows = state.transactions.filter(function (t) {
      if (q && (t.description || '').toLowerCase().indexOf(q) === -1) return false;
      if (fCat === '__uncat__') { if (t.category != null) return false; } else if (fCat && t.category !== fCat) return false;
      if (fSrc && t.source !== fSrc) return false;
      if (fStat && txStatusOf(t) !== fStat) return false;
      return true;
    }).sort(function (a, b) { return a.tx_date < b.tx_date ? 1 : (a.tx_date > b.tx_date ? -1 : 0); });

    var LIMIT = 200, shown = rows.slice(0, LIMIT);
    if (el('txCount')) el('txCount').textContent = rows.length + ' Buchungen' + (rows.length > LIMIT ? ' · zeige erste ' + LIMIT + ' (Suche eingrenzen)' : '');

    var optsFor = function (sel) {
      return '<option value="__auto__">↺ automatisch (Regel)</option>' +
        cats.map(function (c) { return '<option value="' + esc(c) + '"' + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
    };
    var body = shown.map(function (t) {
      var st = txStatusOf(t);
      var badge = st === 'excluded' ? ' <span class="pill">ausgeschlossen</span>' : st === 'adjusted' ? ' <span class="pill">angepasst</span>' : st === 'manualcat' ? ' <span class="pill">📌 manuell</span>' : '';
      var catCell = t.excluded ? '<span class="muted">—</span>' :
        '<select class="tx-cat df-sel" data-id="' + t.id + '" style="padding:4px 6px;font-weight:400">' + optsFor(t.category) + '</select>';
      var action = t.excluded ?
        '<button class="btn btn-ghost btn-sm" data-tx-reinc="' + t.id + '">einrechnen</button>' :
        '<button class="btn btn-secondary btn-sm" data-tx-adjust="' + t.id + '" title="Betrag anpassen">✎</button> ' +
        '<button class="btn btn-ghost btn-sm" data-tx-excl="' + t.id + '" title="ausschließen">⊘</button>';
      return '<tr><td>' + esc(t.tx_date) + '</td>' +
        '<td>' + esc(vendorName(t).slice(0, 28)) + badge + '</td>' +
        '<td class="muted" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc((t.description || '').slice(0, 60)) + '</td>' +
        '<td>' + catCell + '</td>' +
        '<td class="muted">' + (t.source === 'kreissparkasse' ? 'Bank' : 'AMEX') + '</td>' +
        '<td class="num cost">' + fmt(t.amount_net != null ? t.amount_net : t.amount_gross) + '</td>' +
        '<td class="right" style="white-space:nowrap">' + action + '</td></tr>';
    }).join('');
    el('txTable').innerHTML =
      '<thead><tr><th>Datum</th><th>Lieferant</th><th>Beschreibung</th><th>Kategorie</th><th>Quelle</th><th>Netto</th><th></th></tr></thead>' +
      '<tbody>' + (body || '<tr><td colspan="7" class="muted">Keine Buchungen für diesen Filter.</td></tr>') + '</tbody>';

    Array.prototype.forEach.call(el('txTable').querySelectorAll('.tx-cat'), function (s) {
      s.addEventListener('change', function () {
        var t = txById(s.dataset.id); if (!t) return; s.disabled = true;
        var p = (s.value === '__auto__')
          ? (function () { var en = E.enrich(t, rulesObj()); return window.db.cost.transactions.update(t.id, { category: en.category, amount_net: en.amount_net, excluded: en.excluded, exclude_reason: en.exclude_reason }); })()
          : window.db.cost.transactions.update(t.id, { category: s.value, exclude_reason: CAT_PREFIX + s.value });
        p.then(reloadAndRender).catch(function (e) { alert(e.message); s.disabled = false; });
      });
    });
    Array.prototype.forEach.call(el('txTable').querySelectorAll('[data-tx-excl]'), function (b) {
      b.addEventListener('click', function () {
        var t = txById(b.dataset.txExcl); if (!t) return;
        if (!confirm('„' + vendorName(t) + '" (' + fmt(t.amount_net) + ') ausschließen? Zählt dann nicht als Kosten.')) return;
        b.disabled = true; window.db.cost.transactions.bulkExclude([t.id], true, MANUAL_REASON).then(reloadAndRender).catch(function (e) { alert(e.message); b.disabled = false; });
      });
    });
    Array.prototype.forEach.call(el('txTable').querySelectorAll('[data-tx-reinc]'), function (b) {
      b.addEventListener('click', function () { b.disabled = true; window.db.cost.transactions.bulkExclude([b.dataset.txReinc], false, null).then(reloadAndRender).catch(function (e) { alert(e.message); b.disabled = false; }); });
    });
    Array.prototype.forEach.call(el('txTable').querySelectorAll('[data-tx-adjust]'), function (b) {
      b.addEventListener('click', function () { var t = txById(b.dataset.txAdjust); if (t) adjustSingle(t, b); });
    });
  }
  function adjustSingle(t, btn) {
    var orig = E.enrich(t, rulesObj()).amount_net;
    var ans = prompt('Wie viel von „' + vendorName(t) + '" soll als Kosten zählen?\n\n• Bruch z.B.  1/3\n• Prozent z.B.  33%\n• oder Euro-Betrag z.B.  1332,00\n\nOriginal: ' + fmt(orig), '1/2');
    if (ans == null) return; ans = ans.trim();
    var frac = null, abs = null;
    var mF = ans.match(/^(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)$/), mP = ans.match(/^(\d+(?:[.,]\d+)?)\s*%$/);
    if (mF) frac = parseFloat(mF[1].replace(',', '.')) / parseFloat(mF[2].replace(',', '.'));
    else if (mP) frac = parseFloat(mP[1].replace(',', '.')) / 100;
    else abs = parseFloat(ans.replace(/[^0-9,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
    if (frac == null && !isFinite(abs)) { alert('Bitte „1/3", „33%" oder Euro-Betrag.'); return; }
    var nn = frac != null ? Math.round(orig * frac * 100) / 100 : abs;
    if (btn) btn.disabled = true;
    window.db.cost.transactions.update(t.id, { amount_net: nn, exclude_reason: ADJUSTED_REASON }).then(reloadAndRender).catch(function (e) { alert(e.message); if (btn) btn.disabled = false; });
  }

  // ── Regeln neu anwenden ────────────────────────────────────────────────────
  function reapplyRules() {
    var rules = rulesObj();
    var changed = [];          // nur tatsächlich geänderte Zeilen schreiben
    state.transactions.forEach(function (t) {
      var manual = t.excluded && t.exclude_reason === MANUAL_REASON;        // einzeln ausgeschlossen
      var adjusted = !t.excluded && t.exclude_reason === ADJUSTED_REASON;   // Betrag angepasst
      var manualCat = !t.excluded && isManualCat(t.exclude_reason);         // Kategorie manuell gesetzt
      var en = E.enrich(t, rules);
      var excluded = manual || en.excluded;
      var reason = manual ? MANUAL_REASON
        : (en.excluded ? en.exclude_reason : (adjusted ? ADJUSTED_REASON : (manualCat ? t.exclude_reason : en.exclude_reason)));
      var net = (adjusted && !en.excluded) ? t.amount_net : en.amount_net;  // angepassten Betrag halten
      var category = manualCat ? t.category : en.category;
      var diff = String(category) !== String(t.category) || Number(net) !== Number(t.amount_net) ||
        !!excluded !== !!t.excluded || String(reason) !== String(t.exclude_reason) ||
        Number(en.vat_amount) !== Number(t.vat_amount) || Number(en.vat_rate) !== Number(t.vat_rate);
      if (diff) changed.push(Object.assign({}, t, {
        category: category, vat_rate: en.vat_rate, vat_amount: en.vat_amount, amount_net: net,
        excluded: excluded, exclude_reason: reason, updated_at: new Date().toISOString(),
      }));
    });
    if (!changed.length) return Promise.resolve();
    var chunks = [];
    for (var i = 0; i < changed.length; i += 200) chunks.push(changed.slice(i, i + 200));
    return chunks.reduce(function (p, c) {
      return p.then(function () { return window.db.cost.transactions.bulkUpsert(c); });
    }, Promise.resolve());
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────
  function reloadData() { return loadAll(); }
  function reloadAndRender() { return loadAll().then(renderAll); }
  function renderAll() {
    renderProfitStats(); renderSpendStats();
    renderImports(); renderMissing(); renderRules(); renderCategories(); renderTransactions();
    drawCharts(currentTab);
  }

  function switchTab(name) {
    currentTab = name;
    Array.prototype.forEach.call(document.querySelectorAll('.ka-tab'), function (t) {
      t.classList.toggle('active', t.dataset.tab === name); });
    Array.prototype.forEach.call(document.querySelectorAll('.ka-panel'), function (p) {
      p.classList.toggle('active', p.dataset.panel === name); });
    drawCharts(name);   // Charts erst zeichnen, wenn Panel sichtbar (korrekte Größe)
  }

  function bindStatic() {
    Array.prototype.forEach.call(document.querySelectorAll('.ka-tab'), function (t) {
      t.addEventListener('click', function () { switchTab(t.dataset.tab); });
    });
    el('csvFile').addEventListener('change', function (e) { handleFiles(e.target.files); });
    ['txSearch', 'txCat', 'txSource', 'txStatus'].forEach(function (id) {
      var e = el(id); if (!e) return;
      e.addEventListener(id === 'txSearch' ? 'input' : 'change', function () { renderTransactions(); });
    });
    var dz = el('dropzone');
    ['dragover', 'dragenter'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.style.borderColor = 'var(--primary,#2563eb)'; }); });
    ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.style.borderColor = 'var(--border)'; }); });
    dz.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files); });

    el('reapplyBtn').addEventListener('click', function () {
      el('reapplyBtn').disabled = true; el('reapplyBtn').textContent = '↻ wird angewendet …';
      reapplyRules().then(reloadAndRender).then(function () {
        el('reapplyBtn').disabled = false; el('reapplyBtn').textContent = '↻ Regeln neu anwenden';
      }).catch(function (e) { alert(e.message); el('reapplyBtn').disabled = false; el('reapplyBtn').textContent = '↻ Regeln neu anwenden'; });
    });

    // Sammel-Anlegen: alle Zeilen mit ausgefüllter Kategorie auf einmal
    el('missingBulkBtn').addEventListener('click', function () {
      var toAdd = [], seen = {};
      Array.prototype.forEach.call(document.querySelectorAll('#missingTable .miss-cat'), function (cInp) {
        var i = cInp.dataset.i;
        var pInp = document.getElementById('mp' + i);
        var pattern = pInp ? pInp.value.trim() : '';
        var category = cInp.value.trim();
        if (!pattern || !category) return;
        var key = pattern.toLowerCase() + '|' + category;
        if (seen[key]) return; seen[key] = 1;
        toAdd.push({ match_type: 'contains', pattern: pattern, category: category });
      });
      if (!toAdd.length) { alert('Trage zuerst bei mindestens einer Zeile eine Kategorie ein.'); return; }
      if (!confirm(toAdd.length + ' Regel(n) anlegen und auf alle Buchungen anwenden?')) return;
      var btn = el('missingBulkBtn'); btn.disabled = true; btn.textContent = '… wird angelegt';
      window.db.cost.categoryRules.addMany(toAdd)
        .then(function () { return reapplyRules(); })
        .then(reloadAndRender)
        .then(function () { switchTab('missing'); btn.disabled = false; btn.textContent = '✓ Alle ausgefüllten anlegen'; })
        .catch(function (e) { alert(e.message); btn.disabled = false; btn.textContent = '✓ Alle ausgefüllten anlegen'; });
    });

    // Kategorie in alle noch leeren Felder übernehmen (nur lokal, kein Speichern)
    el('missingFillBtn').addEventListener('click', function () {
      var val = el('missingFillAll').value.trim();
      if (!val) { alert('Bitte oben eine Kategorie eingeben.'); return; }
      var n = 0;
      Array.prototype.forEach.call(document.querySelectorAll('#missingTable .miss-cat'), function (c) {
        if (!c.value.trim()) { c.value = val; n++; }
      });
      el('missingBulkHint').textContent = n + ' Felder gefüllt – jetzt „Alle ausgefüllten anlegen".';
    });

    el('catRuleAdd').addEventListener('click', function () {
      var p = el('catRulePattern').value.trim(), c = el('catRuleCategory').value.trim();
      if (!p || !c) return alert('Text und Kategorie angeben.');
      window.db.cost.categoryRules.add(el('catRuleType').value, p, c).then(function () {
        el('catRulePattern').value = ''; el('catRuleCategory').value = ''; return reloadAndRender();
      }).catch(function (e) { alert(e.message); });
    });
    el('vatRuleAdd').addEventListener('click', function () {
      var p = el('vatRulePattern').value.trim(), rate = parseFloat((el('vatRuleRate').value || '').replace(',', '.'));
      if (!p || !isFinite(rate)) return alert('Lieferant und MwSt-Satz angeben.');
      window.db.cost.vatRules.add(el('vatRuleType').value, p, rate / 100).then(function () {
        el('vatRulePattern').value = ''; el('vatRuleRate').value = ''; return reloadAndRender();
      }).catch(function (e) { alert(e.message); });
    });
    el('excRuleAdd').addEventListener('click', function () {
      var p = el('excRulePattern').value.trim(), reason = el('excRuleReason').value.trim();
      if (!p) return alert('Text angeben.');
      window.db.cost.excludeRules.add(el('excRuleType').value, p, reason).then(function () {
        el('excRulePattern').value = ''; el('excRuleReason').value = ''; return reloadAndRender();
      }).catch(function (e) { alert(e.message); });
    });
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  function init() {
    bindStatic();
    loadAll().then(function () {
      el('loading').style.display = 'none';
      el('app').style.display = '';
      renderAll();
    }).catch(function (e) { showError(e.message); });
  }

  // Auth lädt asynchron; wir starten direkt (RLS erlaubt Lesen). Kurzer Delay,
  // damit Supabase-Client/db bereit sind.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
