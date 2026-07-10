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

  // Monats-Selektoren (Wert = ym-Index: Jahr*12 + (Monat-1)) → z.B. "Jan 2026" → "Mai 2026".
  // Nur bis zum laufenden Monat – ein Umsatzverlauf hat keine Zukunftsmonate.
  for (var yy0 = curYear - 3; yy0 <= curYear; yy0++) {
    for (var mo0 = 1; mo0 <= 12; mo0++) {
      var ymv = yy0 * 12 + (mo0 - 1);
      if (ymv > curYM) continue;   // Zukunftsmonate ausblenden
      var label0 = MONTHS_SHORT[mo0 - 1] + ' ' + yy0;
      var o1 = document.createElement('option'); o1.value = ymv; o1.textContent = label0; yearFrom.appendChild(o1);
      var o2 = document.createElement('option'); o2.value = ymv; o2.textContent = label0; yearTo.appendChild(o2);
    }
  }
  yearFrom.value = curYear * 12;   // Januar laufendes Jahr
  yearTo.value   = curYM;          // laufender Monat
  yearFrom.addEventListener('change', function () { if (parseInt(yearFrom.value) > parseInt(yearTo.value)) yearTo.value = yearFrom.value; render(); });
  yearTo.addEventListener('change',   function () { if (parseInt(yearTo.value) < parseInt(yearFrom.value)) yearFrom.value = yearTo.value; render(); });

  function fmt(n)  { return (Math.round(n)).toLocaleString('de-DE') + ' €'; }
  function fmt2(n) { return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; }
  // Tooltip-Titel: bei Vorjahres-Reihen das Vorjahr anzeigen (statt der aktuellen Periode).
  function tipTitle(items) {
    var it = items[0]; if (!it) return '';
    var lbl = String((it.chart.data.labels || [])[it.dataIndex] || '');
    if (/Vorjahr/i.test(it.dataset.label || '')) {
      return lbl.replace(/\s*\(lfd\.\)\s*/i, '').replace(/(\d{4})/, function (y) { return (+y - 1); }) + ' (Vorjahr)';
    }
    return lbl;
  }
  function showError(msg) { errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' + msg + '</div>'; }

  var EXCLUDED_CONTACTS = {}; // zentral ausgeschlossene Kontakte (contact_overrides)
  var PPC_CATEGORY = 'Software'; // PPC-Tools-Kunden (99 €/Monat) – kein Agentur-Umsatz
  function normC(s) { return (s || '').trim().toLowerCase(); }
  function getExcludeKeywords() {
    return (localStorage.getItem('revenueExcludeKeywords') || '')
      .split('\n').map(function (k) { return k.trim().toLowerCase(); }).filter(function (k) { return k.length > 0; });
  }
  function isExcluded(name) {
    if (EXCLUDED_CONTACTS[normC(name)]) return true;   // zentraler Ausschluss
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
  var SERVICEROWS = null; // [{ ym, contact, service, amount }]

  function loadAll() {
    errorEl.innerHTML = '';
    loadingEl.classList.remove('hidden'); contentEl.classList.add('hidden');
    Promise.all([
      window.db.revenue.allRows(),
      // Service-Aufteilung ist additiv – fehlt sie (noch), Feature sauber leer lassen
      (window.db.revenueServices ? window.db.revenueServices.allRows() : Promise.resolve([])).catch(function () { return []; }),
      (window.db.contactOverrides ? window.db.contactOverrides.listAll() : Promise.resolve([])).catch(function () { return []; })
    ]).then(function (res) {
      var rows = res[0], svc = res[1] || [];
      EXCLUDED_CONTACTS = {};
      (res[2] || []).forEach(function (o) {
        if (o.status === 'excluded') EXCLUDED_CONTACTS[normC(o.contact_name)] = 1;
        // PPC-Tools-/Software-Kunden (99 €/Monat) raus – konsistent mit Churn/CAC/Neukunden
        else if (o.status && o.status.indexOf('cat:') === 0 && o.status.slice(4) === PPC_CATEGORY) EXCLUDED_CONTACTS[normC(o.contact_name)] = 1;
      });
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
      SERVICEROWS = svc.filter(function (r) {
        return r.contact_name && !isExcluded(r.contact_name) && Number(r.amount);
      }).map(function (r) {
        return { ym: r.year * 12 + (r.month - 1), contact: r.contact_name, service: r.service || 'Andere', amount: Number(r.amount) || 0 };
      });
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
  function buildPeriods(fromYM, toYM, gran) {
    var periods = [];
    if (gran === 'quarter') {
      var qs = fromYM - ((fromYM % 12) % 3);   // auf Quartalsanfang ausrichten
      for (var s = qs; s <= toYM; s += 3) {
        if (s > curYM) break;
        var yms = [s, s + 1, s + 2];
        var yq = Math.floor(s / 12), qn = ((s % 12) / 3) + 1;
        periods.push({ key: 'Q' + qn + ' ' + yq, label: 'Q' + qn + ' ' + yq, yms: yms, year: yq, incomplete: (s + 2) >= curYM, cmpYms: yms.map(function (x) { return x - 12; }) });
      }
    } else {
      for (var ym = fromYM; ym <= toYM; ym++) {
        if (ym > curYM) break; // Zukunft nicht zeigen
        var yy = Math.floor(ym / 12), mo = (ym % 12) + 1;
        periods.push({ key: ym, label: MONTHS_SHORT[mo - 1] + ' ' + yy, longLabel: MONTHS_LABEL[mo - 1] + ' ' + yy, yms: [ym], year: yy, month: mo, incomplete: ym === curYM, cmpYms: [ym - 12] });
      }
    }
    return periods;
  }

  var revChart = null, custChart = null;

  function render() {
    if (!MONTHDATA) return;
    var fromYM = parseInt(yearFrom.value), toYM = parseInt(yearTo.value);
    var gran = granEl.value, doCompare = compareToggle.checked;

    var periods = buildPeriods(fromYM, toYM, gran);
    periods.forEach(function (p) {
      p.cur = aggregate(p.yms);
      p.cmp = doCompare ? aggregate(p.cmpYms) : null;
    });

    // ── KPIs ──────────────────────────────────────────────────────────
    var completed = periods.filter(function (p) { return !p.incomplete; });
    var totalCompleted    = completed.reduce(function (s, p) { return s + p.cur.rev; }, 0);
    var totalCompletedCmp = completed.reduce(function (s, p) { return s + (p.cmp ? p.cmp.rev : 0); }, 0);

    // Ø pro abgeschlossenem MONAT (immer monatsbasiert, stabil)
    var compMonths = [];
    for (var z = fromYM; z <= toYM; z++) { if (z < curYM) compMonths.push(z); }
    var monthRevSum = compMonths.reduce(function (s, z) { return s + aggregate([z]).rev; }, 0);
    var avgMonth = compMonths.length ? monthRevSum / compMonths.length : 0;

    // letzter abgeschlossener Monat (für Kunden-KPIs)
    var lastYM = curYM - 1;
    var lastCur = aggregate([lastYM]);
    var lastCmp = aggregate([lastYM - 12]);

    var lastLbl = MONTHS_SHORT[((lastYM % 12))] + ' ' + Math.floor(lastYM / 12);
    document.getElementById('kpiTotal').textContent   = fmt(totalCompleted);
    document.getElementById('kpiTotalSub').innerHTML  = completed.length + ' abgeschl. ' + (gran === 'quarter' ? 'Quartale' : 'Monate') +
      (doCompare && totalCompletedCmp > 0 ? ' · Vorjahr ' + fmt(totalCompletedCmp) + ' ' + pctHtml(totalCompleted, totalCompletedCmp) : '');
    document.getElementById('kpiAvg').textContent     = fmt(avgMonth);
    document.getElementById('kpiCustomers').textContent = lastCur.active + '';
    document.getElementById('kpiCustomersSub').innerHTML = lastLbl + (doCompare ? ' · Vorjahr ' + lastCmp.active + ' · ' + pctHtml(lastCur.active, lastCmp.active) + ' vs Vj' : '');
    document.getElementById('kpiPerCustomer').textContent = fmt(lastCur.perCust);
    document.getElementById('kpiPerCustomerSub').innerHTML = (doCompare ? 'Vorjahr ' + fmt(lastCmp.perCust) + ' · ' : '') + pctHtml(lastCur.perCust, lastCmp.perCust) + ' vs Vj';

    // ── Charts ────────────────────────────────────────────────────────
    var labels   = periods.map(function (p) { return p.label + (p.incomplete ? ' (lfd.)' : ''); });
    var revMain  = periods.map(function (p) { return Math.round(p.cur.rev); });
    var revCmp   = doCompare ? periods.map(function (p) { return Math.round(p.cmp.rev); }) : null;
    var custMain = periods.map(function (p) { return p.cur.active; });
    var perCust  = periods.map(function (p) { return Math.round(p.cur.perCust); });
    var custCmp  = doCompare ? periods.map(function (p) { return p.cmp.active; }) : null;
    var perCustCmp = doCompare ? periods.map(function (p) { return Math.round(p.cmp.perCust); }) : null;

    buildRevChart(labels, revMain, revCmp);
    buildCustChart(labels, custMain, perCust, custCmp, perCustCmp);

    // ── Service-Verteilung über alle sichtbaren Monate des Zeitraums ──────
    var allYms = [];
    periods.forEach(function (p) { p.yms.forEach(function (y) { if (y <= curYM && allYms.indexOf(y) === -1) allYms.push(y); }); });
    renderServices(allYms);

    // ── Tabelle ───────────────────────────────────────────────────────
    document.querySelectorAll('th.cmp, td.cmp').forEach(function (e) { e.classList.toggle('hidden-col', !doCompare); });

    var running = 0;
    timelineBody.innerHTML = periods.map(function (p) {
      running += p.cur.rev;
      var c = p.cur, cm = p.cmp;
      var cmpCell = function (cur, prev, money) {
        if (!doCompare) return '';
        var pv = money ? fmt(prev) : ('' + prev);
        return '<td class="right cmp"><div style="font-variant-numeric:tabular-nums;color:var(--text-secondary)">' + pv + '</div>' +
          '<div style="font-size:11px">' + pctHtml(cur, prev) + '</div></td>';
      };
      return '<tr' + (p.incomplete ? ' style="opacity:.6"' : '') + '>' +
        '<td>' + p.label + (p.incomplete ? ' <span class="delta-neutral" style="font-size:11px">(lfd.)</span>' : '') + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt2(c.rev) + '</td>' +
        cmpCell(c.rev, cm ? cm.rev : 0, true) +
        '<td class="right">' + c.active + '</td>' +
        cmpCell(c.active, cm ? cm.active : 0, false) +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt(c.perCust) + '</td>' +
        cmpCell(c.perCust, cm ? cm.perCust : 0, true) +
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
        plugins: { legend: { display: !!cmp, position: 'top' }, tooltip: { callbacks: { title: tipTitle, label: function (c) { return ' ' + fmt2(c.parsed.y); } } } },
        scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: function (v) { return (v / 1000).toLocaleString('de-DE', { maximumFractionDigits: 0 }) + ' k €'; } } } } }
    });
  }

  function buildCustChart(labels, customers, perCust, customersCmp, perCustCmp) {
    var ctx = document.getElementById('customerChart').getContext('2d');
    if (custChart) custChart.destroy();
    var ds = [
      { type: 'bar', label: 'Aktive Kunden', data: customers, backgroundColor: '#10b981', borderRadius: 4, borderSkipped: false, yAxisID: 'y', order: 2 },
      { type: 'line', label: 'Ø Umsatz / Kunde', data: perCust, borderColor: '#f59e0b', backgroundColor: '#f59e0b', tension: .3, yAxisID: 'y1', pointRadius: 3, order: 0 }
    ];
    if (customersCmp) {
      ds.push({ type: 'bar', label: 'Aktive Kunden (Vorjahr)', data: customersCmp, backgroundColor: '#a7f3d0', borderRadius: 4, borderSkipped: false, yAxisID: 'y', order: 3 });
      ds.push({ type: 'line', label: 'Ø/Kunde (Vorjahr)', data: perCustCmp, borderColor: '#fcd34d', backgroundColor: '#fcd34d', borderDash: [5, 4], tension: .3, yAxisID: 'y1', pointRadius: 2, order: 1 });
    }
    custChart = new Chart(ctx, {
      data: { labels: labels, datasets: ds },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top' }, tooltip: { callbacks: { title: tipTitle, label: function (c) { return c.dataset.type === 'line' ? ' Ø/Kunde: ' + fmt2(c.parsed.y) : ' Kunden: ' + c.parsed.y; } } } },
        scales: { x: { grid: { display: false } },
          y:  { beginAtZero: true, position: 'left',  title: { display: true, text: 'Kunden' }, ticks: { precision: 0 } },
          y1: { beginAtZero: true, position: 'right', title: { display: true, text: 'Ø/Kunde' }, grid: { drawOnChartArea: false }, ticks: { callback: function (v) { return (v / 1000).toFixed(0) + ' k'; } } } } }
    });
  }

  // ── Service-Verteilung ────────────────────────────────────────────────
  var SERVICE_ORDER  = ['PPC', 'Full Service', 'Starter-Programm', 'Masterclass', 'Bilder', 'Andere'];
  var SERVICE_COLORS = { 'PPC': '#4f46e5', 'Full Service': '#10b981', 'Starter-Programm': '#f59e0b', 'Masterclass': '#ef4444', 'Bilder': '#06b6d4', 'Andere': '#94a3b8' };
  var svcColor = function (s) { return SERVICE_COLORS[s] || '#94a3b8'; };
  var serviceShareChart = null, serviceRevenueChart = null, serviceCustomerChart = null;

  function renderServices(yms) {
    var emptyEl  = document.getElementById('serviceEmpty');
    var chartsEl = document.getElementById('serviceCharts');
    var tableBody = document.getElementById('serviceTableBody');
    if (!SERVICEROWS) return;

    var ymSet = {}; yms.forEach(function (y) { ymSet[y] = true; });
    var agg = {}; // service → { rev, contacts:{} }
    SERVICEROWS.forEach(function (r) {
      if (!ymSet[r.ym]) return;
      if (!agg[r.service]) agg[r.service] = { rev: 0, contacts: {} };
      agg[r.service].rev += r.amount;
      agg[r.service].contacts[r.contact] = true;
    });

    var services = SERVICE_ORDER.filter(function (s) { return agg[s]; });
    Object.keys(agg).forEach(function (s) { if (services.indexOf(s) === -1) services.push(s); });
    var total = services.reduce(function (sum, s) { return sum + agg[s].rev; }, 0);

    if (services.length === 0 || total <= 0) {
      emptyEl.classList.remove('hidden');
      chartsEl.style.display = 'none';
      tableBody.innerHTML = '';
      document.getElementById('serviceRangeLabel').textContent = '';
      return;
    }
    emptyEl.classList.add('hidden');
    chartsEl.style.display = 'grid';
    document.getElementById('serviceRangeLabel').textContent = '· Gesamt ' + fmt(total);

    var labels  = services;
    var revData = services.map(function (s) { return Math.round(agg[s].rev); });
    var custData = services.map(function (s) { return Object.keys(agg[s].contacts).length; });
    var colors  = services.map(svcColor);

    buildServiceShareChart(labels, revData, colors, total);
    buildServiceBarChart('serviceRevenueChart', labels, revData, colors, false);
    buildServiceBarChart('serviceCustomerChart', labels, custData, colors, true);

    tableBody.innerHTML = services.map(function (s) {
      var pct = total > 0 ? (agg[s].rev / total * 100) : 0;
      return '<tr>' +
        '<td><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + svcColor(s) + ';margin-right:6px"></span>' + s + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt2(agg[s].rev) + '</td>' +
        '<td class="right">' + pct.toFixed(1) + '%</td>' +
        '<td class="right">' + Object.keys(agg[s].contacts).length + '</td>' +
        '</tr>';
    }).join('');
  }

  function buildServiceShareChart(labels, data, colors, total) {
    var ctx = document.getElementById('serviceShareChart').getContext('2d');
    if (serviceShareChart) serviceShareChart.destroy();
    serviceShareChart = new Chart(ctx, {
      type: 'doughnut',
      data: { labels: labels, datasets: [{ data: data, backgroundColor: colors, borderColor: '#fff', borderWidth: 1 }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'right' }, tooltip: { callbacks: { label: function (c) {
          var p = total > 0 ? (c.parsed / total * 100) : 0; return ' ' + c.label + ': ' + fmt2(c.parsed) + ' (' + p.toFixed(1) + '%)';
        } } } } }
    });
  }

  function buildServiceBarChart(canvasId, labels, data, colors, horizontal) {
    var ctx = document.getElementById(canvasId).getContext('2d');
    var existing = canvasId === 'serviceRevenueChart' ? serviceRevenueChart : serviceCustomerChart;
    if (existing) existing.destroy();
    var chart = new Chart(ctx, {
      type: 'bar',
      data: { labels: labels, datasets: [{ data: data, backgroundColor: colors, borderRadius: 4, borderSkipped: false }] },
      options: { indexAxis: horizontal ? 'y' : 'x', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) {
          return horizontal ? ' ' + c.parsed.x + ' Kunden' : ' ' + fmt2(c.parsed.y);
        } } } },
        scales: horizontal
          ? { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { grid: { display: false } } }
          : { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: function (v) { return (v / 1000).toLocaleString('de-DE', { maximumFractionDigits: 0 }) + ' k €'; } } } } }
    });
    if (canvasId === 'serviceRevenueChart') serviceRevenueChart = chart; else serviceCustomerChart = chart;
  }

  loadBtn.addEventListener('click', render);
  granEl.addEventListener('change', render);
  compareToggle.addEventListener('change', render);

  loadAll();
})();
