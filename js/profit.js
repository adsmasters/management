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
  var gUnmapped = [], gUnmappedTotal = 0; // nicht zugeordneter (Sammel-)Umsatz
  var gCategoryTotals = {};               // Kategorie (z.B. Software) → Summe

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

  // Warnhinweis: Umsatz von nicht zugeordneten Kontakten (fehlt in der Profitabilität)
  function renderUnmappedWarning(unmapped) {
    var el = document.getElementById('unmappedWarn');
    if (!el) return;
    if (!unmapped || !unmapped.length) { el.innerHTML = ''; return; }
    var total = unmapped.reduce(function (s, u) { return s + u.amount; }, 0);
    var list = unmapped.slice(0, 8).map(function (u) { return u.name + ' (' + fmt(u.amount) + ')'; }).join(', ');
    var more = unmapped.length > 8 ? ' u. a.' : '';
    el.innerHTML = '<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:var(--radius);padding:12px 16px;margin-bottom:16px;font-size:13px;color:#92400e;line-height:1.5">' +
      '<strong>ℹ️ ' + fmt(total) + ' Umsatz ohne Kunden-Zuordnung</strong> – als Sammelposten „Ohne Zuordnung" im Gesamtumsatz <strong>enthalten</strong>. ' +
      unmapped.length + ' Kontakt(e): ' + list + more + '. ' +
      'Optional einem Kunden zuordnen – oder Nicht-Umsätze (z.B. Event-Rechnungen) ausschließen: ' +
      '<a href="name-mapping.html" style="color:#92400e;font-weight:700;text-decoration:underline">→ Zuordnung</a></div>';
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

  // Für (Mitarbeiter, Jahr, Monat) den gültigen Satz bestimmen:
  // jüngste Gehaltsänderung mit effective_from ≤ Zielmonat; sonst Basiswert vom Mitarbeiter.
  function effectiveRate(emp, year, month, ratesByEmp) {
    var targetYm = year * 12 + (month - 1);
    var rates = (ratesByEmp && ratesByEmp[emp.id]) || [];
    var best = null, bestYm = -Infinity;
    rates.forEach(function (r) {
      var d = new Date(r.effective_from);
      var ym = d.getUTCFullYear() * 12 + d.getUTCMonth();
      if (ym <= targetYm && ym > bestYm) { best = r; bestYm = ym; }
    });
    if (best) {
      return {
        monthly_cost: Number(best.monthly_cost) || 0,
        hourly_rate:  Number(best.hourly_rate)  || 0,
      };
    }
    return {
      monthly_cost: Number(emp.monthly_cost) || 0,
      hourly_rate:  Number(emp.hourly_rate)  || 0,
    };
  }

  // Monatsgenaue Kostenberechnung (berücksichtigt zeitabhängige Gehälter/Sätze).
  // Liefert: costByClient, hoursByClient (alle Stunden), breakdown[clientId] = {empId → {name,role,hours,cost}}
  function computeCosts(months, entryMonths, clients, employees, ratesByEmp) {
    var empsById = {};
    employees.forEach(function (e) { empsById[e.id] = e; });

    var costByClient = {};
    var hoursByClient = {};
    var breakdown = {};

    months.forEach(function (mObj, idx) {
      var entries = entryMonths[idx] || [];
      var y = mObj.year, m = mObj.month;
      var leaveCutoff = y * 12 + (m - 1);

      // Stunden dieses Monats: ch[clientId][empId], et[empId]
      var ch = {}, et = {};
      entries.forEach(function (entry) {
        if (!entry.hours) return;
        var cid = entry.client_id, eid = entry.employee_id;
        if (!ch[cid]) ch[cid] = {};
        ch[cid][eid] = (ch[cid][eid] || 0) + entry.hours;
        et[eid] = (et[eid] || 0) + entry.hours;
        hoursByClient[cid] = (hoursByClient[cid] || 0) + entry.hours;
      });

      Object.keys(ch).forEach(function (cid) {
        Object.keys(ch[cid]).forEach(function (eid) {
          var emp = empsById[eid];
          var hrs = ch[cid][eid];
          if (!emp) return; // unbekannter/inaktiver Mitarbeiter: Stunden zählen, aber keine Kosten
          if (emp.leave_start) {
            var ls = new Date(emp.leave_start);
            var leaveVal = ls.getUTCFullYear() * 12 + ls.getUTCMonth();
            if (leaveCutoff >= leaveVal) return; // in diesem Monat bereits abwesend
          }
          var rate = effectiveRate(emp, y, m, ratesByEmp);
          var cost = 0;
          if (emp.role === 'freelancer') {
            if (rate.hourly_rate > 0) cost = hrs * rate.hourly_rate;
          } else if (rate.monthly_cost > 0) {
            var empTot = et[eid] || 0;
            if (empTot > 0) cost = (hrs / empTot) * rate.monthly_cost;
          }
          costByClient[cid] = (costByClient[cid] || 0) + cost;
          if (!breakdown[cid]) breakdown[cid] = {};
          if (!breakdown[cid][eid]) breakdown[cid][eid] = { name: emp.name, role: emp.role, hours: 0, cost: 0 };
          breakdown[cid][eid].hours += hrs;
          breakdown[cid][eid].cost  += cost;
        });
      });
    });

    return { costByClient: costByClient, hoursByClient: hoursByClient, breakdown: breakdown };
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
      Promise.all(months.map(function (m) { return window.db.manualCosts.forMonth(m.year, m.month); })),
      window.db.employeeRates.listAll(),
      window.db.contactOverrides.listAll().catch(function () { return []; }),
    ])
    .then(function (results) {
      var clients          = results[0];
      var employees        = results[1];
      var entryMonths      = results[2];
      var revenueMonths    = results[3];
      var mappings         = results[4];
      var adjustmentMonths = results[5];
      var manualCostMonths = results[6];
      var employeeRates    = results[7];
      var contactOverrides = results[8] || [];

      // Zentral ausgeschlossene Kontakte (zählen NIRGENDS als Umsatz) + Kategorien
      var excludedContacts = {};
      var categoryByContact = {};
      contactOverrides.forEach(function (o) {
        if (o.status === 'excluded') excludedContacts[norm(o.contact_name)] = 1;
        else if (o.status && o.status.indexOf('cat:') === 0) categoryByContact[norm(o.contact_name)] = o.status.slice(4);
      });

      // Sätze nach Mitarbeiter gruppieren
      var ratesByEmp = {};
      (employeeRates || []).forEach(function (r) {
        if (!ratesByEmp[r.employee_id]) ratesByEmp[r.employee_id] = [];
        ratesByEmp[r.employee_id].push(r);
      });

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
        if (excludedContacts[norm(contactName)]) return true;   // zentraler Ausschluss
        if (!excludeKeywords.length) return false;
        var n = (contactName || '').toLowerCase();
        return excludeKeywords.some(function (kw) { return n.includes(kw); });
      }

      // Aggregate revenue across all months (excluding configured keywords)
      var revenueMap = {};
      var revenueNames = {}; // normKey → originaler Kontaktname (für Warnhinweis)
      revenueMonths.forEach(function (rows) {
        rows.forEach(function (row) {
          if (isExcluded(row.contact_name)) return;
          var key = norm(row.contact_name || '');
          revenueMap[key] = (revenueMap[key] || 0) + (row.total_amount || 0);
          if (!revenueNames[key]) revenueNames[key] = row.contact_name;
        });
      });

      // ── Nicht zugeordneter Umsatz (Sammelumsatz): zählt mit, ohne Kunde ──
      var mappedKeys = {};
      Object.keys(mappingsByClient).forEach(function (cid) { mappingsByClient[cid].forEach(function (lx) { mappedKeys[norm(lx)] = 1; }); });
      clients.forEach(function (c) { if (c.lexoffice_name) mappedKeys[norm(c.lexoffice_name)] = 1; mappedKeys[norm(c.name)] = 1; });
      gUnmapped = [];
      gUnmappedTotal = 0;
      gCategoryTotals = {};
      Object.keys(revenueMap).forEach(function (k) {
        if (mappedKeys[k] || revenueMap[k] <= 0.5) return;
        var cat = categoryByContact[k];
        if (cat) { gCategoryTotals[cat] = (gCategoryTotals[cat] || 0) + revenueMap[k]; return; }
        gUnmapped.push({ name: revenueNames[k] || k, amount: revenueMap[k] }); gUnmappedTotal += revenueMap[k];
      });
      gUnmapped.sort(function (a, b) { return b.amount - a.amount; });

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

      // Manuelle Zusatzkosten: clientId → total, und clientId → [rows]
      var manualCostsTotal = {};       // clientId → summe
      var manualCostsByClient = {};    // clientId → [{id, year, month, name, amount}]
      manualCostMonths.forEach(function (rows) {
        rows.forEach(function (mc) {
          manualCostsTotal[mc.client_id] = (manualCostsTotal[mc.client_id] || 0) + (Number(mc.amount) || 0);
          if (!manualCostsByClient[mc.client_id]) manualCostsByClient[mc.client_id] = [];
          manualCostsByClient[mc.client_id].push(mc);
        });
      });

      // Monatsgenaue Kosten (mit zeitabhängigen Sätzen)
      var costData = computeCosts(months, entryMonths, clients, employees, ratesByEmp);

      loadingEl.classList.add('hidden');
      contentEl.classList.remove('hidden');

      render(clients, costData, revenueMap, mappingsByClient, numMonths, months, deductionsMap, deductionsByClientMonth, manualCostsTotal, manualCostsByClient);
    })
    .catch(function (e) {
      loadingEl.classList.add('hidden');
      showError(e.message);
    });
  }

  function render(clients, costData, revenueMap, mappingsByClient, numMonths, months, deductionsMap, deductionsByClientMonth, manualCostsTotal, manualCostsByClient) {
    deductionsMap = deductionsMap || {};
    deductionsByClientMonth = deductionsByClientMonth || {};
    manualCostsTotal = manualCostsTotal || {};
    manualCostsByClient = manualCostsByClient || {};
    var costByClient  = (costData && costData.costByClient)  || {};
    var hoursByClient = (costData && costData.hoursByClient) || {};
    var breakdown     = (costData && costData.breakdown)     || {};
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

      var totalClientHours = hoursByClient[client.id] || 0;
      var cost = costByClient[client.id] || 0;

      // Manuelle Zusatzkosten (z.B. externe Freelancer) hinzurechnen
      cost += manualCostsTotal[client.id] || 0;

      var correction = deductionsMap[client.id] || 0;
      var revenueNet = revenue + correction;
      var profit = revenueNet - cost;
      var margin = revenueNet > 0 ? (profit / revenueNet) * 100 : (cost > 0 ? -Infinity : null);
      if (margin === -Infinity) margin = null;

      totalRevenue += revenueNet;
      totalCost    += cost;

      rows.push({ id: client.id, name: client.name, revenue: revenueNet, revenueGross: revenue,
                  deduction: correction, cost, profit, margin,
                  hours: totalClientHours, hasRevenue: revenueNet > 0 });
    });

    // Nicht zugeordneter Umsatz + Kategorien zählen mit
    totalRevenue += gUnmappedTotal;
    Object.keys(gCategoryTotals).forEach(function (c) { totalRevenue += gCategoryTotals[c]; });
    renderUnmappedWarning(gUnmapped);

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

      var deductionHint = r.deduction !== 0
        ? ' <span title="Basis: ' + fmt(r.revenueGross) + ' · Korrektur: ' + (r.deduction > 0 ? '+' : '') + fmt(r.deduction) + '" style="font-size:11px;color:var(--text-secondary)">(' + (r.deduction > 0 ? '+' : '') + fmt(r.deduction) + ')</span>'
        : '';

      tr.innerHTML =
        '<td style="font-weight:500;cursor:pointer" class="client-name-cell">' +
          '<span class="expand-arrow" style="display:inline-block;margin-right:4px;font-size:10px;transition:transform .2s">▶</span>' +
          r.name +
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
      tr.querySelector('.rev-adj-btn').addEventListener('click', function (e) {
        e.stopPropagation();
        openRevAdj(r.id, r.name, months, deductionsByClientMonth[r.id] || {});
      });

      // Aufklapp-Detail pro Mitarbeiter
      tr.querySelector('.client-name-cell').addEventListener('click', function () {
        var existing = tr.nextElementSibling;
        var arrow = tr.querySelector('.expand-arrow');
        if (existing && existing.classList.contains('detail-emp-row')) {
          existing.remove();
          arrow.style.transform = '';
          return;
        }
        arrow.style.transform = 'rotate(90deg)';

        // Mitarbeiter-Aufschlüsselung aus vorab berechneten (monatsgenauen) Kosten
        var empRows = [];
        var bd = breakdown[r.id] || {};
        Object.keys(bd).forEach(function (eid) {
          var b = bd[eid];
          if (b.hours <= 0 && b.cost <= 0) return;
          empRows.push({ name: b.name, role: b.role, hours: b.hours, cost: b.cost });
        });
        empRows.sort(function (a, b) { return b.hours - a.hours; });

        var detailTr = document.createElement('tr');
        detailTr.className = 'detail-emp-row';
        var html = '<td colspan="6" style="padding:0;border-top:none">' +
          '<div style="background:var(--surface-hover,#f8fafc);border-bottom:1px solid var(--border);padding:8px 16px 8px 36px">' +
          '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
          '<thead><tr>' +
          '<th style="text-align:left;padding:4px 8px;color:var(--text-secondary);font-weight:600">Mitarbeiter</th>' +
          '<th style="text-align:right;padding:4px 8px;color:var(--text-secondary);font-weight:600">Stunden</th>' +
          '<th style="text-align:right;padding:4px 8px;color:var(--text-secondary);font-weight:600">Kosten</th>' +
          '</tr></thead><tbody>';
        if (empRows.length === 0) {
          html += '<tr><td colspan="3" style="padding:6px 8px;color:var(--text-muted);font-style:italic">Keine Stunden gebucht</td></tr>';
        } else {
          empRows.forEach(function (er) {
            html += '<tr>' +
              '<td style="padding:4px 8px">' + er.name + (er.role === 'freelancer' ? ' <span style="font-size:10px;color:var(--text-muted)">(FL)</span>' : '') + '</td>' +
              '<td style="padding:4px 8px;text-align:right;color:var(--text-secondary)">' + er.hours.toFixed(1) + ' h</td>' +
              '<td style="padding:4px 8px;text-align:right;color:#dc2626;font-weight:500">' + fmt(er.cost) + '</td>' +
              '</tr>';
          });
        }
        html += '</tbody></table>';

        // ── Externe / manuelle Kosten (z.B. Freelancer, nicht in Clockify) ──
        var mcRows = manualCostsByClient[r.id] || [];
        html += '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--border)">' +
          '<div style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:6px">Externe / manuelle Kosten</div>';
        mcRows.forEach(function (mc) {
          html += '<div style="display:flex;align-items:center;gap:8px;padding:2px 0;font-size:12px">' +
            '<span style="flex:1">' + mc.name +
              (numMonths > 1 ? ' <span style="color:var(--text-muted);font-size:10px">(' + MONTHS_LABEL[mc.month - 1] + ' ' + mc.year + ')</span>' : '') +
            '</span>' +
            '<span style="color:#dc2626;font-weight:500">' + fmt(Number(mc.amount)) + '</span>' +
            '<button class="mc-del" data-id="' + mc.id + '" title="Löschen" style="border:none;background:none;color:var(--text-muted);cursor:pointer;font-size:15px;line-height:1">×</button>' +
            '</div>';
        });
        html += '<div style="display:flex;gap:6px;margin-top:6px;align-items:center">' +
          '<input class="mc-name" type="text" placeholder="Name (z.B. Freelancer)" style="flex:1;padding:4px 8px;border:1px solid var(--border);border-radius:var(--radius);font-size:12px;background:var(--surface);color:var(--text)">' +
          '<input class="mc-amount" type="number" step="0.01" placeholder="0,00" style="width:90px;text-align:right;padding:4px 8px;border:1px solid var(--border);border-radius:var(--radius);font-size:12px;background:var(--surface);color:var(--text)">' +
          (numMonths > 1
            ? '<select class="mc-month" style="padding:4px;border:1px solid var(--border);border-radius:var(--radius);font-size:12px;background:var(--surface);color:var(--text)">' +
                months.map(function (m) { return '<option value="' + m.year + '-' + m.month + '">' + MONTHS_LABEL[m.month - 1] + ' ' + m.year + '</option>'; }).join('') +
              '</select>'
            : '') +
          '<button class="mc-add btn btn-primary btn-sm" style="font-size:12px;padding:3px 10px">+ Kosten</button>' +
          '</div>' +
          '<div class="mc-err" style="color:#dc2626;font-size:11px;margin-top:4px;display:none"></div>' +
          '</div>';

        html += '</div></td>';
        detailTr.innerHTML = html;

        // Löschen
        Array.prototype.forEach.call(detailTr.querySelectorAll('.mc-del'), function (btn) {
          btn.addEventListener('click', function () {
            btn.disabled = true;
            window.db.manualCosts.delete(btn.getAttribute('data-id'))
              .then(function () { load(); })
              .catch(function (e) { showError('Löschen fehlgeschlagen: ' + e.message); btn.disabled = false; });
          });
        });

        // Hinzufügen
        var addBtn = detailTr.querySelector('.mc-add');
        addBtn.addEventListener('click', function () {
          var nameInp = detailTr.querySelector('.mc-name');
          var amtInp  = detailTr.querySelector('.mc-amount');
          var monSel  = detailTr.querySelector('.mc-month');
          var errEl   = detailTr.querySelector('.mc-err');
          var name    = (nameInp.value || '').trim();
          var amount  = parseFloat(amtInp.value);
          errEl.style.display = 'none';
          if (!name)               { errEl.textContent = 'Bitte einen Namen eingeben.'; errEl.style.display = 'block'; return; }
          if (!amount || amount <= 0) { errEl.textContent = 'Bitte einen Betrag > 0 eingeben.'; errEl.style.display = 'block'; return; }
          var y, mo;
          if (monSel) { var parts = monSel.value.split('-'); y = parseInt(parts[0]); mo = parseInt(parts[1]); }
          else        { y = months[months.length - 1].year; mo = months[months.length - 1].month; }
          addBtn.disabled = true; addBtn.textContent = '…';
          window.db.manualCosts.create(r.id, y, mo, name, amount)
            .then(function () { load(); })
            .catch(function (e) { errEl.textContent = 'Fehler: ' + e.message; errEl.style.display = 'block'; addBtn.disabled = false; addBtn.textContent = '+ Kosten'; });
        });

        tr.after(detailTr);
      });

      profitBody.appendChild(tr);
    });

    // Kategorie-Sammelposten (z.B. Software) – zählen im Gesamtumsatz mit
    Object.keys(gCategoryTotals).sort().forEach(function (c) {
      if (gCategoryTotals[c] <= 0.5) return;
      var cTr = document.createElement('tr');
      cTr.innerHTML =
        '<td style="font-weight:500;color:#1e40af">📦 ' + c + ' <span style="font-size:11px;color:var(--text-secondary)">(Kategorie · Sammelumsatz)</span></td>' +
        '<td class="right revenue">' + fmt(gCategoryTotals[c]) + '</td>' +
        '<td class="right cost"><span class="no-lexoffice">—</span></td>' +
        '<td class="right"><span class="no-lexoffice">—</span></td>' +
        '<td><span class="no-lexoffice">—</span></td>' +
        '<td class="right hours-cell">—</td>';
      profitBody.appendChild(cTr);
    });

    // Sammelposten: nicht zugeordneter Umsatz (zählt im Gesamtumsatz mit)
    if (gUnmappedTotal > 0.5) {
      var uTr = document.createElement('tr');
      uTr.innerHTML =
        '<td style="font-weight:500;color:#92400e">Ohne Zuordnung <span style="font-size:11px;color:var(--text-secondary)">(Sammelumsatz · ' + gUnmapped.length + ' Kontakte)</span></td>' +
        '<td class="right revenue">' + fmt(gUnmappedTotal) + '</td>' +
        '<td class="right cost"><span class="no-lexoffice">—</span></td>' +
        '<td class="right"><span class="no-lexoffice">—</span></td>' +
        '<td><span class="no-lexoffice">—</span></td>' +
        '<td class="right hours-cell">—</td>';
      profitBody.appendChild(uTr);
    }

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

  // ── Resync all stored months ─────────────────────────────────────────
  var resyncAllBtn = document.getElementById('resyncAllBtn');

  function doSyncMonths(months, btn, onDone) {
    btn.disabled = true;
    errorEl.innerHTML = '';
    var supabaseUrl = localStorage.getItem('supabaseUrl') || 'https://lgrnmiszhhahfcmctmwo.supabase.co';
    var supabaseKey = localStorage.getItem('supabaseKey') || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxncm5taXN6aGhhaGZjbWN0bXdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NjE2NDksImV4cCI6MjA4OTIzNzY0OX0.FDZRGMESves7XbAMs_oMLWmvnywMlVqe8p7f1kt06qk';
    var origLabel = btn.textContent.trim();
    var kw = (localStorage.getItem('revenueExcludeKeywords') || '').split('\n').map(function(k){return k.trim();}).filter(Boolean);
    (function syncNext(i) {
      if (i >= months.length) {
        btn.textContent = '✓ Fertig';
        setTimeout(function () { btn.textContent = origLabel; }, 3000);
        btn.disabled = false;
        if (onDone) onDone();
        return;
      }
      var m = months[i];
      var label = MONTHS_LABEL[m.month - 1] + ' ' + m.year;
      btn.textContent = 'Sync ' + label + '… (' + (i + 1) + '/' + months.length + ')';
      fetch(supabaseUrl + '/functions/v1/sync-lexoffice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + supabaseKey, 'apikey': supabaseKey },
        body: JSON.stringify({ lexofficeKey: localStorage.getItem('lexofficeKey'), year: m.year, month: m.month, excludeKeywords: kw }),
      }).then(function (res) {
        return res.json().then(function (data) {
          if (data.error) {
            if (data.error.indexOf('429') !== -1 || data.error.indexOf('Rate limit') !== -1) {
              btn.textContent = 'Rate limit – warte 15s… (' + (i + 1) + '/' + months.length + ')';
              setTimeout(function () { syncNext(i); }, 15000);
              return;
            }
            throw new Error(data.error);
          }
          setTimeout(function () { syncNext(i + 1); }, 3000);
        });
      }).catch(function (e) {
        showError('LexOffice Fehler (' + label + '): ' + e.message);
        btn.textContent = origLabel;
        btn.disabled = false;
      });
    })(0);
  }

  resyncAllBtn.addEventListener('click', function () {
    if (!window.lexoffice.isConfigured()) {
      showError('LexOffice nicht verbunden. Bitte zuerst in den <a href="settings.html">Einstellungen</a> den API Key eintragen.');
      return;
    }
    // Load all distinct year/month combos already in revenue table, then sync all
    resyncAllBtn.disabled = true;
    resyncAllBtn.textContent = 'Lade Monate…';
    window.db.revenue.forMonth && true; // just verify db exists
    var sb = window.createSupabaseClient ? window.createSupabaseClient() : null;
    // Use raw query via db helper
    var supaUrl = localStorage.getItem('supabaseUrl') || 'https://lgrnmiszhhahfcmctmwo.supabase.co';
    var supaKey = localStorage.getItem('supabaseKey') || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxncm5taXN6aGhhaGZjbWN0bXdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NjE2NDksImV4cCI6MjA4OTIzNzY0OX0.FDZRGMESves7XbAMs_oMLWmvnywMlVqe8p7f1kt06qk';
    var client = supabase.createClient(supaUrl, supaKey);
    // Supabase caps each request at ~1000 rows regardless of .limit().
    // Paginate with .range() so ALL months are discovered, not just the first 1000 rows.
    (function () {
      var PAGE = 1000;
      var rowsAcc = [];
      function fetchPage(from) {
        return client.from('revenue').select('year,month')
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1)
          .then(function(res) {
            if (res.error) throw res.error;
            var chunk = res.data || [];
            rowsAcc = rowsAcc.concat(chunk);
            if (chunk.length < PAGE) return { data: rowsAcc };
            return fetchPage(from + PAGE);
          });
      }
      return fetchPage(0);
    })()
      .then(function(res) {
        // Deduplicate year/month combos
        var seen = {};
        var months = [];
        (res.data || []).forEach(function(r) {
          var k = r.year + '-' + r.month;
          if (!seen[k]) { seen[k] = true; months.push({ year: r.year, month: r.month }); }
        });
        if (months.length === 0) {
          resyncAllBtn.textContent = 'Alle Monate neu syncen';
          resyncAllBtn.disabled = false;
          return;
        }
        doSyncMonths(months, resyncAllBtn, load);
      }).catch(function(e) {
        showError('Fehler beim Laden der Monate: ' + e.message);
        resyncAllBtn.textContent = 'Alle Monate neu syncen';
        resyncAllBtn.disabled = false;
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

    doSyncMonths(months, lexSyncBtn, load);
  });

  // ── Boot ──────────────────────────────────────────────────────────────
  if (!window.isConfigured()) {
    setupHint.classList.remove('hidden');
  } else {
    load();
  }
})();
