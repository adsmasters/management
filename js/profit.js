(function () {
  'use strict';

  var monthFromM = document.getElementById('monthFromM');
  var monthFromY = document.getElementById('monthFromY');
  var monthToM   = document.getElementById('monthToM');
  var monthToY   = document.getElementById('monthToY');
  var loadBtn    = document.getElementById('loadBtn');
  var loadingEl  = document.getElementById('loading');
  var contentEl  = document.getElementById('content');
  var errorEl    = document.getElementById('error');
  var profitBody = document.getElementById('profitBody');
  var setupHint  = document.getElementById('setupHint');

  // ── Populate month/year selects ───────────────────────────────────────
  var MONTHS_LABEL = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  var now = new Date();
  var curYear  = now.getFullYear();
  var curMonth = now.getMonth() + 1; // 1-based

  function buildSelects() {
    // Months
    [monthFromM, monthToM].forEach(function (sel) {
      MONTHS_LABEL.forEach(function (name, idx) {
        var opt = document.createElement('option');
        opt.value = idx + 1;
        opt.textContent = name;
        sel.appendChild(opt);
      });
    });
    // Years: current year -3 to current year +1
    for (var y = curYear - 3; y <= curYear + 1; y++) {
      [monthFromY, monthToY].forEach(function (sel) {
        var opt = document.createElement('option');
        opt.value = y;
        opt.textContent = y;
        sel.appendChild(opt);
      });
    }
    // Default: current month
    monthFromM.value = curMonth;
    monthFromY.value = curYear;
    monthToM.value   = curMonth;
    monthToY.value   = curYear;
  }
  buildSelects();

  function getMonthVal(selM, selY) {
    return parseInt(selY.value) * 100 + parseInt(selM.value); // YYYYMM as number for comparison
  }
  function getFromParts() { return { year: parseInt(monthFromY.value), month: parseInt(monthFromM.value) }; }
  function getToParts()   { return { year: parseInt(monthToY.value),   month: parseInt(monthToM.value) }; }

  // Keep From ≤ To
  function clampDates() {
    if (getMonthVal(monthFromM, monthFromY) > getMonthVal(monthToM, monthToY)) {
      monthToM.value = monthFromM.value;
      monthToY.value = monthFromY.value;
    }
  }
  [monthFromM, monthFromY].forEach(function (el) { el.addEventListener('change', clampDates); });
  [monthToM, monthToY].forEach(function (el) {
    el.addEventListener('change', function () {
      if (getMonthVal(monthToM, monthToY) < getMonthVal(monthFromM, monthFromY)) {
        monthFromM.value = monthToM.value;
        monthFromY.value = monthToY.value;
      }
    });
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
    var fp = getFromParts();
    var tp = getToParts();
    var fromYear  = fp.year;
    var fromMonth = fp.month;
    var toYear    = tp.year;
    var toMonth   = tp.month;

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
      window.db.mappings.list(),
      Promise.all(months.map(function (m) { return window.db.adjustments.forMonth(m.year, m.month); })),
    ])
    .then(function (results) {
      var clients          = results[0];
      var employees        = results[1];
      var entryMonths      = results[2];
      var revenueMonths    = results[3];
      var mappings         = results[4];
      var adjustmentMonths = results[5];

      // Build lookup: clientId → [lexoffice_name, ...]
      var mappingsByClient = {};
      mappings.forEach(function (m) {
        if (!mappingsByClient[m.client_id]) mappingsByClient[m.client_id] = [];
        mappingsByClient[m.client_id].push(m.lexoffice_name);
      });

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

      // Load exclude keywords from settings
      var excludeKeywords = (localStorage.getItem('revenueExcludeKeywords') || '')
        .split('\n')
        .map(function (k) { return k.trim().toLowerCase(); })
        .filter(function (k) { return k.length > 0; });

      function isExcluded(contactName) {
        if (!excludeKeywords.length) return false;
        var n = (contactName || '').toLowerCase();
        return excludeKeywords.some(function (kw) { return n.includes(kw); });
      }

      // Aggregate revenue across all months (excluding configured keywords)
      var revenueMap = {};
      revenueMonths.forEach(function (rows) {
        rows.forEach(function (row) {
          if (isExcluded(row.contact_name)) return;
          var key = norm(row.contact_name || '');
          revenueMap[key] = (revenueMap[key] || 0) + (row.total_amount || 0);
        });
      });

      // Build deductions map: clientId → total revenue_deduction across months
      var deductionsMap = {}; // clientId → amount
      var deductionsByClientMonth = {}; // clientId → { 'YYYY-M' → amount }
      adjustmentMonths.forEach(function (adjs, idx) {
        var m = months[idx];
        adjs.forEach(function (a) {
          if (!a.revenue_deduction) return;
          deductionsMap[a.client_id] = (deductionsMap[a.client_id] || 0) + a.revenue_deduction;
          if (!deductionsByClientMonth[a.client_id]) deductionsByClientMonth[a.client_id] = {};
          deductionsByClientMonth[a.client_id][m.year + '-' + m.month] = a.revenue_deduction;
        });
      });

      loadingEl.classList.add('hidden');
      contentEl.classList.remove('hidden');

      render(clients, employees, clientHours, userTotals, revenueMap, mappingsByClient, numMonths, months, deductionsMap, deductionsByClientMonth);
    })
    .catch(function (e) {
      loadingEl.classList.add('hidden');
      showError(e.message);
    });
  }

  function render(clients, employees, clientHours, userTotals, revenueMap, mappingsByClient, numMonths, months, deductionsMap, deductionsByClientMonth) {
    deductionsMap = deductionsMap || {};
    deductionsByClientMonth = deductionsByClientMonth || {};
    profitBody.innerHTML = '';

    var totalRevenue = 0;
    var totalCost    = 0;
    var rows = [];

    clients.forEach(function (client) {
      var cNorm = norm(client.name);

      // Revenue: sum all mapped LexOffice names; fallback to lexoffice_name field or client name
      var revenue = 0;
      var clientMappedNames = mappingsByClient[client.id] || [];
      if (clientMappedNames.length > 0) {
        clientMappedNames.forEach(function (lxN) {
          revenue += revenueMap[norm(lxN)] || 0;
        });
      } else {
        var lxName = norm(client.lexoffice_name || client.name);
        revenue = revenueMap[lxName] || revenueMap[cNorm] || 0;
      }

      var cHours = clientHours[cNorm] || {};
      var totalClientHours = 0;
      Object.values(cHours).forEach(function (h) { totalClientHours += h; });

      var cost = 0;
      employees.forEach(function (emp) {
        var uNorm       = norm(emp.name);
        var empOnClient = cHours[uNorm] || 0;
        if (empOnClient <= 0) return;

        // Count how many months in the range this employee was NOT on leave
        var activeMonths = numMonths;
        if (emp.leave_start) {
          var ls = new Date(emp.leave_start);
          var leaveVal = ls.getFullYear() * 12 + ls.getMonth(); // 0-based month
          activeMonths = months.filter(function (m) {
            return (m.year * 12 + (m.month - 1)) < leaveVal;
          }).length;
        }
        if (activeMonths <= 0) return; // vollständig abwesend im Zeitraum

        if (emp.role === 'freelancer' && emp.hourly_rate > 0) {
          // Freelancer: Stunden × Stundensatz (Stunden sind bereits nur für aktive Monate)
          cost += empOnClient * emp.hourly_rate;
        } else if (emp.monthly_cost > 0) {
          var empTotal = userTotals[uNorm] || 0;
          if (empTotal > 0) cost += (empOnClient / empTotal) * emp.monthly_cost * activeMonths;
        }
      });

      var deduction = deductionsMap[client.id] || 0;
      var revenueNet = revenue - deduction;
      var profit = revenueNet - cost;
      var margin = revenueNet > 0 ? (profit / revenueNet) * 100 : (cost > 0 ? -Infinity : null);
      if (margin === -Infinity) margin = null;

      totalRevenue += revenueNet;
      totalCost    += cost;

      rows.push({ id: client.id, name: client.name, revenue: revenueNet, revenueGross: revenue,
                  deduction, cost, profit, margin,
                  hours: totalClientHours, hasRevenue: revenueNet > 0 });
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

      var deductionHint = r.deduction > 0
        ? ' <span title="Brutto: ' + fmt(r.revenueGross) + ' · Abzug: ' + fmt(r.deduction) + '" style="font-size:11px;color:var(--text-secondary)">(-' + fmt(r.deduction) + ')</span>'
        : '';

      tr.innerHTML =
        '<td style="font-weight:500">' + r.name +
          ' <button class="btn btn-ghost btn-sm rev-adj-btn" style="font-size:11px;padding:1px 6px;margin-left:4px" data-id="' + r.id + '" data-name="' + r.name + '">± Korrektur</button></td>' +
        '<td class="right revenue">' + (r.revenue > 0 ? fmt(r.revenue) + deductionHint : '<span class="no-lexoffice">—</span>') + '</td>' +
        '<td class="right cost">'    + (r.cost > 0 ? fmt(r.cost) : '<span class="no-lexoffice">—</span>') + '</td>' +
        '<td class="right ' + (r.revenue > 0 || r.cost > 0 ? (r.profit >= 0 ? 'profit-pos' : 'profit-neg') : '') + '">' +
          (r.revenue > 0 || r.cost > 0
            ? (r.profit >= 0 ? '+' : '') + fmt(r.profit)
            : '<span class="no-lexoffice">—</span>') + '</td>' +
        '<td class="' + (r.margin !== null ? (r.margin >= 0 ? 'margin-pos' : 'margin-neg') : '') + '">' +
          marginText + marginBar + '</td>' +
        '<td class="right hours-cell">' + (r.hours > 0 ? r.hours.toFixed(1) + ' h' : '—') + '</td>';

      // Korrektur-Button
      tr.querySelector('.rev-adj-btn').addEventListener('click', function () {
        openRevAdj(r.id, r.name, months, deductionsByClientMonth[r.id] || {});
      });

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

  // ── Revenue Adjustment Modal ─────────────────────────────────────────
  var revAdjModal  = document.getElementById('revAdjModal');
  var revAdjTitle  = document.getElementById('revAdjTitle');
  var revAdjBody   = document.getElementById('revAdjBody');
  var revAdjClose  = document.getElementById('revAdjClose');
  var revAdjCancel = document.getElementById('revAdjCancel');
  var revAdjSave   = document.getElementById('revAdjSave');


  function openRevAdj(clientId, clientName, months, existing) {
    revAdjTitle.textContent = 'Umsatz-Korrektur – ' + clientName;
    revAdjBody.innerHTML = '';
    months.forEach(function (m) {
      var key = m.year + '-' + m.month;
      var val = existing[key] || 0;
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td style="padding:6px 8px;font-size:13px">' + MONTHS_LABEL[m.month - 1] + ' ' + m.year + '</td>' +
        '<td style="padding:6px 8px;text-align:right">' +
          '<input type="number" step="0.01" value="' + (val || '') + '" placeholder="0,00" ' +
          'data-year="' + m.year + '" data-month="' + m.month + '" ' +
          'style="width:120px;text-align:right;padding:4px 8px;border:1px solid var(--border);border-radius:var(--radius);font-size:13px;background:var(--surface);color:var(--text)">' +
        '</td>';
      revAdjBody.appendChild(tr);
    });
    revAdjModal._clientId = clientId;
    revAdjModal._months   = months;
    revAdjModal.classList.remove('hidden');
  }

  function closeRevAdj() {
    revAdjModal.classList.add('hidden');
    revAdjSave.disabled = false;
    revAdjSave.textContent = 'Speichern';
  }
  revAdjClose.addEventListener('click', closeRevAdj);
  revAdjCancel.addEventListener('click', closeRevAdj);
  revAdjModal.addEventListener('click', function (e) { if (e.target === revAdjModal) closeRevAdj(); });

  revAdjSave.addEventListener('click', function () {
    var clientId = revAdjModal._clientId;
    var months   = revAdjModal._months;
    revAdjSave.disabled = true;
    revAdjSave.textContent = 'Speichern…';

    var inputs = Array.from(revAdjBody.querySelectorAll('input'));

    // Load existing adjustments first so we don't overwrite hours values
    var years = [...new Set(months.map(function (m) { return m.year; }))];
    Promise.all(years.map(function (y) { return window.db.adjustments.forClientYear(clientId, y); }))
      .then(function (results) {
        var existingMap = {}; // 'year-month' → adjustment row
        results.forEach(function (rows) {
          rows.forEach(function (r) { existingMap[r.year + '-' + r.month] = r; });
        });

        return Promise.all(inputs.map(function (inp) {
          var year  = parseInt(inp.getAttribute('data-year'));
          var month = parseInt(inp.getAttribute('data-month'));
          var val   = parseFloat(inp.value) || 0;
          var ex    = existingMap[year + '-' + month] || {};
          return window.db.adjustments.upsert(
            clientId, year, month,
            ex.am_hours  || 0,
            ex.adv_hours || 0,
            ex.note      || null,
            val
          );
        }));
      })
      .then(function () {
        closeRevAdj();
        load();
      })
      .catch(function (e) {
        showError('Fehler: ' + e.message);
        revAdjSave.disabled = false;
        revAdjSave.textContent = 'Speichern';
      });
  });

  // ── LexOffice sync ───────────────────────────────────────────────────
  var lexSyncBtn = document.getElementById('lexSyncBtn');

  lexSyncBtn.addEventListener('click', function () {
    if (!window.lexoffice.isConfigured()) {
      showError('LexOffice nicht verbunden. Bitte zuerst in den <a href="settings.html">Einstellungen</a> den API Key eintragen.');
      return;
    }

    var fp = getFromParts();
    var tp = getToParts();
    var fromYear  = fp.year;
    var fromMonth = fp.month;
    var toYear    = tp.year;
    var toMonth   = tp.month;
    var months    = monthsInRange(fromYear, fromMonth, toYear, toMonth);

    lexSyncBtn.disabled = true;
    errorEl.innerHTML = '';

    (function syncNext(i) {
      if (i >= months.length) {
        lexSyncBtn.textContent = '✓ LexOffice synchronisiert';
        setTimeout(function () { lexSyncBtn.textContent = 'Von LexOffice sync'; }, 3000);
        lexSyncBtn.disabled = false;
        load();
        return;
      }
      var m = months[i];
      var label = MONTHS_LABEL[m.month - 1] + ' ' + m.year;
      lexSyncBtn.textContent = 'Sync ' + label + '… (' + (i + 1) + '/' + months.length + ')';

      var supabaseUrl = localStorage.getItem('supabaseUrl') || 'https://lgrnmiszhhahfcmctmwo.supabase.co';
      var supabaseKey = localStorage.getItem('supabaseKey') || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxncm5taXN6aGhhaGZjbWN0bXdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NjE2NDksImV4cCI6MjA4OTIzNzY0OX0.FDZRGMESves7XbAMs_oMLWmvnywMlVqe8p7f1kt06qk';
      console.log('[sync-lexoffice] POST →', supabaseUrl + '/functions/v1/sync-lexoffice', { year: m.year, month: m.month });
      fetch(supabaseUrl + '/functions/v1/sync-lexoffice', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + supabaseKey,
          'apikey': supabaseKey,
        },
        body: JSON.stringify({
          lexofficeKey: localStorage.getItem('lexofficeKey'),
          year: m.year,
          month: m.month,
        }),
      }).then(function (res) {
        console.log('[sync-lexoffice] HTTP', res.status);
        return res.json().then(function (data) {
          console.log('[sync-lexoffice] body', JSON.stringify(data));
          if (data.error) {
            // Retry once after 5s on rate limit
            if (data.error.indexOf('429') !== -1 || data.error.indexOf('Rate limit') !== -1) {
              lexSyncBtn.textContent = 'Rate limit – warte 15s… (' + (i + 1) + '/' + months.length + ')';
              setTimeout(function () { syncNext(i); }, 15000);
              return;
            }
            throw new Error(data.error);
          }
          if (!res.ok) throw new Error('HTTP ' + res.status);
          // Pause between months to respect LexOffice rate limit
          setTimeout(function () { syncNext(i + 1); }, 3000);
        });
      }).catch(function (e) {
        console.error('[sync-lexoffice] error', e.message);
        showError('LexOffice Fehler (' + label + '): ' + e.message);
        lexSyncBtn.textContent = 'Von LexOffice sync';
        lexSyncBtn.disabled = false;
      });
    })(0);
  });

  // ── Boot ──────────────────────────────────────────────────────────────
  if (!window.isConfigured()) {
    setupHint.classList.remove('hidden');
  } else {
    load();
  }
})();
