(function () {
  'use strict';

  var yearFrom      = document.getElementById('yearFrom');
  var yearTo        = document.getElementById('yearTo');
  var granEl        = document.getElementById('granularity');
  var loadBtn       = document.getElementById('loadBtn');
  var compareToggle = document.getElementById('compareToggle');
  var loadingEl     = document.getElementById('loading');
  var contentEl     = document.getElementById('content');
  var errorEl       = document.getElementById('error');
  var timelineBody  = document.getElementById('timelineBody');

  var now      = new Date();
  var curYear  = now.getFullYear();
  var curMonth = now.getMonth() + 1;
  var curYM    = curYear * 12 + (curMonth - 1); // index des laufenden (unvollständigen) Monats

  var MONTHS_LABEL = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  var MONTHS_SHORT = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];

  // Year selectors
  for (var y = curYear - 3; y <= curYear + 1; y++) {
    var o1 = document.createElement('option'); o1.value = y; o1.textContent = y; yearFrom.appendChild(o1);
    var o2 = document.createElement('option'); o2.value = y; o2.textContent = y; yearTo.appendChild(o2);
  }
  yearFrom.value = curYear; yearTo.value = curYear;
  yearFrom.addEventListener('change', function () { if (parseInt(yearFrom.value) > parseInt(yearTo.value)) yearTo.value = yearFrom.value; });
  yearTo.addEventListener('change',   function () { if (parseInt(yearTo.value) < parseInt(yearFrom.value)) yearFrom.value = yearTo.value; });

  function fmt(n)  { return (Math.round(n)).toLocaleString('de-DE') + ' €'; }
  function fmt2(n) { return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; }
  function showError(msg) { errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' + msg + '</div>'; }

  function getExcludeKeywords() {
    return (localStorage.getItem('revenueExcludeKeywords') || '')
      .split('\n').map(function (k) { return k.trim().toLowerCase(); }).filter(function (k) { return k.length > 0; });
  }
  function isExcluded(name) {
    var kws = getExcludeKeywords(); if (!kws.length) return false;
    var n = (name || '').toLowerCase(); return kws.some(function (kw) { return n.indexOf(kw) !== -1; });
  }

  function pctHtml(cur, prev) {
    if (prev > 0) {
      var p = ((cur - prev) / prev) * 100;
      var cls = p >= 0 ? 'delta-pos' : 'delta-neg';
      return '<span class="' + cls + '">' + (p >= 0 ? '↑' : '↓') + ' ' + Math.abs(p).toFixed(1) + '%</span>';
    }
    if (cur > 0) return '<span class="delta-pos">Neu</span>';
    return '<span class="delta-neutral">—</span>';
  }

  // ── Data store (alle Buchungen) ───────────────────────────────────────
  var MONTHDATA = null; // ym → { contact → amount }
  var FIRSTSEEN = null; // contact → frühester ym mit Umsatz

  function loadAll() {
    errorEl.innerHTML = '';
    loadingEl.classList.remove('hidden'); contentEl.classList.add('hidden');
    window.db.revenue.allRows().then(function (rows) {
      var md = {}, first = {};
      rows.forEach(function (r) {
        if (!r.contact_name || isExcluded(r.contact_name)) return;
        var amt = Number(r.total_amount) || 0; if (amt === 0) return;
        var ym = r.year * 12 + (r.month - 1);
        if (!md[ym]) md[ym] = {};
        md[ym][r.contact_name] = (md[ym][r.contact_name] || 0) + amt;
        if (first[r.contact_name] === undefined || ym < first[r.contact_name]) first[r.contact_name] = ym;
      });
      MONTHDATA = md; FIRSTSEEN = first;
      loadingEl.classList.add('hidden'); contentEl.classList.remove('hidden');
      render();
    }).catch(function (e) { loadingEl.classList.add('hidden'); showError(e.message); });
  }

  // Aggregiert eine Liste von Monats-Indizes zu einer Periode
  function aggregate(yms) {
    var rev = 0, contacts = {}, newC = 0;
    yms.forEach(function (ym) {
      var m = MONTHDATA[ym]; if (!m) return;
      Object.keys(m).forEach(function (c) { rev += m[c]; contacts[c] = true; });
    });
    var active = Object.keys(contacts);
    // Neukunden: erster Auftritt liegt in dieser Periode
    active.forEach(function (c) { if (yms.indexOf(FIRSTSEEN[c]) !== -1) newC++; });
    return { rev: rev, active: active.length, perCust: active.length ? rev / active.length : 0, neu: newC };
  }

  // Baut die anzuzeigenden Perioden (Monat oder Quartal), ohne Zukunftsmonate
  function buildPeriods(fromYear, toYear, gran) {
    var periods = [];
    if (gran === 'quarter') {
      for (var yy = fromYear; yy <= toYear; yy++) {
        for (var q = 1; q <= 4; q++) {
          var startYM = yy * 12 + (q - 1) * 3;
          if (startYM > curYM) continue; // Quartal noch nicht begonnen
          var yms = [startYM, startYM + 1, startYM + 2];
          var incomplete = (startYM + 2) >= curYM; // laufendes Quartal
          periods.push({ key: 'Q' + q + ' ' + yy, label: 'Q' + q + ' ' + yy, yms: yms, year: yy, incomplete: incomplete, cmpYms: yms.map(function (x) { return x - 12; }) });
        }
      }
    } else {
      for (var y2 = fromYear; y2 <= toYear; y2++) {
        for (var mo = 1; mo <= 12; mo++) {
          var ym = y2 * 12 + (mo - 1);
          if (ym > curYM) continue; // Zukunft nicht zeigen
          periods.push({ key: ym, label: MONTHS_SHORT[mo - 1] + ' ' + y2, longLabel: MONTHS_LABEL[mo - 1] + ' ' + y2, yms: [ym], year: y2, month: mo, incomplete: ym === curYM, cmpYms: [ym - 12] });
        }
      }
    }
    return periods;
  }

  var revChart = null, custChart = null;

  function render() {
    if (!MONTHDATA) return;
    var fromYear = parseInt(yearFrom.value), toYear = parseInt(yearTo.value);
    var gran = granEl.value, doCompare = compareToggle.checked;

    var periods = buildPeriods(fromYear, toYear, gran);
    periods.forEach(function (p) {
      p.cur = aggregate(p.yms);
      p.cmp = doCompare ? aggregate(p.cmpYms) : null;
    });

    // ── KPIs ──────────────────────────────────────────────────────────
    var completed = periods.filter(function (p) { return !p.incomplete; });
    var totalCompleted = completed.reduce(function (s, p) { return s + p.cur.rev; }, 0);

    // Ø pro abgeschlossenem MONAT (immer monatsbasiert, stabil)
    var compMonths = [];
    for (var yy = fromYear; yy <= toYear; yy++) for (var mm = 1; mm <= 12; mm++) { var z = yy * 12 + (mm - 1); if (z < curYM) compMonths.push(z); }
    var monthRevSum = compMonths.reduce(function (s, z) { return s + aggregate([z]).rev; }, 0);
    var avgMonth = compMonths.length ? monthRevSum / compMonths.length : 0;

    // letzter abgeschlossener Monat (für Kunden-KPIs)
    var lastYM = curYM - 1;
    var lastCur = aggregate([lastYM]);
    var lastCmp = aggregate([lastYM - 12]);

    document.getElementById('kpiTotal').textContent   = fmt(totalCompleted);
    document.getElementById('kpiTotalSub').textContent= completed.length + ' abgeschl. ' + (gran === 'quarter' ? 'Quartale' : 'Monate');
    document.getElementById('kpiAvg').textContent     = fmt(avgMonth);
    document.getElementById('kpiCustomers').textContent = lastCur.active + '';
    document.getElementById('kpiCustomersSub').innerHTML = MONTHS_SHORT[((lastYM % 12))] + ' ' + Math.floor(lastYM / 12) + ' · ' + pctHtml(lastCur.active, lastCmp.active) + ' vs Vj';
    document.getElementById('kpiPerCustomer').textContent = fmt(lastCur.perCust);
    document.getElementById('kpiPerCustomerSub').innerHTML = pctHtml(lastCur.perCust, lastCmp.perCust) + ' vs Vj';

    // ── Charts ────────────────────────────────────────────────────────
    var labels   = periods.map(function (p) { return p.label + (p.incomplete ? ' (lfd.)' : ''); });
    var revMain  = periods.map(function (p) { return Math.round(p.cur.rev); });
    var revCmp   = doCompare ? periods.map(function (p) { return Math.round(p.cmp.rev); }) : null;
    var custMain = periods.map(function (p) { return p.cur.active; });
    var perCust  = periods.map(function (p) { return Math.round(p.cur.perCust); });

    buildRevChart(labels, revMain, revCmp);
    buildCustChart(labels, custMain, perCust);

    // ── Tabelle ───────────────────────────────────────────────────────
    document.querySelectorAll('th.cmp, td.cmp').forEach(function (e) { e.classList.toggle('hidden-col', !doCompare); });

    var running = 0;
    timelineBody.innerHTML = periods.map(function (p) {
      running += p.cur.rev;
      var c = p.cur, cm = p.cmp;
      var cmpCell = function (cur, prev) { return doCompare ? '<td class="right cmp">' + pctHtml(cur, prev) + '</td>' : ''; };
      return '<tr' + (p.incomplete ? ' style="opacity:.6"' : '') + '>' +
        '<td>' + p.label + (p.incomplete ? ' <span class="delta-neutral" style="font-size:11px">(lfd.)</span>' : '') + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt2(c.rev) + '</td>' +
        cmpCell(c.rev, cm ? cm.rev : 0) +
        '<td class="right">' + c.active + '</td>' +
        cmpCell(c.active, cm ? cm.active : 0) +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt(c.perCust) + '</td>' +
        cmpCell(c.perCust, cm ? cm.perCust : 0) +
        '<td class="right">' + (c.neu > 0 ? '<span class="delta-pos">+' + c.neu + '</span>' : '0') + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums;color:var(--text-secondary)">' + fmt(running) + '</td>' +
        '</tr>';
    }).join('');
  }

  function buildRevChart(labels, main, cmp) {
    var ctx = document.getElementById('revenueChart').getContext('2d');
    if (revChart) revChart.destroy();
    var ds = [{ label: 'Umsatz', data: main, backgroundColor: '#4f46e5', borderRadius: 4, borderSkipped: false }];
    if (cmp) ds.push({ label: 'Vorjahr', data: cmp, backgroundColor: '#cbd5e1', borderRadius: 4, borderSkipped: false });
    revChart = new Chart(ctx, {
      type: 'bar', data: { labels: labels, datasets: ds },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: !!cmp, position: 'top' }, tooltip: { callbacks: { label: function (c) { return ' ' + fmt2(c.parsed.y); } } } },
        scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: function (v) { return (v / 1000).toLocaleString('de-DE', { maximumFractionDigits: 0 }) + ' k €'; } } } } }
    });
  }

  function buildCustChart(labels, customers, perCust) {
    var ctx = document.getElementById('customerChart').getContext('2d');
    if (custChart) custChart.destroy();
    custChart = new Chart(ctx, {
      data: { labels: labels, datasets: [
        { type: 'bar', label: 'Aktive Kunden', data: customers, backgroundColor: '#10b981', borderRadius: 4, borderSkipped: false, yAxisID: 'y' },
        { type: 'line', label: 'Ø Umsatz / Kunde', data: perCust, borderColor: '#f59e0b', backgroundColor: '#f59e0b', tension: .3, yAxisID: 'y1', pointRadius: 3 }
      ] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top' }, tooltip: { callbacks: { label: function (c) { return c.dataset.type === 'line' ? ' Ø/Kunde: ' + fmt2(c.parsed.y) : ' Kunden: ' + c.parsed.y; } } } },
        scales: { x: { grid: { display: false } },
          y:  { beginAtZero: true, position: 'left',  title: { display: true, text: 'Kunden' }, ticks: { precision: 0 } },
          y1: { beginAtZero: true, position: 'right', title: { display: true, text: 'Ø/Kunde' }, grid: { drawOnChartArea: false }, ticks: { callback: function (v) { return (v / 1000).toFixed(0) + ' k'; } } } } }
    });
  }

  loadBtn.addEventListener('click', render);
  granEl.addEventListener('change', render);
  compareToggle.addEventListener('change', render);

  loadAll();
})();
