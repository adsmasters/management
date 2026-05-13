(function () {
  'use strict';

  const yearSel   = document.getElementById('yearSelect');
  const loadBtn   = document.getElementById('loadBtn');
  const syncBtn   = document.getElementById('syncBtn');
  const tableWrap = document.getElementById('tableWrap');
  const tbody     = document.getElementById('clientsBody');
  const loadingEl = document.getElementById('loading');
  const errorEl   = document.getElementById('error');
  const setupHint = document.getElementById('setupHint');
  const summaryEl = document.getElementById('summary');
  const emptyEl   = document.getElementById('emptyClients');

  // ── Working-day helpers ───────────────────────────────────────────────
  // Count Mon–Fri days in a given year/month
  function totalWorkDays(year, month) {
    const days = new Date(year, month, 0).getDate(); // days in month
    let count = 0;
    for (let d = 1; d <= days; d++) {
      const dow = new Date(year, month - 1, d).getDay();
      if (dow >= 1 && dow <= 5) count++;
    }
    return count;
  }

  // Count Mon–Fri days from 1st up to and including `upToDay`
  function elapsedWorkDays(year, month, upToDay) {
    let count = 0;
    for (let d = 1; d <= upToDay; d++) {
      const dow = new Date(year, month - 1, d).getDay();
      if (dow >= 1 && dow <= 5) count++;
    }
    return count;
  }

  // ── Contract start helpers ────────────────────────────────────────────
  // Sum up effective budget for a client over all active months (incl. per-month corrections)
  // For the current month the budget is pro-rated by elapsed working days / total working days
  function effectiveBudget(client, adjs, year, maxMonth) {
    const today = new Date();
    const todayY = today.getFullYear();
    const todayM = today.getMonth() + 1;
    const todayD = today.getDate();

    let amB = client.am_budget  != null ? 0 : null;
    let advB = client.adv_budget != null ? 0 : null;
    for (let m = 1; m <= maxMonth; m++) {
      const d = new Date(client.contract_start || '2000-01-01');
      const csY = client.contract_start ? d.getUTCFullYear() : 0;
      const csM = client.contract_start ? d.getUTCMonth() + 1 : 1;
      if (csY > year || (csY === year && m < csM)) continue;
      if (client.is_project && client.project_end) {
        const pe  = new Date(client.project_end);
        const peY = pe.getUTCFullYear(), peM = pe.getUTCMonth() + 1;
        if (year > peY || (year === peY && m > peM)) continue;
      }
      // Pro-rate current month by elapsed working days
      let ratio = 1;
      if (year === todayY && m === todayM) {
        const total   = totalWorkDays(year, m);
        const elapsed = elapsedWorkDays(year, m, todayD);
        ratio = total > 0 ? elapsed / total : 1;
      }

      if (amB  != null) amB  += client.am_budget  * ratio;
      if (advB != null) advB += client.adv_budget * ratio;
    }
    return { amB, advB };
  }

  function adjTotalHours(adjs, maxMonth) {
    let amAdj = 0, advAdj = 0;
    for (let m = 1; m <= maxMonth; m++) {
      const a = adjs[m];
      if (a) { amAdj += a.am_hours || 0; advAdj += a.adv_hours || 0; }
    }
    return { amAdj, advAdj };
  }

  function effectiveMonths(client, year, maxMonth) {
    // Determine start month for this year
    let startM = 1;
    if (client.contract_start) {
      const d   = new Date(client.contract_start);
      const csY = d.getUTCFullYear();
      const csM = d.getUTCMonth() + 1;
      if (csY > year) return 0;
      if (csY === year) startM = csM;
    }
    // Determine end month for this year
    let endM = maxMonth;
    if (client.is_project && client.project_end) {
      const d   = new Date(client.project_end);
      const peY = d.getUTCFullYear();
      const peM = d.getUTCMonth() + 1;
      if (peY < year) return 0;                        // project ended before this year
      if (peY === year) endM = Math.min(maxMonth, peM); // cap at project end
    }
    return Math.max(0, endM - startM + 1);
  }

  // ── Sort state ────────────────────────────────────────────────────────
  let sortCol = null; // 'name' | 'am' | 'adv' | 'total' | 'diff'
  let sortDir = 'desc';
  let lastRows     = [];
  let lastMaxMonth = 12;

  function sortRows(rows, maxMonth) {
    if (!sortCol) return rows;
    return rows.slice().sort(function (a, b) {
      let va, vb;
      const ac = a.client, bc = b.client;
      const aa = a.agg,    ba = b.agg;
      if (sortCol === 'name') {
        va = ac.name.toLowerCase();
        vb = bc.name.toLowerCase();
      } else if (sortCol === 'am') {
        va = aa.amTotal; vb = ba.amTotal;
      } else if (sortCol === 'adv') {
        va = aa.advH; vb = ba.advH;
      } else if (sortCol === 'total') {
        va = aa.amTotal + aa.advH;
        vb = ba.amTotal + ba.advH;
      } else if (sortCol === 'diff') {
        const aEff = effectiveBudget(ac, a.adjs, parseInt(yearSel.value), maxMonth);
        const bEff = effectiveBudget(bc, b.adjs, parseInt(yearSel.value), maxMonth);
        const aBdg = (aEff.amB || 0) + (aEff.advB || 0);
        const bBdg = (bEff.amB || 0) + (bEff.advB || 0);
        va = (aa.amTotal + aa.advH) - aBdg;
        vb = (ba.amTotal + ba.advH) - bBdg;
      }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ?  1 : -1;
      return 0;
    });
  }

  function updateSortHeaders() {
    document.querySelectorAll('thead th[data-sort]').forEach(function (th) {
      const ind = th.querySelector('.sort-ind');
      if (!ind) return;
      if (th.dataset.sort === sortCol) {
        ind.textContent = sortDir === 'asc' ? ' ↑' : ' ↓';
        th.style.color = 'var(--primary)';
      } else {
        ind.textContent = ' ↕';
        th.style.color = '';
      }
    });
  }

  // Wire up header clicks (after DOM ready)
  document.querySelectorAll('thead th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      const col = th.dataset.sort;
      if (sortCol === col) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortCol = col;
        sortDir = col === 'name' ? 'asc' : 'desc';
      }
      renderTable(lastRows, parseInt(yearSel.value), lastMaxMonth);
      updateSortHeaders();
    });
    // Show idle indicator
    const ind = th.querySelector('.sort-ind');
    if (ind) ind.textContent = ' ↕';
  });

  // ── Init year select ──────────────────────────────────────────────────
  (function initSelects() {
    const ym = window.currentYearMonth();
    for (let y = ym.year; y >= ym.year - 4; y--) {
      const o = document.createElement('option');
      o.value = y; o.textContent = y;
      yearSel.appendChild(o);
    }
  })();

  // ── State helpers ─────────────────────────────────────────────────────
  function showLoading(msg) {
    loadingEl.innerHTML = `<div class="loading-bar"><div class="spinner"></div>${msg || 'Lade Daten…'}</div>`;
    loadingEl.classList.remove('hidden');
    tableWrap.classList.add('hidden');
    summaryEl.classList.add('hidden');
    emptyEl.classList.add('hidden');
    errorEl.innerHTML = '';
  }
  function hideLoading() { loadingEl.classList.add('hidden'); }
  function showError(msg) {
    errorEl.innerHTML = `<div class="alert alert-danger">⚠️ ${msg}</div>`;
    loadingEl.classList.add('hidden');
  }
  function showWarn(msg) {
    errorEl.innerHTML = `<div class="alert alert-warn">⚠️ ${msg}</div>`;
  }

  // ── Load data ─────────────────────────────────────────────────────────
  function loadData() {
    showLoading();
    const year = parseInt(yearSel.value);
    const ym   = window.currentYearMonth();
    // For the current year only count months up to today
    const maxMonth = (year === ym.year) ? ym.month : 12;

    Promise.all([
      window.db.clients.list(),
      window.db.entries.forYear(year),
      window.db.adjustments.forYear(year),
    ]).then(([clients, entries, allAdjs]) => {

      // Index adjustments by client_id → month
      const adjByClient = {};
      allAdjs.forEach(a => {
        if (!adjByClient[a.client_id]) adjByClient[a.client_id] = {};
        adjByClient[a.client_id][a.month] = a;
      });

      if (!clients.length) {
        hideLoading();
        emptyEl.classList.remove('hidden');
        return;
      }

      // Filter entries to completed months only (for current year)
      const visibleEntries = entries.filter(e => e.month <= maxMonth);

      // Group entries by client
      const entriesByClient = {};
      visibleEntries.forEach(e => {
        if (!entriesByClient[e.client_id]) entriesByClient[e.client_id] = [];
        entriesByClient[e.client_id].push(e);
      });

      const rows = clients.map(c => ({
        client:  c,
        entries: entriesByClient[c.id] || [],
        agg:     window.aggregateEntries(entriesByClient[c.id] || []),
        adjs:    adjByClient[c.id] || {},
      }));

      // Cache for re-sorting without reload
      lastRows     = rows;
      lastMaxMonth = maxMonth;

      // Update table header with period
      const ym2 = window.currentYearMonth();
      const periodLabel2 = (year === ym2.year && maxMonth < 12)
        ? `Jan – ${window.MONTHS_DE[maxMonth - 1].slice(0,3)} ${year}`
        : `${year}`;
      const thAmSub  = document.getElementById('thAmSub');
      const thAdvSub = document.getElementById('thAdvSub');
      if (thAmSub)  thAmSub.textContent  = periodLabel2 + ' · inkl. FL÷3';
      if (thAdvSub) thAdvSub.textContent = periodLabel2;

      renderTable(rows, year, maxMonth);
      renderSummary(rows, year, maxMonth);
      updateSortHeaders();
      hideLoading();
      tableWrap.classList.remove('hidden');
      summaryEl.classList.remove('hidden');
    }).catch(e => {
      showError(e.message === 'NOT_CONFIGURED'
        ? 'Keine Supabase-Verbindung. Bitte <a href="settings.html">Einstellungen</a> prüfen.'
        : 'Fehler: ' + e.message);
    });
  }

  // ── Render table ──────────────────────────────────────────────────────
  function renderTable(rows, year, maxMonth) {
    tbody.innerHTML = '';
    const sorted = sortRows(rows, maxMonth);

    sorted.forEach((row, i) => {
      const { client: c, entries: clientEntries, agg, adjs } = row;
      const { amH, advH, flH, amTotal, breakdown } = agg;

      // Budget = monthly budget × effective months (pure, no adj)
      const { amB: annualAmBdg, advB: annualAdvBdg } = effectiveBudget(c, adjs, year, maxMonth);

      // Subtract adjustment hours from tracked hours
      const { amAdj, advAdj } = adjTotalHours(adjs, maxMonth);
      const amEff  = Math.max(0, amTotal - amAdj);
      const advEff = Math.max(0, advH    - advAdj);

      const amDiff  = annualAmBdg  != null ? amEff - annualAmBdg  : null;
      const advDiff = annualAdvBdg != null ? advEff - annualAdvBdg : null;
      const amOver  = amDiff  != null && amDiff  > 0.05;
      const advOver = advDiff != null && advDiff > 0.05;
      const amOk    = amDiff  != null && amDiff  <= 0.05;
      const advOk   = advDiff != null && advDiff <= 0.05;

      const total     = amEff + advEff;
      const hasBudget = c.am_budget != null || c.adv_budget != null;
      const totalBdg  = (annualAmBdg || 0) + (annualAdvBdg || 0);
      const totalDiff = hasBudget ? total - totalBdg : null;

      const overBadges = [];
      if (amOver)  overBadges.push('<span class="badge badge-over">Account Mgmt</span>');
      if (advOver) overBadges.push('<span class="badge badge-over">Advertising</span>');
      const overHtml = overBadges.length
        ? `<div class="over-badges">${overBadges.join('')}</div>`
        : !hasBudget
          ? '<span class="text-muted" style="font-size:12px">kein Budget</span>'
          : '<span class="badge badge-ok">✓ Im Budget</span>';

      const expandId = `am-expand-${i}`;
      const btnId    = `am-btn-${i}`;
      const hasAMData = breakdown.some(b => b.role === 'account_manager' || b.role === 'freelancer');

      const amCellContent = hasAMData
        ? `<button class="expand-btn" id="${btnId}" data-target="${expandId}">
             ${window.svgChevron()} ${window.fmtHours(amEff)}
           </button>
           ${amDiff != null ? `<div style="font-size:11.5px">${window.fmtDiff(amDiff).text}</div>` : ''}`
        : `<div class="cell-hours">
             <span class="h-main">${window.fmtHours(amEff)}</span>
             ${amDiff != null ? `<span class="h-diff">${window.fmtDiff(amDiff).text}</span>` : ''}
           </div>`;

      const totalDiffStr = totalDiff != null
        ? `<div style="font-size:11.5px">${window.fmtDiff(totalDiff).text}</div>` : '';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <a class="client-link" href="detail.html?id=${encodeURIComponent(c.id)}&name=${encodeURIComponent(c.name)}">
            ${c.name} <span class="arrow">${window.svgArrow()}</span>
          </a>
        </td>
        <td class="right ${amOver ? 'cell-over' : amOk ? 'cell-ok' : ''}">${amCellContent}</td>
        <td class="right ${advOver ? 'cell-over' : advOk ? 'cell-ok' : ''}">
          <div class="cell-hours">
            <span class="h-main">${window.fmtHours(advEff)}</span>
            ${advDiff != null ? `<span class="h-diff">${window.fmtDiff(advDiff).text}</span>` : ''}
          </div>
        </td>
        <td class="right mono">${window.fmtHours(total)}</td>
        <td class="right mono ${totalDiff != null && totalDiff > 0.05 ? 'diff-over' : totalDiff != null && totalDiff < -0.05 ? 'diff-under' : ''}" style="font-weight:600">
          ${totalDiff != null ? window.fmtDiff(totalDiff).text : '<span class="text-muted">—</span>'}
        </td>
        <td class="center">${overHtml}</td>
        <td class="center" style="white-space:nowrap">
          <a class="btn btn-ghost btn-sm" href="detail.html?id=${encodeURIComponent(c.id)}&name=${encodeURIComponent(c.name)}">
            Details ${window.svgArrow()}
          </a>
          <button class="btn btn-ghost btn-sm adj-open-btn" style="margin-left:4px" title="Stundenanpassungen">±</button>
        </td>`;

      tbody.appendChild(tr);

      tr.querySelector('.adj-open-btn')?.addEventListener('click', () => {
        openAdjModal(c, adjs, year, maxMonth);
      });

      // AM breakdown sub-row
      if (hasAMData) {
        const amItems = breakdown.filter(b => b.role === 'account_manager' || b.role === 'freelancer');
        const amBreakdown = amItems.map(b => {
          const isFL    = b.role === 'freelancer';
          const counted = isFL ? b.hours / 3 : b.hours;
          return `<span class="am-breakdown-item">
            <span class="am-tag ${window.getRoleCls(b.role)}">${window.getRoleShort(b.role)}</span>
            <span class="emp-hours">${window.fmtHours(b.hours)}</span>
            <span>${b.name}</span>
            ${isFL ? `<span class="fl-divider">÷3 = ${window.fmtHours(counted)}</span>` : ''}
          </span>`;
        }).join('');

        const detailTr = document.createElement('tr');
        detailTr.id        = expandId;
        detailTr.className = 'am-breakdown-row hidden';
        detailTr.innerHTML = `<td colspan="6"><div class="am-breakdown-inner">${amBreakdown}</div></td>`;
        tbody.appendChild(detailTr);

        tr.querySelector(`#${btnId}`)?.addEventListener('click', e => {
          e.stopPropagation();
          const btn  = document.getElementById(btnId);
          const dest = document.getElementById(expandId);
          const open = btn.classList.toggle('open');
          dest.classList.toggle('hidden', !open);
        });
      }
    });
  }

  // ── Summary stats ─────────────────────────────────────────────────────
  function renderSummary(rows, year, maxMonth) {
    let totAm = 0, totAdv = 0, totalBudget = 0, clientsOver = 0;
    let hasBudget = false;
    rows.forEach(({ client: c, agg, adjs }) => {
      totAm  += agg.amTotal;
      totAdv += agg.advH;
      const { amB: periodAmBdg, advB: periodAdvBdg } = effectiveBudget(c, adjs, year, maxMonth);
      if (periodAmBdg != null || periodAdvBdg != null) {
        hasBudget = true;
        totalBudget += (periodAmBdg || 0) + (periodAdvBdg || 0);
        if ((periodAmBdg  != null && agg.amTotal > periodAmBdg  + 0.05) ||
            (periodAdvBdg != null && agg.advH    > periodAdvBdg + 0.05)) clientsOver++;
      }
    });
    const total = totAm + totAdv;
    const diff  = hasBudget ? total - totalBudget : null;
    const diffR = diff != null ? window.fmtDiff(diff) : { text: '—', cls: 'zero' };

    // Period label e.g. "Jan – Apr 2026" or "2025"
    const periodLabel = maxMonth < 12
      ? `${window.MONTHS_DE[0].slice(0,3)} – ${window.MONTHS_DE[maxMonth - 1].slice(0,3)} ${year}`
      : `${year}`;

    summaryEl.innerHTML = `
      <div class="stats-row">
        <div class="stat-card"><div class="label">Account Mgmt (${periodLabel})</div><div class="value">${window.fmtHours(totAm)}</div></div>
        <div class="stat-card"><div class="label">Advertising (${periodLabel})</div><div class="value">${window.fmtHours(totAdv)}</div></div>
        <div class="stat-card"><div class="label">Gesamt (${periodLabel})</div><div class="value">${window.fmtHours(total)}</div></div>
        ${hasBudget ? `
        <div class="stat-card"><div class="label">Differenz Budget (${periodLabel})</div>
          <div class="value ${diffR.cls === 'positive' ? 'over' : diffR.cls === 'negative' ? 'under' : ''}">${diffR.text}</div></div>
        <div class="stat-card"><div class="label">Kunden über Budget</div>
          <div class="value ${clientsOver > 0 ? 'over' : ''}">${clientsOver} / ${rows.length}</div></div>` : ''}
      </div>`;
  }

  // ── Clockify year sync ────────────────────────────────────────────────
  function norm(str) { return (str || '').trim().toLowerCase(); }

  async function syncFromClockify() {
    if (!window.clockify.isConfigured()) {
      showError('Clockify nicht verbunden. Bitte zuerst in den <a href="settings.html">Einstellungen</a> den API Key eintragen.');
      return;
    }

    const year = parseInt(yearSel.value);
    const ym   = window.currentYearMonth();
    // Sync all months up to current month for current year, all 12 for past years
    const maxMonth = year < ym.year ? 12 : ym.month;

    syncBtn.disabled = true;
    errorEl.innerHTML = '';

    try {
      // Load clients + employees in parallel
      const [clients, employees] = await Promise.all([
        window.db.clients.list(),
        window.db.employees.listActive(),
      ]);

      const clientMap   = {};
      clients.forEach(c   => { clientMap[norm(c.name)]   = c; });
      const employeeMap = {};
      employees.forEach(e => { employeeMap[norm(e.name)] = e; });

      const saves     = [];
      const unmatched = { clients: new Set(), users: new Set() };
      let   matched   = 0;

      // Fetch all months sequentially with progress
      for (let m = 1; m <= maxMonth; m++) {
        syncBtn.textContent = `Synchronisiere ${window.MONTHS_DE[m - 1]}… (${m}/${maxMonth})`;

        // Fetch client-breakdown, user-totals AND intern hours in parallel
        const [cfMap, userMap, internMap] = await Promise.all([
          window.clockify.fetchMonth(year, m),
          window.clockify.fetchMonthByUser(year, m),
          window.clockify.fetchMonthInternByUser(year, m),
        ]);

        // Client entries (for overview/detail)
        Object.keys(cfMap).forEach(clientKey => {
          const client = clientMap[clientKey];
          if (!client) { unmatched.clients.add(clientKey); return; }

          Object.keys(cfMap[clientKey]).forEach(userKey => {
            const emp   = employeeMap[userKey];
            const hours = cfMap[clientKey][userKey];
            if (!emp) { unmatched.users.add(userKey); return; }
            saves.push(window.db.entries.upsert(
              client.id, emp.id, year, m,
              Math.round(hours * 4) / 4
            ));
            matched++;
          });
        });

        // Total hours per employee (for utilization – includes internal time)
        Object.keys(userMap).forEach(userKey => {
          const emp         = employeeMap[userKey];
          const hours       = userMap[userKey];
          const internHours = internMap[userKey] || 0;
          if (!emp) return;
          saves.push(window.db.utilHours.upsert(
            emp.id, year, m,
            Math.round(hours       * 4) / 4,
            Math.round(internHours * 4) / 4
          ));
        });
      }

      syncBtn.textContent = `Speichere ${matched} Einträge…`;
      await Promise.all(saves);

      // Warnings for unmatched
      const warns = [];
      if (unmatched.clients.size) warns.push('Nicht zugeordnete Kunden: <strong>' + [...unmatched.clients].join(', ') + '</strong>');
      if (unmatched.users.size)   warns.push('Nicht zugeordnete Nutzer: <strong>' + [...unmatched.users].join(', ')   + '</strong>');
      if (warns.length) showWarn(warns.join('<br>'));

      syncBtn.textContent = `✓ ${matched} Einträge synchronisiert`;
      setTimeout(() => { syncBtn.textContent = 'Von Clockify sync'; }, 3000);
      loadData();

    } catch (e) {
      showError('Clockify Fehler: ' + e.message);
      syncBtn.textContent = 'Von Clockify sync';
    } finally {
      syncBtn.disabled = false;
    }
  }

  // ── Adjustment modal ─────────────────────────────────────────────────
  const adjModal      = document.getElementById('adjModal');
  const adjClientName = document.getElementById('adjClientName');
  const adjExistingEl = document.getElementById('adjExisting');
  const adjMonthSel   = document.getElementById('adjMonth');
  const adjAmHoursEl  = document.getElementById('adjAmHours');
  const adjAdvHoursEl = document.getElementById('adjAdvHours');
  const adjNoteEl     = document.getElementById('adjNote');
  const adjSaveBtn    = document.getElementById('adjModalSave');

  let _adjClient = null, _adjYear = null, _adjMaxMonth = null, _adjAdjs = null;

  function openAdjModal(client, adjs, year, maxMonth) {
    _adjClient   = client;
    _adjYear     = year;
    _adjMaxMonth = maxMonth;
    _adjAdjs     = Object.assign({}, adjs);

    adjClientName.textContent = client.name;

    adjMonthSel.innerHTML = '';
    for (let m = 1; m <= maxMonth; m++) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = window.MONTHS_DE[m - 1];
      adjMonthSel.appendChild(o);
    }
    const curM = new Date().getMonth() + 1;
    adjMonthSel.value = curM <= maxMonth ? curM : maxMonth;

    adjAmHoursEl.value  = '';
    adjAdvHoursEl.value = '';
    adjNoteEl.value     = '';

    renderAdjExisting();
    adjModal.classList.remove('hidden');
  }

  function closeAdjModal() {
    adjModal.classList.add('hidden');
  }

  function renderAdjExisting() {
    const entries = Object.values(_adjAdjs).filter(a => a.am_hours || a.adv_hours || a.note);
    if (!entries.length) {
      adjExistingEl.innerHTML = '<p style="color:var(--text-muted);font-size:13px;margin:0 0 4px">Keine Anpassungen vorhanden.</p>';
      return;
    }
    adjExistingEl.innerHTML =
      '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:8px">Bestehende Anpassungen</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:12px">' +
        '<thead><tr style="border-bottom:1px solid var(--border)">' +
          '<th style="text-align:left;padding:4px 8px 6px;font-weight:600">Monat</th>' +
          '<th style="text-align:right;padding:4px 8px 6px;font-weight:600">AM</th>' +
          '<th style="text-align:right;padding:4px 8px 6px;font-weight:600">Adv</th>' +
          '<th style="text-align:left;padding:4px 8px 6px;font-weight:600">Notiz</th>' +
          '<th></th>' +
        '</tr></thead><tbody>' +
        entries.slice().sort((a, b) => a.month - b.month).map(a =>
          '<tr style="border-bottom:1px solid var(--border)">' +
            '<td style="padding:6px 8px">' + window.MONTHS_DE[a.month - 1] + '</td>' +
            '<td style="padding:6px 8px;text-align:right">' + (a.am_hours  ? a.am_hours  + ' h' : '—') + '</td>' +
            '<td style="padding:6px 8px;text-align:right">' + (a.adv_hours ? a.adv_hours + ' h' : '—') + '</td>' +
            '<td style="padding:6px 8px;color:var(--text-muted)">' + (a.note || '') + '</td>' +
            '<td style="padding:6px 8px;text-align:right">' +
              '<button class="btn btn-ghost btn-sm adj-del-btn" data-month="' + a.month + '" style="color:var(--danger,#dc2626)">✕</button>' +
            '</td>' +
          '</tr>'
        ).join('') +
        '</tbody></table>';

    adjExistingEl.querySelectorAll('.adj-del-btn').forEach(btn => {
      btn.addEventListener('click', function () {
        const month = parseInt(btn.dataset.month);
        btn.disabled = true;
        window.db.adjustments.delete(_adjClient.id, _adjYear, month)
          .then(() => {
            delete _adjAdjs[month];
            renderAdjExisting();
            loadData();
          })
          .catch(e => showError(e.message));
      });
    });
  }

  document.getElementById('adjModalClose').addEventListener('click', closeAdjModal);
  document.getElementById('adjModalCancel').addEventListener('click', closeAdjModal);
  adjModal.addEventListener('click', e => { if (e.target === adjModal) closeAdjModal(); });

  adjSaveBtn.addEventListener('click', function () {
    const month = parseInt(adjMonthSel.value);
    const amH   = parseFloat(adjAmHoursEl.value)  || 0;
    const advH  = parseFloat(adjAdvHoursEl.value) || 0;
    const note  = adjNoteEl.value.trim();
    if (!month) return;

    adjSaveBtn.disabled = true;
    window.db.adjustments.upsert(_adjClient.id, _adjYear, month, amH, advH, note)
      .then(saved => {
        _adjAdjs[month]     = saved;
        adjAmHoursEl.value  = '';
        adjAdvHoursEl.value = '';
        adjNoteEl.value     = '';
        renderAdjExisting();
        loadData();
        adjSaveBtn.disabled = false;
      })
      .catch(e => {
        showError(e.message);
        adjSaveBtn.disabled = false;
      });
  });

  // ── Boot ──────────────────────────────────────────────────────────────
  if (!window.isConfigured()) {
    setupHint.classList.remove('hidden');
  } else {
    loadData();
  }
  loadBtn.addEventListener('click', loadData);
  syncBtn.addEventListener('click', syncFromClockify);
})();
