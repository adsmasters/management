(function () {
  'use strict';

  var monthFrom  = document.getElementById('monthFrom');
  var monthTo    = document.getElementById('monthTo');
  var loadBtn    = document.getElementById('loadBtn');
  var loadingEl  = document.getElementById('loading');
  var contentEl  = document.getElementById('content');
  var errorEl    = document.getElementById('error');
  var profitBody = document.getElementById('profitBody');
  var setupHint  = document.getElementById('setupHint');

  // ── Default to current month ──────────────────────────────────────────
  var now = new Date();
  var currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  monthFrom.value = currentMonth;
  monthTo.value   = currentMonth;

  monthFrom.addEventListener('change', function () {
    if (monthTo.value && monthTo.value < monthFrom.value) monthTo.value = monthFrom.value;
  });
  monthTo.addEventListener('change', function () {
    if (monthFrom.value && monthTo.value < monthFrom.value) monthFrom.value = monthTo.value;
  });

  function fmt(n) {
    return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }
  function norm(str) { return (str || '').trim().toLowerCase(); }
  function showError(msg) {
    errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' + msg + '</div>';
  }

  function monthsInRange(fromYear, fromMonth, toYear, toMonth) {
    var list = [];
    var y = fromYear, m = fromMonth;
    while (y < toYear || (y === toYear && m <= toMonth)) {
      list.push({ year: y, month: m });
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return list;
  }

  // ── Load ──────────────────────────────────────────────────────────────
  loadBtn.addEventListener('click', load);

  function load() {
    var fromParts = monthFrom.value.split('-');
    var toParts   = monthTo.value.split('-');
    if (!fromParts[0] || !toParts[0]) return;

    var fromYear  = parseInt(fromParts[0]);
    var fromMonth = parseInt(fromParts[1]);
    var toYear    = parseInt(toParts[0]);
    var toMonth   = parseInt(toParts[1]);

    if (fromYear > toYear || (fromYear === toYear && fromMonth > toMonth)) {
      showError('„Von" darf nicht nach „Bis" liegen.');
      return;
    }

    var months    = monthsInRange(fromYear, fromMonth, toYear, toMonth);
    var numMonths = months.length;

    errorEl.innerHTML = '';
    loadingEl.classList.remove('hidden');
    contentEl.classList.add('hidden');

    // Fetch clients, employees, entries (from Supabase) + revenue for all months
    Promise.all([
      window.db.clients.list(),
      window.db.employees.listActive(),
      Promise.all(months.map(function (m) { return window.db.entries.forMonth(m.year, m.month); })),
      Promise.all(months.map(function (m) { return window.db.revenue.forMonth(m.year, m.month); })),
    ])
    .then(function (results) {
      var clients      = results[0];
      var employees    = results[1];
      var entryMonths  = results[2]; // array of entry-arrays per month
      var revenueMonths = results[3];

      // Build lookup: clientId → client
      var clientsById = {};
      clients.forEach(function (c) { clientsById[c.id] = c; });

      // Build lookup: employeeId → employee
      var empsById = {};
      employees.forEach(function (e) { empsById[e.id] = e; });

      // Aggregate entries across all months
      // clientHours: { normClientName → { normEmpName → hours } }
      // userTotals:  { normEmpName → totalHours }
      var clientHours = {};
      var userTotals  = {};
      entryMonths.forEach(function (entries) {
        entries.forEach(function (entry) {
          var client = clientsById[entry.client_id];
          var emp    = empsById[entry.employee_id]
                    || (entry.employees && { name: entry.employees.name });
          if (!client || !emp || !entry.hours) return;
          var cKey = norm(client.name);
          var uKey = norm(emp.name);
          if (!clientHours[cKey]) clientHours[cKey] = {};
          clientHours[cKey][uKey] = (clientHours[cKey][uKey] || 0) + entry.hours;
          userTotals[uKey]        = (userTotals[uKey]        || 0) + entry.hours;
        });
      });

      // Aggregate revenue across all months
      var revenueMap = {};
      revenueMonths.forEach(function (rows) {
        rows.forEach(function (row) {
          var key = norm(row.contact_name || '');
          revenueMap[key] = (revenueMap[key] || 0) + (row.total_amount || 0);
        });
      });

      loadingEl.classList.add('hidden');
      contentEl.classList.remove('hidden');

      render(clients, employees, clientHours, userTotals, revenueMap, numMonths);
    })
    .catch(function (e) {
      loadingEl.classList.add('hidden');
      showError(e.message);
    });
  }

  function render(clients, employees, clientHours, userTotals, revenueMap, numMonths) {
    profitBody.innerHTML = '';

    var totalRevenue = 0;
    var totalCost    = 0;
    var rows = [];

    clients.forEach(function (client) {
      var cNorm = norm(client.name);
      var lxName = norm(client.lexoffice_name || client.name);
      var revenue = revenueMap[lxName] || revenueMap[cNorm] || 0;

      var cHours = clientHours[cNorm] || {};
      var totalClientHours = 0;
      Object.values(cHours).forEach(function (h) { totalClientHours += h; });

      var cost = 0;
      employees.forEach(function (emp) {
        if (!emp.monthly_cost || emp.monthly_cost <= 0) return;
        var uNorm       = norm(emp.name);
        var empTotal    = userTotals[uNorm] || 0;
        var empOnClient = cHours[uNorm]     || 0;
        if (empTotal > 0 && empOnClient > 0) {
          cost += (empOnClient / empTotal) * emp.monthly_cost * numMonths;
        }
      });

      var profit = revenue - cost;
      var margin = revenue > 0 ? (profit / revenue) * 100 : null;

      totalRevenue += revenue;
      totalCost    += cost;

      rows.push({ name: client.name, revenue, cost, profit, margin,
                  hours: totalClientHours, hasRevenue: revenue > 0 });
    });

    rows.sort(function (a, b) {
      if (a.hasRevenue !== b.hasRevenue) return a.hasRevenue ? -1 : 1;
      return b.profit - a.profit;
    });

    rows.forEach(function (r) {
      var tr = document.createElement('tr');

      var marginBar = '';
      if (r.margin !== null) {
        var pct = Math.min(Math.abs(r.margin), 100);
        marginBar = '<div class="progress-bar-wrap"><div class="progress-bar ' +
          (r.margin >= 0 ? 'bar-pos' : 'bar-neg') + '" style="width:' + pct + '%"></div></div>';
      }

      var marginText = r.margin !== null
        ? (r.margin >= 0 ? '+' : '') + r.margin.toFixed(1) + '%'
        : '<span class="no-lexoffice">kein Umsatz</span>';

      tr.innerHTML =
        '<td style="font-weight:500">' + r.name + '</td>' +
        '<td class="right revenue">' + (r.revenue > 0 ? fmt(r.revenue) : '<span class="no-lexoffice">—</span>') + '</td>' +
        '<td class="right cost">'    + (r.cost    > 0 ? fmt(r.cost)    : '<span class="no-lexoffice">—</span>') + '</td>' +
        '<td class="right ' + (r.revenue > 0 || r.cost > 0 ? (r.profit >= 0 ? 'profit-pos' : 'profit-neg') : '') + '">' +
          (r.revenue > 0 || r.cost > 0
            ? (r.profit >= 0 ? '+' : '') + fmt(r.profit)
            : '<span class="no-lexoffice">—</span>') + '</td>' +
        '<td class="' + (r.margin !== null ? (r.margin >= 0 ? 'margin-pos' : 'margin-neg') : '') + '">' +
          marginText + marginBar + '</td>' +
        '<td class="right hours-cell">' + (r.hours > 0 ? r.hours.toFixed(1) + ' h' : '—') + '</td>';

      profitBody.appendChild(tr);
    });

    var totalProfit = totalRevenue - totalCost;
    var avgMargin   = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : null;

    document.getElementById('kpiRevenue').textContent = fmt(totalRevenue);
    document.getElementById('kpiCost').textContent    = fmt(totalCost);

    var profitEl = document.getElementById('kpiProfit');
    profitEl.textContent = (totalProfit >= 0 ? '+' : '') + fmt(totalProfit);
    profitEl.className   = 'kpi-value ' + (totalProfit >= 0 ? 'pos' : 'neg');

    var marginEl = document.getElementById('kpiMargin');
    marginEl.textContent = avgMargin !== null
      ? (avgMargin >= 0 ? '+' : '') + avgMargin.toFixed(1) + '%' : '—';
    marginEl.className = 'kpi-value ' + (avgMargin !== null ? (avgMargin >= 0 ? 'pos' : 'neg') : 'neutral');
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  if (!window.isConfigured()) {
    setupHint.classList.remove('hidden');
  } else {
    load();
  }
})();
