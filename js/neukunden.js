(function () {
  'use strict';

  var loadingEl  = document.getElementById('loading');
  var contentEl  = document.getElementById('content');
  var errorEl    = document.getElementById('error');
  var yearSelect = document.getElementById('yearSelect');
  var gapInput   = document.getElementById('gapInput');
  var caveatBox  = document.getElementById('caveatBox');
  var excludeNote= document.getElementById('excludeNote');
  var newBody    = document.getElementById('newBody');
  var newEmpty   = document.getElementById('newEmpty');

  var MONTHS_LABEL = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  var PPC_CATEGORY = 'Software';

  function fmt(n)   { return (n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; }
  function fmtInt(n){ return (n || 0).toLocaleString('de-DE'); }
  function ym(y, m) { return y * 12 + (m - 1); }
  function ymY(v)   { return Math.floor(v / 12); }
  function ymM(v)   { return (v % 12) + 1; }
  function ymLabel(v){ return MONTHS_LABEL[ymM(v) - 1] + ' ' + ymY(v); }
  function normC(s) { return (s || '').trim().toLowerCase(); }
  function escHtml(s){ return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function showError(msg){ errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' + msg + '</div>'; }

  // ── State ──────────────────────────────────────────────────────────
  var allRevenue = [], allOverrides = [], allClients = [];
  var excludedGlobal = {}, excludedPPC = {}, projectContacts = {};
  var activeYmsByContact = {};    // contact_name -> sorted [ym...]
  var revByContactYm = {};        // contact_name -> { ym: amount }
  var monthFilter = null;         // ym or null — drill-down
  var chartMode = 'count';        // 'count' | 'revenue'
  var latestDataYm = null, earliestDataYm = null;
  var allContactNames = [];
  var newChart = null;

  function isExcluded(name) { var k = normC(name); return !!(excludedGlobal[k] || excludedPPC[k]); }

  function buildExclusions() {
    excludedGlobal = {}; excludedPPC = {};
    allOverrides.forEach(function (o) {
      if (o.status === 'excluded') excludedGlobal[normC(o.contact_name)] = 1;
      else if (o.status && o.status.indexOf('cat:') === 0 && o.status.slice(4) === PPC_CATEGORY) excludedPPC[normC(o.contact_name)] = 1;
    });
    // Auto-Erkennung: Kontakte mit reiner 99-€/49,50-€-Signatur ebenfalls als Software behandeln
    var auto = window.detectSoftwareContacts ? window.detectSoftwareContacts(allRevenue) : {};
    Object.keys(auto).forEach(function (k) { if (!excludedGlobal[k]) excludedPPC[k] = 1; });
  }

  function buildProjectSet() {
    projectContacts = {};
    allClients.forEach(function (c) {
      if (!c.is_project) return;
      if (c.lexoffice_name) projectContacts[normC(c.lexoffice_name)] = 1;
      if (c.name)           projectContacts[normC(c.name)] = 1;
    });
  }

  function buildIndexes() {
    activeYmsByContact = {};
    revByContactYm = {};
    var seen = {};
    allRevenue.forEach(function (r) {
      if (!r.contact_name || isExcluded(r.contact_name)) return;
      if (!(r.total_amount > 0)) return; // only months with actual revenue = active
      var v = ym(r.year, r.month);
      var key = r.contact_name;
      if (!revByContactYm[key]) revByContactYm[key] = {};
      revByContactYm[key][v] = (revByContactYm[key][v] || 0) + r.total_amount;
      if (!seen[key]) seen[key] = {};
      if (seen[key][v]) return;
      seen[key][v] = 1;
      (activeYmsByContact[key] || (activeYmsByContact[key] = [])).push(v);
    });
    Object.keys(activeYmsByContact).forEach(function (k) { activeYmsByContact[k].sort(function (a, b) { return a - b; }); });

    var included = allRevenue.filter(function (r) { return r.contact_name && !isExcluded(r.contact_name) && r.total_amount > 0; });
    var yms = included.map(function (r) { return ym(r.year, r.month); });
    latestDataYm   = yms.length ? Math.max.apply(null, yms) : null;
    earliestDataYm = yms.length ? Math.min.apply(null, yms) : null;

    allContactNames = Object.keys(activeYmsByContact).sort(function (a, b) { return a.localeCompare(b, 'de'); });
  }

  // Compute the first-acquisition record of every included, non-project contact.
  function computeNewCustomers(gapThresh) {
    var result = [];
    allContactNames.forEach(function (name) {
      var yms = activeYmsByContact[name];
      if (!yms || !yms.length) return;
      // Projektkunden zählen als Neukunde (anders als im Churn) — es sind gewonnene Kunden.

      var firstYm = yms[0];
      var lastYm  = yms[yms.length - 1];
      var activeMonths = yms.length;

      // ── Startumsatz: Run-Rate der ERSTEN bis zu 3 aktiven Monate ──
      var perYm = revByContactYm[name] || {};
      var totalRev = 0;
      yms.forEach(function (v) { totalRev += (perYm[v] || 0); });
      var firstN  = yms.slice(0, 3);
      var runRate = firstN.length ? firstN.reduce(function (s, v) { return s + (perYm[v] || 0); }, 0) / firstN.length : 0;
      var annualRev = runRate * 12;

      // ── Rhythmus → aktueller Status (aktiv / pausiert) ──
      var maxRecoveredGap = 1;
      for (var gi = 1; gi < yms.length; gi++) {
        var g = yms[gi] - yms[gi - 1];
        if (g > maxRecoveredGap) maxRecoveredGap = g;
      }
      var effectiveGap = Math.max(gapThresh, maxRecoveredGap + 1);
      var gap = latestDataYm - lastYm;
      var stillActive = gap < effectiveGap;

      result.push({
        name: name, firstYm: firstYm, lastYm: lastYm, activeMonths: activeMonths,
        totalRev: totalRev, runRate: runRate, annualRev: annualRev,
        stillActive: stillActive, gap: gap, isProject: !!projectContacts[normC(name)],
      });
    });
    return result;
  }

  // ── Render ─────────────────────────────────────────────────────────
  function render() {
    var gapThresh = Math.max(1, parseInt(gapInput.value, 10) || 2);
    var year = parseInt(yearSelect.value, 10);

    document.querySelectorAll('.kpiYearLabel').forEach(function (el) { el.textContent = year; });

    var all = computeNewCustomers(gapThresh);

    caveatBox.innerHTML = latestDataYm !== null
      ? '<div class="caveat-box">ℹ️ Letzter Datenmonat: <strong>' + ymLabel(latestDataYm) + '</strong>. Ein Neukunde erscheint erst, sobald seine erste Rechnung synchronisiert ist — der aktuelle Monat kann noch unvollständig sein.</div>'
      : '';

    renderExcludeNote();

    // Neukunden im gewählten Jahr = erste Rechnung fällt in dieses Jahr
    var newInYear = all.filter(function (c) { return ymY(c.firstYm) === year; });
    newInYear.sort(function (a, b) { return a.firstYm - b.firstYm || a.name.localeCompare(b.name, 'de'); });

    // KPIs
    document.getElementById('kpiNew').textContent = fmtInt(newInYear.length);

    var stillActive = newInYear.filter(function (c) { return c.stillActive; }).length;
    document.getElementById('kpiStillActive').textContent = newInYear.length ? fmtInt(stillActive) : '—';
    document.getElementById('kpiStillActiveHint').textContent = newInYear.length
      ? stillActive + ' von ' + newInYear.length + ' noch aktiv (im Rhythmus)'
      : 'noch aktive Neukunden';

    var avgRunRate = newInYear.length ? newInYear.reduce(function (s, c) { return s + (c.runRate || 0); }, 0) / newInYear.length : 0;
    document.getElementById('kpiAvgStart').textContent = newInYear.length ? fmt(avgRunRate) : '—';

    var wonAnnual  = newInYear.reduce(function (s, c) { return s + (c.annualRev || 0); }, 0);
    var wonMonthly = newInYear.reduce(function (s, c) { return s + (c.runRate  || 0); }, 0);
    document.getElementById('kpiWonRev').textContent     = newInYear.length ? fmt(wonAnnual) : '—';
    document.getElementById('kpiWonRevHint').textContent = newInYear.length
      ? fmt(wonMonthly) + ' / Monat (Start-Run-Rate) · annualisiert ×12'
      : 'annualisierte Start-Run-Rate der Neukunden';

    // Month drill-down
    if (monthFilter !== null && ymY(monthFilter) !== year) monthFilter = null;
    var tableList = monthFilter !== null
      ? newInYear.filter(function (c) { return c.firstYm === monthFilter; })
      : newInYear;
    renderMonthFilterBar(newInYear.length, tableList);
    renderTable(tableList);
    renderChart(newInYear, year);
  }

  function renderMonthFilterBar(totalInYear, monthList) {
    var bar = document.getElementById('monthFilterBar');
    if (!bar) return;
    if (monthFilter === null) { bar.innerHTML = ''; return; }
    var names = monthList.length
      ? monthList.map(function (c) { return escHtml(c.name); }).join(', ')
      : 'keine';
    bar.innerHTML =
      '<div style="display:flex;align-items:flex-start;gap:12px;padding:10px 14px;background:var(--primary-light);' +
      'border:1px solid var(--primary);border-radius:var(--radius);font-size:13px;margin-bottom:12px">' +
      '<div style="flex:1"><strong>' + ymLabel(monthFilter) + '</strong>: ' +
        monthList.length + ' Neukunde' + (monthList.length === 1 ? '' : 'n') + ' — ' + names + '</div>' +
      '<button id="clearMonthFilter" class="btn btn-ghost btn-sm" style="padding:2px 10px;white-space:nowrap">alle Monate (' + totalInYear + ')</button>' +
      '</div>';
    var btn = document.getElementById('clearMonthFilter');
    if (btn) btn.addEventListener('click', function () { monthFilter = null; render(); });
  }

  function renderTable(list) {
    newBody.innerHTML = '';
    if (!list.length) { newEmpty.classList.remove('hidden'); return; }
    newEmpty.classList.add('hidden');
    list.forEach(function (c) {
      var statusTag = c.stillActive
        ? '<span class="tag tag-active">aktiv</span>'
        : '<span class="tag tag-paused">pausiert (' + c.gap + ' Mon.)</span>';
      var projectTag = c.isProject ? ' <span class="tag tag-project">Projekt</span>' : '';
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td style="font-weight:500">' + escHtml(c.name) + projectTag + '</td>' +
        '<td>' + ymLabel(c.firstYm) + '</td>' +
        '<td class="right">' + c.activeMonths + ' Mon.</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt(c.runRate) + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums;font-weight:600">' + fmt(c.annualRev) + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums;color:var(--text-secondary)">' + fmt(c.totalRev) + '</td>' +
        '<td>' + statusTag + '</td>';
      newBody.appendChild(tr);
    });
  }

  function renderChart(newInYear, year) {
    var ctx = document.getElementById('newChart');
    if (!ctx) return;
    var counts = new Array(12).fill(0);
    var revenue = new Array(12).fill(0);
    newInYear.forEach(function (c) {
      var m = ymM(c.firstYm) - 1;
      counts[m]++;
      revenue[m] += (c.annualRev || 0);
    });

    var mode = chartMode; // 'count' | 'revenue'
    var label = mode === 'revenue' ? 'Gewonnener Umsatz p.a.' : 'Neukunden';
    var data = mode === 'revenue' ? revenue.map(function (v) { return Math.round(v); }) : counts;

    if (newChart) newChart.destroy();
    newChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: MONTHS_LABEL,
        datasets: [{
          label: label,
          data: data,
          backgroundColor: data.map(function (_, i) {
            return (monthFilter !== null && ymM(monthFilter) - 1 === i) ? '#047857' : '#10b981';
          }),
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        onClick: function (evt) {
          var pts = newChart.getElementsAtEventForMode(evt, 'nearest', { intersect: false }, false);
          if (!pts.length) return;
          var mIdx = pts[0].index;
          var clickedYm = ym(year, mIdx + 1);
          if ((counts[mIdx] || 0) === 0) return;
          monthFilter = (monthFilter === clickedYm) ? null : clickedYm;
          render();
        },
        onHover: function (evt, els) { evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (item) {
            var i = item.dataIndex;
            if (mode === 'revenue') return 'Gewonnener Umsatz p.a.: ' + fmt(item.parsed.y);
            return item.parsed.y + ' Neukunde' + (item.parsed.y === 1 ? '' : 'n');
          } } },
        },
        scales: { y: { beginAtZero: true, ticks:
            mode === 'revenue' ? { callback: function (v) { return (v / 1000).toLocaleString('de-DE') + 'k €'; } }
          :                      { precision: 0 } } },
      },
    });
  }

  function renderExcludeNote() {
    var ppc = [], glob = [];
    var firstAll = {};
    allRevenue.forEach(function (r) {
      if (!r.contact_name || !(r.total_amount > 0)) return;
      var v = ym(r.year, r.month);
      if (firstAll[r.contact_name] === undefined || v < firstAll[r.contact_name]) firstAll[r.contact_name] = v;
    });
    Object.keys(firstAll).forEach(function (name) {
      var k = normC(name);
      if (excludedPPC[k]) ppc.push(name);
      else if (excludedGlobal[k]) glob.push(name);
    });
    if (!ppc.length && !glob.length) { excludeNote.innerHTML = ''; return; }
    var byDe = function (a, b) { return a.localeCompare(b, 'de'); };
    ppc.sort(byDe); glob.sort(byDe);
    var parts = [];
    if (ppc.length)  parts.push('<strong>' + ppc.length + ' PPC-Tools-Kunde' + (ppc.length === 1 ? '' : 'n') + '</strong> (99 €/Monat, inkl. automatisch am 99-€-Muster erkannt)');
    if (glob.length) parts.push('<strong>' + glob.length + ' als „kein Kunde"</strong>');
    excludeNote.innerHTML =
      '<div class="caveat-box" style="background:var(--primary-light);border-color:var(--primary);color:var(--text)">' +
      'ℹ️ Aus der Neukunden-Analyse ausgeschlossen (konsistent mit Churn/CAC, via <a href="name-mapping.html">Zuordnung</a>): ' +
      parts.join(' · ') + '. Umschalten dort.</div>';
  }

  // ── Year select ────────────────────────────────────────────────────
  function populateYearSelect() {
    var latestY = latestDataYm !== null ? ymY(latestDataYm) : new Date().getFullYear();
    var earliestY = earliestDataYm !== null ? ymY(earliestDataYm) : latestY;
    yearSelect.innerHTML = '';
    for (var y = latestY; y >= earliestY; y--) {
      var o = document.createElement('option'); o.value = y; o.textContent = y; yearSelect.appendChild(o);
    }
    var preferred = 2025;
    var has = Array.prototype.slice.call(yearSelect.options).some(function (o) { return parseInt(o.value, 10) === preferred; });
    yearSelect.value = has ? String(preferred) : String(latestY);
  }

  // ── Boot ───────────────────────────────────────────────────────────
  yearSelect.addEventListener('change', render);
  gapInput.addEventListener('change', render);

  var CHART_MODE_BTNS = [['chartModeCount', 'count'], ['chartModeRevenue', 'revenue']];
  function setChartMode(mode) {
    chartMode = mode;
    CHART_MODE_BTNS.forEach(function (p) {
      var b = document.getElementById(p[0]);
      if (b) b.className = 'btn btn-sm ' + (mode === p[1] ? 'btn-primary' : 'btn-secondary');
    });
    render();
  }
  CHART_MODE_BTNS.forEach(function (p) {
    var b = document.getElementById(p[0]);
    if (b) b.addEventListener('click', function () { setChartMode(p[1]); });
  });

  function loadData() {
    errorEl.innerHTML = '';
    loadingEl.classList.remove('hidden');
    contentEl.classList.add('hidden');

    Promise.all([
      window.db.revenue.allRows(),
      (window.db.contactOverrides ? window.db.contactOverrides.listAll() : Promise.resolve([])).catch(function () { return []; }),
      window.db.clients.list(),
    ]).then(function (res) {
      allRevenue   = res[0] || [];
      allOverrides = res[1] || [];
      allClients   = res[2] || [];
      buildExclusions();
      buildProjectSet();
      buildIndexes();
      populateYearSelect();
      loadingEl.classList.add('hidden');
      contentEl.classList.remove('hidden');
      render();
    }).catch(function (e) {
      loadingEl.classList.add('hidden');
      showError(e.message === 'NOT_CONFIGURED'
        ? 'Keine Supabase-Verbindung. Bitte <a href="settings.html">Einstellungen</a> prüfen.'
        : e.message);
    });
  }

  loadData();
})();
