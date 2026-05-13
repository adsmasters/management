(function () {
  'use strict';

  var monthFilter = document.getElementById('monthFilter');
  var loadBtn     = document.getElementById('loadBtn');
  var loadingEl   = document.getElementById('loading');
  var contentEl   = document.getElementById('content');
  var errorEl     = document.getElementById('error');
  var profitBody  = document.getElementById('profitBody');
  var setupHint   = document.getElementById('setupHint');
  var noLexoffice = document.getElementById('noLexoffice');
  var noClockify  = document.getElementById('noClockify');

  // ── Default to current month ──────────────────────────────────────────
  var now = new Date();
  monthFilter.value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

  function fmt(n) {
    return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }

  function norm(str) { return (str || '').trim().toLowerCase(); }

  function showError(msg) {
    errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' + msg + '</div>';
  }

  // ── Load ──────────────────────────────────────────────────────────────
  loadBtn.addEventListener('click', load);

  function load() {
    var parts = monthFilter.value.split('-');
    if (!parts[0] || !parts[1]) return;
    var year  = parseInt(parts[0]);
    var month = parseInt(parts[1]);

    errorEl.innerHTML = '';
    loadingEl.classList.remove('hidden');
    contentEl.classList.add('hidden');

    noLexoffice.classList.toggle('hidden', window.lexoffice.isConfigured());
    noClockify.classList.toggle('hidden',  window.clockify.isConfigured());

    // Always load clients + employees from Supabase
    Promise.all([
      window.db.clients.list(),
      window.db.employees.listActive(),
      window.clockify.isConfigured()
        ? Promise.all([
            window.clockify.fetchMonth(year, month),
            window.clockify.fetchMonthByUser(year, month),
          ])
        : Promise.resolve([{}, {}]),
      window.lexoffice.isConfigured()
        ? window.lexoffice.fetchMonth(year, month)
        : Promise.resolve({}),
    ])
    .then(function (results) {
      var clients    = results[0];
      var employees  = results[1];
      var cfData     = results[2];
      var clientHours = cfData[0]; // { normClientName → { normUserName → hours } }
      var userTotals  = cfData[1]; // { normUserName → totalHours }
      var revenueMap  = results[3]; // { normContactName → totalBrutto }

      loadingEl.classList.add('hidden');
      contentEl.classList.remove('hidden');

      render(clients, employees, clientHours, userTotals, revenueMap);
    })
    .catch(function (e) {
      loadingEl.classList.add('hidden');
      showError(e.message);
    });
  }

  function render(clients, employees, clientHours, userTotals, revenueMap) {
    profitBody.innerHTML = '';

    var totalRevenue = 0;
    var totalCost    = 0;
    var rows = [];

    clients.forEach(function (client) {
      var cNorm = norm(client.name);

      // Revenue: match via lexoffice_name (preferred) or client name
      var lxName  = norm(client.lexoffice_name || client.name);
      var revenue = revenueMap[lxName] || revenueMap[cNorm] || 0;

      // Hours for this client per user from Clockify
      var cHours = clientHours[cNorm] || {};
      var totalClientHours = 0;
      Object.values(cHours).forEach(function (h) { totalClientHours += h; });

      // Cost: allocate each employee's monthly_cost proportionally by Clockify hours
      var cost = 0;
      employees.forEach(function (emp) {
        if (!emp.monthly_cost || emp.monthly_cost <= 0) return;
        var uNorm      = norm(emp.name);
        var empTotal   = userTotals[uNorm] || 0;
        var empOnClient = cHours[uNorm]    || 0;
        if (empTotal > 0 && empOnClient > 0) {
          cost += (empOnClient / empTotal) * emp.monthly_cost;
        }
      });

      var profit = revenue - cost;
      var margin = revenue > 0 ? (profit / revenue) * 100 : null;

      totalRevenue += revenue;
      totalCost    += cost;

      rows.push({
        name: client.name,
        revenue: revenue,
        cost: cost,
        profit: profit,
        margin: margin,
        hours: totalClientHours,
        hasRevenue: revenue > 0,
      });
    });

    // Sort: clients with revenue first, then by profit desc
    rows.sort(function (a, b) {
      if (a.hasRevenue !== b.hasRevenue) return a.hasRevenue ? -1 : 1;
      return b.profit - a.profit;
    });

    rows.forEach(function (r) {
      var tr = document.createElement('tr');

      var marginBar = '';
      if (r.margin !== null) {
        var pct = Math.min(Math.abs(r.margin), 100);
        var cls = r.margin >= 0 ? 'bar-pos' : 'bar-neg';
        marginBar = '<div class="progress-bar-wrap"><div class="progress-bar ' + cls + '" style="width:' + pct + '%"></div></div>';
      }

      var marginText = r.margin !== null
        ? (r.margin >= 0 ? '+' : '') + r.margin.toFixed(1) + '%'
        : '<span class="no-lexoffice">kein Umsatz</span>';

      var marginCls = r.margin !== null
        ? (r.margin >= 0 ? 'margin-pos' : 'margin-neg')
        : '';

      tr.innerHTML =
        '<td style="font-weight:500">' + r.name + '</td>' +
        '<td class="right revenue">' + (r.revenue > 0 ? fmt(r.revenue) : '<span class="no-lexoffice">—</span>') + '</td>' +
        '<td class="right cost">'    + (r.cost    > 0 ? fmt(r.cost)    : '<span class="no-lexoffice">—</span>') + '</td>' +
        '<td class="right ' + (r.revenue > 0 || r.cost > 0 ? (r.profit >= 0 ? 'profit-pos' : 'profit-neg') : '') + '">' +
          (r.revenue > 0 || r.cost > 0
            ? (r.profit >= 0 ? '+' : '') + fmt(r.profit)
            : '<span class="no-lexoffice">—</span>') +
        '</td>' +
        '<td class="' + marginCls + '">' + marginText + marginBar + '</td>' +
        '<td class="right hours-cell">' + (r.hours > 0 ? r.hours.toFixed(1) + ' h' : '—') + '</td>';

      profitBody.appendChild(tr);
    });

    // KPI summary
    var totalProfit = totalRevenue - totalCost;
    var avgMargin   = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : null;

    document.getElementById('kpiRevenue').textContent = fmt(totalRevenue);
    document.getElementById('kpiCost').textContent    = fmt(totalCost);

    var profitEl  = document.getElementById('kpiProfit');
    profitEl.textContent = (totalProfit >= 0 ? '+' : '') + fmt(totalProfit);
    profitEl.className   = 'kpi-value ' + (totalProfit >= 0 ? 'pos' : 'neg');

    var marginEl  = document.getElementById('kpiMargin');
    marginEl.textContent = avgMargin !== null
      ? (avgMargin >= 0 ? '+' : '') + avgMargin.toFixed(1) + '%'
      : '—';
    marginEl.className = 'kpi-value ' + (avgMargin !== null ? (avgMargin >= 0 ? 'pos' : 'neg') : 'neutral');
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  if (!window.isConfigured()) {
    setupHint.classList.remove('hidden');
  } else {
    load();
  }
})();
