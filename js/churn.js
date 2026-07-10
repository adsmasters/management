(function () {
  'use strict';

  var loadingEl  = document.getElementById('loading');
  var contentEl  = document.getElementById('content');
  var errorEl    = document.getElementById('error');
  var yearSelect = document.getElementById('yearSelect');
  var tenureInput= document.getElementById('tenureInput');
  var gapInput   = document.getElementById('gapInput');
  var caveatBox  = document.getElementById('caveatBox');
  var excludeNote= document.getElementById('excludeNote');
  var churnBody  = document.getElementById('churnBody');
  var churnEmpty = document.getElementById('churnEmpty');
  var atRiskBody = document.getElementById('atRiskBody');
  var atRiskEmpty= document.getElementById('atRiskEmpty');

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
  var allRevenue = [], allOverrides = [], allChurn = [], allClients = [];
  var excludedGlobal = {}, excludedPPC = {}, projectContacts = {};
  var manualByContact = {};       // normC -> {status, churn_date, reason, notes, contact_name}
  var activeYmsByContact = {};    // contact_name -> sorted [ym...]
  var revByContactYm = {};        // contact_name -> { ym: amount }  (for run-rate)
  var monthFilter = null;         // ym or null — drill-down: only show churns of this month
  var chartMode = 'rate';         // 'rate' | 'count' | 'revenue'
  var latestDataYm = null, earliestDataYm = null;
  var allContactNames = [];       // included, sorted (for datalist)
  var churnChart = null;

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
    var seen = {}; // contact -> set of ym (dedupe)
    allRevenue.forEach(function (r) {
      if (!r.contact_name || isExcluded(r.contact_name)) return;
      if (!(r.total_amount > 0)) return; // only months with actual revenue = active
      var v = ym(r.year, r.month);
      var key = r.contact_name;
      // sum revenue per contact×month (a month can have several invoice rows)
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

    manualByContact = {};
    allChurn.forEach(function (m) { manualByContact[normC(m.contact_name)] = m; });
  }

  function longestStreak(yms) {
    if (!yms.length) return 0;
    var best = 1, cur = 1;
    for (var i = 1; i < yms.length; i++) {
      if (yms[i] === yms[i - 1] + 1) { cur++; if (cur > best) best = cur; }
      else cur = 1;
    }
    return best;
  }

  // Compute the churn status of every included contact for the given thresholds.
  function computeChurn(tenure, gapThresh) {
    var result = [];
    allContactNames.forEach(function (name) {
      var yms = activeYmsByContact[name];
      if (!yms || !yms.length) return;
      var k = normC(name);
      var lastYm = yms[yms.length - 1];
      var firstYm = yms[0];
      var streak = longestStreak(yms);
      var activeMonths = yms.length;

      // ── Revenue: lifetime total + monthly run-rate (avg of last up-to-3 active months) ──
      var perYm = revByContactYm[name] || {};
      var totalRev = 0;
      yms.forEach(function (v) { totalRev += (perYm[v] || 0); });
      var lastN = yms.slice(-3);
      var runRate = lastN.length ? lastN.reduce(function (s, v) { return s + (perYm[v] || 0); }, 0) / lastN.length : 0;
      var annualRev = runRate * 12;

      // ── Rhythm: longest gap the customer previously BRIDGED (came back from). A
      //    quarterly customer bridges ~3-month gaps, so a 2-month silence is normal
      //    for them — only a silence LONGER than their rhythm counts as churn. ──
      var maxRecoveredGap = 1;
      for (var gi = 1; gi < yms.length; gi++) {
        var g = yms[gi] - yms[gi - 1];
        if (g > maxRecoveredGap) maxRecoveredGap = g;
      }
      var effectiveGap = Math.max(gapThresh, maxRecoveredGap + 1);

      var isProject = !!projectContacts[k];
      var qualified = streak >= tenure && !isProject;
      var gap = latestDataYm - lastYm;

      var manual = manualByContact[k];
      var churned = false, churnYm = null, source = 'auto', reason = '', atRisk = false;

      if (manual && manual.status === 'active') {
        // Fehlalarm unterdrückt — nie Churn, nie gefährdet.
        churned = false; atRisk = false; source = 'manual';
      } else if (manual && manual.status === 'churned') {
        churned = true; source = 'manual';
        reason = manual.reason || '';
        churnYm = manual.churn_date ? ym(parseInt(manual.churn_date.slice(0, 4), 10), parseInt(manual.churn_date.slice(5, 7), 10)) : (lastYm + 1);
      } else {
        // Automatik: Churn erst, wenn die Stille die bisherige Rhythmus-Pause übersteigt.
        if (qualified && gap >= effectiveGap) { churned = true; churnYm = lastYm + 1; }
        else if (qualified && gap >= 1 && gap === effectiveGap - 1) { atRisk = true; }
      }

      result.push({
        name: name, churned: churned, churnYm: churnYm, source: source, reason: reason,
        lastYm: lastYm, firstYm: firstYm, streak: streak, activeMonths: activeMonths,
        totalRev: totalRev, runRate: runRate, annualRev: annualRev,
        isProject: isProject, qualified: qualified, gap: gap, atRisk: atRisk,
        maxRecoveredGap: maxRecoveredGap, effectiveGap: effectiveGap,
        manual: manual || null,
      });
    });
    return result;
  }

  // Is customer c "active" as of the start of month `pt` — i.e. their last invoice
  // before `pt` is within their rhythm window? (Ignores tenure/qualification.)
  function activeAsOf(c, pt) {
    if (c.isProject) return false;
    var yms = activeYmsByContact[c.name];
    var lastBefore = -1;
    for (var i = yms.length - 1; i >= 0; i--) { if (yms[i] < pt) { lastBefore = yms[i]; break; } }
    if (lastBefore < 0) return false;
    return (pt - lastBefore) <= c.effectiveGap;
  }

  // Count of qualified, non-project customers active as of the start of month `pt`.
  // Denominator for the per-month churn rate in the chart.
  function activeBaseAt(pt, list, tenure) {
    var n = 0;
    list.forEach(function (c) { if (c.streak >= tenure && activeAsOf(c, pt)) n++; });
    return n;
  }

  // Denominator for the ANNUAL churn rate: every qualified, non-project customer who
  // was a "live" customer at any point in `year` — i.e. active entering the year OR
  // active in any month of the year (= Bestand zu Jahresbeginn + im Jahr neu gewonnen).
  // Any customer churned in the year is guaranteed to be included, so numerator ⊆ base.
  function yearActiveBase(year, list, tenure, churnedInYear) {
    var yStart = year * 12;
    var names = {};
    list.forEach(function (c) {
      if (c.isProject || c.streak < tenure) return;
      var yms = activeYmsByContact[c.name];
      var activeInYear = yms.some(function (v) { return ymY(v) === year; });
      if (activeInYear || activeAsOf(c, yStart)) names[c.name] = 1;
    });
    churnedInYear.forEach(function (c) { names[c.name] = 1; }); // safety: keep numerator ⊆ base
    return Object.keys(names).length;
  }

  // ── Render ─────────────────────────────────────────────────────────
  function render() {
    var tenure = Math.max(1, parseInt(tenureInput.value, 10) || 4);
    var gapThresh = Math.max(1, parseInt(gapInput.value, 10) || 2);
    var year = parseInt(yearSelect.value, 10);

    document.querySelectorAll('.kpiYearLabel').forEach(function (el) { el.textContent = year; });
    document.querySelectorAll('.ruleTenure').forEach(function (el) { el.textContent = tenure; });
    document.querySelectorAll('.ruleGap').forEach(function (el) { el.textContent = gapThresh; });

    var all = computeChurn(tenure, gapThresh);

    // Caveat: last data month possibly incomplete
    caveatBox.innerHTML = latestDataYm !== null
      ? '<div class="caveat-box">ℹ️ Letzter Datenmonat: <strong>' + ymLabel(latestDataYm) + '</strong>. Ganz frische „Churns" (Rechnung evtl. nur verspätet) mit Vorsicht lesen.</div>'
      : '';

    renderExcludeNote(year);

    // Churned in the selected year
    var churnedInYear = all.filter(function (c) { return c.churned && c.churnYm !== null && ymY(c.churnYm) === year; });
    churnedInYear.sort(function (a, b) { return a.churnYm - b.churnYm || a.name.localeCompare(b.name, 'de'); });

    // Annual churn rate: all churns in year ÷ all customers we had in the year
    // (Bestand zu Jahresbeginn + im Jahr neu gewonnen). Same cohort in both.
    var yearBase = yearActiveBase(year, all, tenure, churnedInYear);
    var churnRate = yearBase > 0 ? (churnedInYear.length / yearBase * 100) : null;

    // Monthly active base (denominator for per-month churn rate) for the chart
    var monthlyBase = [];
    for (var mo = 0; mo < 12; mo++) monthlyBase.push(activeBaseAt(year * 12 + mo, all, tenure));

    // KPIs
    document.getElementById('kpiChurned').textContent = fmtInt(churnedInYear.length);
    document.getElementById('kpiChurnRate').textContent = churnRate !== null ? churnRate.toFixed(1) + ' %' : '—';
    document.getElementById('kpiChurnRateHint').textContent = yearBase > 0
      ? churnedInYear.length + ' verloren ÷ ' + yearBase + ' Kunden im Jahr (Bestand + Neuzugänge)'
      : 'keine Kunden im Jahr';

    var avgTenure = churnedInYear.length ? churnedInYear.reduce(function (s, c) { return s + c.activeMonths; }, 0) / churnedInYear.length : 0;
    document.getElementById('kpiAvgTenure').textContent = churnedInYear.length ? avgTenure.toFixed(1) + ' Mon.' : '—';

    // Verlorener Umsatz: annualisierte Run-Rate der Churn-Kunden aufsummiert
    var lostAnnual  = churnedInYear.reduce(function (s, c) { return s + (c.annualRev || 0); }, 0);
    var lostMonthly = churnedInYear.reduce(function (s, c) { return s + (c.runRate || 0); }, 0);
    document.getElementById('kpiLostRev').textContent     = churnedInYear.length ? fmt(lostAnnual) : '—';
    document.getElementById('kpiLostRevHint').textContent = churnedInYear.length
      ? fmt(lostMonthly) + ' / Monat (Run-Rate) · annualisiert ×12'
      : 'annualisierte Run-Rate der verlorenen Kunden';

    // Active now / at risk (state as of latest data month)
    var activeNow = all.filter(function (c) { return !c.churned && !c.isProject && c.qualified && c.gap < c.effectiveGap; }).length;
    var atRiskList = all.filter(function (c) { return c.atRisk; }).sort(function (a, b) { return b.lastYm - a.lastYm || a.name.localeCompare(b.name, 'de'); });
    document.getElementById('kpiActiveNow').textContent = fmtInt(activeNow);
    document.getElementById('kpiActiveNowHint').textContent = 'Rechnung innerhalb ihres normalen Rhythmus';
    document.getElementById('kpiAtRisk').textContent = fmtInt(atRiskList.length);

    // Month drill-down: table shows either the whole year or just the clicked month
    if (monthFilter !== null && ymY(monthFilter) !== year) monthFilter = null; // year changed
    var tableList = monthFilter !== null
      ? churnedInYear.filter(function (c) { return c.churnYm === monthFilter; })
      : churnedInYear;
    renderMonthFilterBar(churnedInYear.length, tableList);
    renderChurnTable(tableList);
    renderAtRisk(atRiskList);
    renderChart(churnedInYear, year, monthlyBase);
    populateContactDatalist();
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
        monthList.length + ' Kunde' + (monthList.length === 1 ? '' : 'n') + ' gechurnt — ' + names + '</div>' +
      '<button id="clearMonthFilter" class="btn btn-ghost btn-sm" style="padding:2px 10px;white-space:nowrap">alle Monate (' + totalInYear + ')</button>' +
      '</div>';
    var btn = document.getElementById('clearMonthFilter');
    if (btn) btn.addEventListener('click', function () { monthFilter = null; render(); });
  }

  function reasonLabel(c) {
    if (c.reason) return escHtml(c.reason);
    if (c.source === 'manual') return '<span style="color:var(--text-secondary)">manuell</span>';
    return '<span style="color:var(--text-secondary)">— (' + c.gap + ' Mon. ohne Rechnung)</span>';
  }

  function renderChurnTable(list) {
    churnBody.innerHTML = '';
    if (!list.length) { churnEmpty.classList.remove('hidden'); return; }
    churnEmpty.classList.add('hidden');
    list.forEach(function (c) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td style="font-weight:500">' + escHtml(c.name) + '</td>' +
        '<td>' + ymLabel(c.lastYm) + '</td>' +
        '<td>' + (c.churnYm !== null ? ymLabel(c.churnYm) : '—') + '</td>' +
        '<td class="right">' + c.activeMonths + ' Mon.</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt(c.runRate) + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums;font-weight:600">' + fmt(c.annualRev) + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums;color:var(--text-secondary)">' + fmt(c.totalRev) + '</td>' +
        '<td>' + (c.source === 'manual' ? '<span class="tag tag-manual">manuell</span>' : '<span class="tag tag-auto">automatisch</span>') + '</td>' +
        '<td style="font-size:12px">' + reasonLabel(c) + '</td>' +
        '<td class="center"><div style="display:flex;gap:6px;justify-content:center">' +
          '<button class="btn btn-ghost btn-sm edit-churn">Bearbeiten</button>' +
          '<button class="btn btn-secondary btn-sm keep-active" title="Doch aktiv – Churn zurücknehmen">Doch aktiv</button>' +
        '</div></td>';
      tr.querySelector('.edit-churn').addEventListener('click', function () { openChurnModal(c.name, c.manual); });
      tr.querySelector('.keep-active').addEventListener('click', function () { markActive(c.name); });
      churnBody.appendChild(tr);
    });
  }

  function renderAtRisk(list) {
    atRiskBody.innerHTML = '';
    if (!list.length) { atRiskEmpty.classList.remove('hidden'); return; }
    atRiskEmpty.classList.add('hidden');
    list.forEach(function (c) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td style="font-weight:500">' + escHtml(c.name) + ' <span class="tag tag-risk">gefährdet</span></td>' +
        '<td>' + ymLabel(c.lastYm) + '</td>' +
        '<td class="right">' + c.activeMonths + ' Mon.</td>' +
        '<td class="center"><div style="display:flex;gap:6px;justify-content:center">' +
          '<button class="btn btn-danger btn-sm mark-churn">Als Churn eintragen</button>' +
          '<button class="btn btn-secondary btn-sm keep-active2" title="Alles gut, weiter aktiv">Doch aktiv</button>' +
        '</div></td>';
      tr.querySelector('.mark-churn').addEventListener('click', function () { openChurnModal(c.name, null); });
      tr.querySelector('.keep-active2').addEventListener('click', function () { markActive(c.name); });
      atRiskBody.appendChild(tr);
    });
  }

  function renderChart(churnedInYear, year, monthlyBase) {
    var ctx = document.getElementById('churnChart');
    if (!ctx) return;
    var counts = new Array(12).fill(0);
    var revenue = new Array(12).fill(0);
    churnedInYear.forEach(function (c) {
      if (c.churnYm === null) return;
      var m = ymM(c.churnYm) - 1;
      counts[m]++;
      revenue[m] += (c.annualRev || 0);
    });
    // Monthly churn rate = churned that month ÷ customers active entering that month.
    var base = monthlyBase || new Array(12).fill(0);
    var rate = counts.map(function (n, i) { return base[i] > 0 ? (n / base[i] * 100) : 0; });

    var mode = chartMode; // 'rate' | 'count' | 'revenue'
    var label = mode === 'revenue' ? 'Verlorener Umsatz p.a.' : mode === 'count' ? 'Verlorene Kunden' : 'Churn-Rate';
    var data = mode === 'revenue' ? revenue.map(function (v) { return Math.round(v); })
             : mode === 'count'   ? counts
             : rate.map(function (v) { return Math.round(v * 10) / 10; });

    if (churnChart) churnChart.destroy();
    churnChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: MONTHS_LABEL,
        datasets: [{
          label: label,
          data: data,
          backgroundColor: data.map(function (_, i) {
            return (monthFilter !== null && ymM(monthFilter) - 1 === i) ? '#b91c1c' : '#ef4444';
          }),
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        onClick: function (evt) {
          var pts = churnChart.getElementsAtEventForMode(evt, 'nearest', { intersect: false }, false);
          if (!pts.length) return;
          var mIdx = pts[0].index;
          var clickedYm = ym(year, mIdx + 1);
          if ((counts[mIdx] || 0) === 0) return; // nothing to drill into
          monthFilter = (monthFilter === clickedYm) ? null : clickedYm; // toggle
          render();
        },
        onHover: function (evt, els) { evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (item) {
            var i = item.dataIndex;
            if (mode === 'revenue') return 'Verlorener Umsatz p.a.: ' + fmt(item.parsed.y);
            if (mode === 'count')   return item.parsed.y + ' Kunde' + (item.parsed.y === 1 ? '' : 'n');
            return 'Churn-Rate: ' + item.parsed.y.toLocaleString('de-DE') + ' %  (' + counts[i] + ' von ' + base[i] + ' aktiv)';
          } } },
        },
        scales: { y: { beginAtZero: true, ticks:
            mode === 'revenue' ? { callback: function (v) { return (v / 1000).toLocaleString('de-DE') + 'k €'; } }
          : mode === 'rate'    ? { callback: function (v) { return v + ' %'; } }
          :                      { precision: 0 } } },
      },
    });
  }

  function renderExcludeNote(year) {
    var ppc = [], glob = [];
    // first active ym per contact over ALL revenue (incl. excluded) to know cohort year
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
      'ℹ️ Aus der Churn-Analyse ausgeschlossen (konsistent mit CAC/Umsatzanalyse, via <a href="name-mapping.html">Zuordnung</a>): ' +
      parts.join(' · ') + '. Umschalten dort.</div>';
  }

  function populateContactDatalist() {
    var dl = document.getElementById('churnContactList');
    if (!dl) return;
    dl.innerHTML = allContactNames.map(function (n) { return '<option value="' + escHtml(n) + '">'; }).join('');
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

  // ── Manual churn modal ─────────────────────────────────────────────
  var churnModal        = document.getElementById('churnModal');
  var churnModalTitle   = document.getElementById('churnModalTitle');
  var churnContactInput = document.getElementById('churnContactInput');
  var churnDateInput    = document.getElementById('churnDateInput');
  var churnDateField    = document.getElementById('churnDateField');
  var churnReasonInput  = document.getElementById('churnReasonInput');
  var churnNotesInput   = document.getElementById('churnNotesInput');
  var churnModalDelete  = document.getElementById('churnModalDelete');

  function statusRadio() { return document.querySelector('input[name="churnStatus"]:checked').value; }
  function setStatusRadio(v) { document.querySelectorAll('input[name="churnStatus"]').forEach(function (r) { r.checked = (r.value === v); }); toggleDateField(); }
  function toggleDateField() { churnDateField.style.display = statusRadio() === 'churned' ? '' : 'none'; }
  document.querySelectorAll('input[name="churnStatus"]').forEach(function (r) { r.addEventListener('change', toggleDateField); });

  function openChurnModal(contactName, existing) {
    churnModalTitle.textContent = existing ? 'Churn-Eintrag bearbeiten' : 'Churn manuell eintragen';
    churnContactInput.value = contactName || '';
    churnContactInput.disabled = !!contactName; // locked when opened from a row
    setStatusRadio(existing ? existing.status : 'churned');
    churnDateInput.value   = existing && existing.churn_date ? existing.churn_date : '';
    churnReasonInput.value = existing && existing.reason ? existing.reason : '';
    churnNotesInput.value  = existing && existing.notes ? existing.notes : '';
    churnModalDelete.style.visibility = existing ? 'visible' : 'hidden';
    churnModal.classList.remove('hidden');
    if (!contactName) churnContactInput.focus();
  }
  function closeChurnModal() { churnModal.classList.add('hidden'); }

  document.getElementById('addChurnBtn').addEventListener('click', function () { openChurnModal('', null); });
  document.getElementById('churnModalClose').addEventListener('click', closeChurnModal);
  document.getElementById('churnModalCancel').addEventListener('click', closeChurnModal);
  churnModal.addEventListener('click', function (e) { if (e.target === churnModal) closeChurnModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeChurnModal(); });

  function saveManual(contactName, status, churnDate, reason, notes) {
    return window.db.churnEvents.set(contactName, status, churnDate, reason, notes);
  }

  document.getElementById('churnModalSave').addEventListener('click', function () {
    var name = churnContactInput.value.trim();
    if (!name) { churnContactInput.focus(); churnContactInput.style.borderColor = 'var(--danger)'; return; }
    churnContactInput.style.borderColor = '';
    var status = statusRadio();
    var btn = document.getElementById('churnModalSave');
    btn.disabled = true; btn.textContent = 'Speichern…';
    saveManual(name, status, status === 'churned' ? (churnDateInput.value || null) : null, churnReasonInput.value.trim() || null, churnNotesInput.value.trim() || null)
      .then(function () { closeChurnModal(); loadData(); })
      .catch(function (e) { showError('Fehler: ' + e.message); })
      .finally(function () { btn.disabled = false; btn.textContent = 'Speichern'; });
  });

  churnModalDelete.addEventListener('click', function () {
    var name = churnContactInput.value.trim();
    if (!name) return;
    churnModalDelete.disabled = true;
    window.db.churnEvents.remove(name)
      .then(function () { closeChurnModal(); loadData(); })
      .catch(function (e) { showError('Fehler: ' + e.message); })
      .finally(function () { churnModalDelete.disabled = false; });
  });

  function markActive(contactName) {
    saveManual(contactName, 'active', null, null, null)
      .then(function () { loadData(); })
      .catch(function (e) { showError('Fehler: ' + e.message); });
  }

  // ── Boot ───────────────────────────────────────────────────────────
  yearSelect.addEventListener('change', render);
  tenureInput.addEventListener('change', render);
  gapInput.addEventListener('change', render);

  // Chart mode toggle (Churn % ↔ Anzahl ↔ Umsatz)
  var CHART_MODE_BTNS = [['chartModeRate', 'rate'], ['chartModeCount', 'count'], ['chartModeRevenue', 'revenue']];
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
      (window.db.churnEvents ? window.db.churnEvents.listAll() : Promise.resolve([])).catch(function () { return []; }),
      window.db.clients.list(),
    ]).then(function (res) {
      allRevenue   = res[0] || [];
      allOverrides = res[1] || [];
      allChurn     = res[2] || [];
      allClients   = res[3] || [];
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
