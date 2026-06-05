(function () {
  'use strict';

  var yearSel  = document.getElementById('yearSelect');
  var metricSel= document.getElementById('metricSelect');
  var loadBtn  = document.getElementById('loadBtn');
  var loadingEl= document.getElementById('loading');
  var contentEl= document.getElementById('content');
  var errorEl  = document.getElementById('error');
  var gridBody = document.getElementById('gridBody');
  var gridHead = document.getElementById('gridHead');
  var scenarioWrap = document.getElementById('scenarioWrap');

  var MONTHS = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  var ym = window.currentYearMonth();

  // ── Jahr-Auswahl ──────────────────────────────────────────────────────
  for (var y = ym.year + 1; y >= ym.year - 3; y--) {
    var o = document.createElement('option'); o.value = y; o.textContent = y; yearSel.appendChild(o);
  }
  yearSel.value = ym.year;

  function fmtEur(n) { return Math.round(n).toLocaleString('de-DE') + ' €'; }
  function fmtH(n)   { return (Math.round(n * 10) / 10).toLocaleString('de-DE') + ' h'; }
  function norm(s)   { return (s || '').trim().toLowerCase(); }

  function getExcludeKeywords() {
    return (localStorage.getItem('revenueExcludeKeywords') || '')
      .split('\n').map(function (k) { return k.trim().toLowerCase(); }).filter(Boolean);
  }
  function isExcluded(name) {
    var kws = getExcludeKeywords(); if (!kws.length) return false;
    var n = (name || '').toLowerCase();
    return kws.some(function (kw) { return n.includes(kw); });
  }

  // ── Arbeitstage / Feiertage ───────────────────────────────────────────
  function getWorkDays(year, month) {
    var count = 0, days = new Date(year, month, 0).getDate();
    for (var d = 1; d <= days; d++) { var w = new Date(year, month - 1, d).getDay(); if (w >= 1 && w <= 5) count++; }
    return count;
  }
  function holidayWorkdaysByMonth(year) {
    var a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),
        g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,
        m=Math.floor((a+11*h+22*l)/451),mo=Math.floor((h+l-7*m+114)/31),dy=((h+l-7*m+114)%31)+1;
    var E=new Date(year,mo-1,dy); function add(dt,n){var r=new Date(dt);r.setDate(r.getDate()+n);return r;}
    var hs=[new Date(year,0,1),add(E,-2),add(E,1),new Date(year,4,1),add(E,39),add(E,50),
            new Date(year,9,3),new Date(year,11,25),new Date(year,11,26)];
    var counts={}; hs.forEach(function(dt){var w=dt.getDay(); if(w>=1&&w<=5){var mm=dt.getMonth()+1; counts[mm]=(counts[mm]||0)+1;}});
    return counts;
  }

  // ── Szenario (localStorage) ───────────────────────────────────────────
  function loadScenario() {
    try { return JSON.parse(localStorage.getItem('empRevScenario') || '{}'); } catch (e) { return {}; }
  }
  function saveScenario(s) { localStorage.setItem('empRevScenario', JSON.stringify(s)); }
  var scenario = loadScenario();
  if (!scenario.lost) scenario.lost = {};          // { clientId: fromMonth(1-12) }
  if (!scenario.prospects) scenario.prospects = []; // [{id,name,amEmpId,advEmpId,amBudget,advBudget,revenue,startMonth}]

  var DATA = null; // geladene Rohdaten
  var COMP = null; // berechnete Maps (für Drilldown-Modal)

  // "Prognose-Monat" = laufender + zukünftige Monate (Ist ist noch unvollständig)
  function isFuture(year, m) {
    return year > ym.year || (year === ym.year && m >= ym.month);
  }

  // ── Daten laden ───────────────────────────────────────────────────────
  function loadData() {
    var year = parseInt(yearSel.value);
    errorEl.innerHTML = '';
    loadingEl.classList.remove('hidden');
    contentEl.classList.add('hidden');

    var monthNums = [];
    for (var m = 1; m <= 12; m++) monthNums.push(m);

    Promise.all([
      window.db.employees.listActive(),
      window.db.clients.list(),
      window.db.entries.forYear(year),
      window.db.mappings.list(),
      window.db.utilHours.forYear(year),
      window.db.absences.forYear(year).catch(function () { return []; }),
      Promise.all(monthNums.map(function (m) { return window.db.revenue.forMonth(year, m); })),
      Promise.all(monthNums.map(function (m) { return window.db.adjustments.forMonth(year, m).catch(function () { return []; }); })),
    ]).then(function (r) {
      DATA = {
        year: year,
        employees: r[0], clients: r[1], entries: r[2], mappings: r[3],
        utilHours: r[4], absences: r[5], revenueByMonth: r[6], adjByMonth: r[7],
      };
      loadingEl.classList.add('hidden');
      contentEl.classList.remove('hidden');
      compute();
    }).catch(function (e) {
      loadingEl.classList.add('hidden');
      errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' + e.message + '</div>';
    });
  }

  // ── Berechnung (Ist + Forecast + Szenario) ────────────────────────────
  function compute() {
    var year = DATA.year;
    var employees = DATA.employees;
    var clients = DATA.clients;

    // Mappings: clientId → [lexoffice_name]
    var mappingsByClient = {};
    DATA.mappings.forEach(function (mp) {
      (mappingsByClient[mp.client_id] = mappingsByClient[mp.client_id] || []).push(mp.lexoffice_name);
    });

    // Umsatz je Kunde je Monat (Ist) ------------------------------------
    // revenueMap[m] = { normContact → betrag }
    var clientRevMonth = {}; // clientId → {m → revenue}
    for (var m = 1; m <= 12; m++) {
      var revMap = {};
      (DATA.revenueByMonth[m - 1] || []).forEach(function (row) {
        if (isExcluded(row.contact_name)) return;
        var key = norm(row.contact_name);
        revMap[key] = (revMap[key] || 0) + (row.total_amount || 0);
      });
      // Kunden-Umsatzkorrektur (adjustments.revenue_deduction) je Kunde
      var dedByClient = {};
      (DATA.adjByMonth[m - 1] || []).forEach(function (a) {
        dedByClient[a.client_id] = (dedByClient[a.client_id] || 0) + (a.revenue_deduction || 0);
      });
      clients.forEach(function (c) {
        var rev = 0;
        var mapped = mappingsByClient[c.id] || [];
        if (mapped.length) mapped.forEach(function (lx) { rev += revMap[norm(lx)] || 0; });
        else rev = revMap[norm(c.lexoffice_name || c.name)] || revMap[norm(c.name)] || 0;
        rev += dedByClient[c.id] || 0;
        (clientRevMonth[c.id] = clientRevMonth[c.id] || {})[m] = rev;
      });
    }

    // Stunden je Kunde je Monat + je (Kunde,MA) -------------------------
    var clientHoursMonth = {}; // clientId → {m → totalHours}
    var entryByClientEmpMonth = {}; // clientId → m → empId → hours
    DATA.entries.forEach(function (e) {
      var cm = (clientHoursMonth[e.client_id] = clientHoursMonth[e.client_id] || {});
      cm[e.month] = (cm[e.month] || 0) + (e.hours || 0);
      var cc = (entryByClientEmpMonth[e.client_id] = entryByClientEmpMonth[e.client_id] || {});
      var mm = (cc[e.month] = cc[e.month] || {});
      mm[e.employee_id] = (mm[e.employee_id] || 0) + (e.hours || 0);
    });

    // Ist: Umsatz je MA je Monat (nach Stundenanteil) -------------------
    var empRev = {};   // empId → {m → revenue}
    var empHours = {};  // empId → {m → kundenstunden}
    function addRev(empId, m, v) { (empRev[empId] = empRev[empId] || {})[m] = ((empRev[empId] || {})[m] || 0) + v; }
    function addHrs(empId, m, v) { (empHours[empId] = empHours[empId] || {})[m] = ((empHours[empId] || {})[m] || 0) + v; }

    for (var cid in entryByClientEmpMonth) {
      for (var mo in entryByClientEmpMonth[cid]) {
        var total = clientHoursMonth[cid][mo] || 0;
        var rev = (clientRevMonth[cid] && clientRevMonth[cid][mo]) || 0;
        var emps = entryByClientEmpMonth[cid][mo];
        for (var eid in emps) {
          var hrs = emps[eid];
          addHrs(eid, mo, hrs);
          if (total > 0 && rev) addRev(eid, mo, rev * (hrs / total));
        }
      }
    }

    // Kapazität: verfügbare Stunden je MA je Monat ----------------------
    var holiday = holidayWorkdaysByMonth(year);
    var availBase = {};
    for (var mm2 = 1; mm2 <= 12; mm2++) availBase[mm2] = (getWorkDays(year, mm2) - (holiday[mm2] || 0)) * 8;
    var absenceMap = {}; // empId → m → days
    DATA.absences.forEach(function (a) {
      (absenceMap[a.employee_id] = absenceMap[a.employee_id] || {})[a.month] = (a.vacation_days || 0) + (a.sick_days || 0);
    });
    function available(empId, m) { return Math.max(0, availBase[m] - ((absenceMap[empId] || {})[m] || 0) * 8); }

    // util_hours (tatsächliche Gesamtstunden) je MA je Monat
    var utilMap = {};
    DATA.utilHours.forEach(function (u) { (utilMap[u.employee_id] = utilMap[u.employee_id] || {})[u.month] = u.hours || 0; });

    // Abgeschlossene (Ist-)Monate für Durchschnitte
    function completed(m) { return year < ym.year || (year === ym.year && m < ym.month); }
    // Ø der letzten bis zu 3 abgeschlossenen Monate mit Wert
    function avgRecent(getter) {
      var rec = [];
      for (var m = 12; m >= 1 && rec.length < 3; m--) {
        if (!completed(m)) continue;
        var v = getter(m);
        if (v > 0) rec.push(v);
      }
      return rec.length ? rec.reduce(function (a, b) { return a + b; }, 0) / rec.length : 0;
    }
    function avgUtil(empId) {
      return avgRecent(function (m) {
        var u = (utilMap[empId] || {})[m];
        return (u != null && u > 0) ? u : ((empHours[empId] || {})[m] || 0);
      });
    }
    function avgEmpRev(empId) { return avgRecent(function (m) { return (empRev[empId] || {})[m] || 0; }); }
    function avgEmpClientHrs(empId, cid) {
      return avgRecent(function (m) { return (((entryByClientEmpMonth[cid] || {})[m]) || {})[empId] || 0; });
    }
    function avgEmpClientRev(empId, cid) {
      return avgRecent(function (m) {
        var h = (((entryByClientEmpMonth[cid] || {})[m]) || {})[empId] || 0;
        var tot = (clientHoursMonth[cid] || {})[m] || 0;
        var r = (clientRevMonth[cid] || {})[m] || 0;
        return tot > 0 ? r * h / tot : 0;
      });
    }

    // Forecast/Grundlast je MA je laufendem+zukünftigem Monat -----------
    // Grundlast = Ø tatsächl. Stunden/Umsatz der letzten 3 Monate,
    // ± Szenario (verlorene Kunden abziehen, Neukunden addieren).
    var fcRev = {}, fcHours = {};
    employees.forEach(function (emp) {
      var baseH = avgUtil(emp.id);
      var baseR = avgEmpRev(emp.id);
      for (var m = 1; m <= 12; m++) {
        if (!isFuture(year, m)) continue; // nur laufender + zukünftige Monate
        var h = baseH, r = baseR;
        // verlorene Kunden ab Verlustmonat → freigewordene Kapazität/Umsatz abziehen
        clients.forEach(function (c) {
          var lost = scenario.lost[c.id];
          if (!lost || m < lost) return;
          if (c.am_employee_id === emp.id || c.adv_employee_id === emp.id) {
            h -= avgEmpClientHrs(emp.id, c.id);
            r -= avgEmpClientRev(emp.id, c.id);
          }
        });
        // potenzielle Neukunden ab Startmonat → zusätzliche Last/Umsatz
        scenario.prospects.forEach(function (p) {
          if (m < (p.startMonth || 1)) return;
          var amB = +p.amBudget || 0, advB = +p.advBudget || 0, tot = amB + advB, rev = +p.revenue || 0;
          if (p.amEmpId === emp.id) { h += amB; r += tot ? rev * amB / tot : (advB ? 0 : rev); }
          if (p.advEmpId === emp.id) { h += advB; r += tot ? rev * advB / tot : 0; }
        });
        (fcHours[emp.id] = fcHours[emp.id] || {})[m] = Math.max(0, h);
        (fcRev[emp.id] = fcRev[emp.id] || {})[m] = Math.max(0, r);
      }
    });
    var avgHrs = {}; // (nicht mehr separat genutzt)

    // Für Drilldown-Modal speichern
    COMP = {
      year: year, employees: employees, clients: clients,
      entryByClientEmpMonth: entryByClientEmpMonth,
      clientHoursMonth: clientHoursMonth,
      clientRevMonth: clientRevMonth,
    };

    render({
      year: year, employees: employees,
      empRev: empRev, empHours: empHours, utilMap: utilMap,
      fcRev: fcRev, fcHours: fcHours, available: available, avgHrs: avgHrs,
    });
    renderScenario(clients, employees);
  }

  // ── Rendering Hauptgrid ───────────────────────────────────────────────
  function render(M) {
    var metric = metricSel.value; // revenue | hours | free
    var year = M.year;

    // Kopf
    var head = '<th style="min-width:170px">Mitarbeiter</th>';
    for (var m = 1; m <= 12; m++) {
      var fut = isFuture(year, m);
      head += '<th class="right' + (fut ? ' fc' : '') + '">' + MONTHS[m - 1] + (fut ? ' <span class="fc-tag">P</span>' : '') + '</th>';
    }
    head += '<th class="right" style="border-left:2px solid var(--border)">Σ Jahr</th>';
    gridHead.innerHTML = head;

    function valueFor(empId, m) {
      var fut = isFuture(year, m);
      if (metric === 'revenue') {
        return fut ? ((M.fcRev[empId] || {})[m] || 0) : ((M.empRev[empId] || {})[m] || 0);
      }
      if (metric === 'hours') {
        if (fut) return (M.fcHours[empId] || {})[m] || 0;
        // Ist: tatsächliche Gesamtstunden (util_hours) falls vorhanden, sonst Kundenstunden
        var u = (M.utilMap[empId] || {})[m];
        return (u != null && u > 0) ? u : ((M.empHours[empId] || {})[m] || 0);
      }
      // free = verfügbar − gebucht
      var booked = fut ? ((M.fcHours[empId] || {})[m] || 0)
                       : (((M.utilMap[empId] || {})[m] > 0) ? M.utilMap[empId][m] : ((M.empHours[empId] || {})[m] || 0));
      return M.available(empId, m) - booked;
    }

    function fmtVal(v) {
      if (metric === 'revenue') return fmtEur(v);
      return fmtH(v);
    }

    var rows = '';
    var colTot = {}; // m → sum (für Summenzeile bei revenue/hours)
    M.employees.forEach(function (emp) {
      var rowSum = 0;
      var cells = '';
      for (var m = 1; m <= 12; m++) {
        var v = valueFor(emp.id, m);
        var fut = isFuture(year, m);
        rowSum += v;
        colTot[m] = (colTot[m] || 0) + v;
        var cls = 'right' + (fut ? ' fc' : '');
        if (metric === 'free') cls += v < 0 ? ' neg' : (v > 0 ? ' pos' : '');
        cells += '<td class="' + cls + '">' + (v === 0 ? '<span class="muted">–</span>' : fmtVal(v)) + '</td>';
      }
      rows += '<tr class="emp-row" data-emp="' + emp.id + '" title="Klick: Aufschlüsselung nach Kunde"><td class="emp">' + emp.name + ' <span class="role">' + window.getRoleShort(emp.role) + '</span></td>' +
        cells + '<td class="right tot">' + (metric === 'free' ? '' : fmtVal(rowSum)) + '</td></tr>';
    });

    // Summenzeile (nur revenue/hours sinnvoll)
    if (metric !== 'free') {
      var sumCells = ''; var grand = 0;
      for (var m2 = 1; m2 <= 12; m2++) { sumCells += '<td class="right tot">' + fmtVal(colTot[m2] || 0) + '</td>'; grand += colTot[m2] || 0; }
      rows += '<tr class="sum-row"><td class="emp">Gesamt</td>' + sumCells + '<td class="right tot">' + fmtVal(grand) + '</td></tr>';
    }

    gridBody.innerHTML = rows;

    gridBody.querySelectorAll('tr.emp-row').forEach(function (tr) {
      tr.addEventListener('click', function () { openEmpModal(tr.getAttribute('data-emp')); });
    });
  }

  // ── Drilldown-Modal: Aufschlüsselung je Kunde ─────────────────────────
  var modalOv    = document.getElementById('empModal');
  var modalTitle = document.getElementById('empModalTitle');
  var modalSub   = document.getElementById('empModalSub');
  var modalMonth = document.getElementById('empModalMonth');
  var modalBody  = document.getElementById('empModalBody');
  var modalEmpId = null;

  document.getElementById('empModalClose').addEventListener('click', closeModal);
  modalOv.addEventListener('click', function (e) { if (e.target === modalOv) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
  modalMonth.addEventListener('change', renderModalBody);
  function closeModal() { modalOv.classList.remove('open'); }

  function openEmpModal(empId) {
    if (!COMP) return;
    modalEmpId = empId;
    var emp = COMP.employees.find(function (e) { return e.id === empId; });
    modalTitle.textContent = (emp ? emp.name : '?') + ' – Aufschlüsselung nach Kunde';
    modalSub.textContent = 'Umsatz anteilig: MA-Stunden ÷ Kunden-Stunden gesamt × Kunden-Umsatz';
    // Monatsauswahl (nur Ist-Monate, da Forecast budgetbasiert ist)
    var opts = '<option value="all">Ganzes Jahr (Ist)</option>';
    for (var m = 1; m <= 12; m++) {
      if (isFuture(COMP.year, m)) continue;
      opts += '<option value="' + m + '">' + MONTHS[m - 1] + ' ' + COMP.year + '</option>';
    }
    modalMonth.innerHTML = opts;
    modalMonth.value = 'all';
    renderModalBody();
    modalOv.classList.add('open');
  }

  function renderModalBody() {
    var empId = modalEmpId;
    var scope = modalMonth.value; // 'all' | monthNumber
    var clientsById = {};
    COMP.clients.forEach(function (c) { clientsById[c.id] = c; });

    function monthsInScope() {
      if (scope === 'all') {
        var arr = []; for (var m = 1; m <= 12; m++) if (!isFuture(COMP.year, m)) arr.push(m); return arr;
      }
      return [parseInt(scope)];
    }

    var rows = [];
    var totHrs = 0, totRev = 0;
    Object.keys(COMP.entryByClientEmpMonth).forEach(function (cid) {
      var hrs = 0, rev = 0, cTotH = 0, cRev = 0;
      monthsInScope().forEach(function (m) {
        var emps = (COMP.entryByClientEmpMonth[cid][m]) || {};
        var h = emps[empId] || 0;
        if (!h) return;
        var totalH = (COMP.clientHoursMonth[cid] || {})[m] || 0;
        var r = (COMP.clientRevMonth[cid] || {})[m] || 0;
        hrs += h;
        cTotH += totalH;
        cRev += r;
        if (totalH > 0) rev += r * (h / totalH);
      });
      if (hrs > 0) {
        rows.push({ name: (clientsById[cid] || {}).name || '?', hrs: hrs, rev: rev, cTotH: cTotH, cRev: cRev });
        totHrs += hrs; totRev += rev;
      }
    });
    rows.sort(function (a, b) { return b.rev - a.rev || b.hrs - a.hrs; });

    var single = scope !== 'all';
    var html = '<div class="table-wrap"><table class="mini-table"><thead><tr>' +
      '<th>Kunde</th><th class="right">MA-Std</th>' +
      (single ? '<th class="right">Kunden-Std ges.</th><th class="right">Anteil</th><th class="right">Kunden-Umsatz</th>' : '') +
      '<th class="right">MA-Umsatz</th></tr></thead><tbody>';

    if (!rows.length) {
      html += '<tr><td colspan="' + (single ? 6 : 3) + '" class="muted">Keine Stunden in diesem Zeitraum.</td></tr>';
    } else {
      rows.forEach(function (r) {
        var share = (single && r.cTotH > 0) ? (r.hrs / r.cTotH * 100).toFixed(1) + ' %' : '';
        html += '<tr><td>' + r.name + '</td>' +
          '<td class="right">' + fmtH(r.hrs) + '</td>' +
          (single ? '<td class="right">' + fmtH(r.cTotH) + '</td><td class="right">' + share + '</td><td class="right">' + fmtEur(r.cRev) + '</td>' : '') +
          '<td class="right">' + fmtEur(r.rev) + '</td></tr>';
      });
      html += '<tr style="font-weight:700;border-top:2px solid var(--border)"><td>Gesamt</td>' +
        '<td class="right">' + fmtH(totHrs) + '</td>' +
        (single ? '<td></td><td></td><td></td>' : '') +
        '<td class="right">' + fmtEur(totRev) + '</td></tr>';
    }
    html += '</tbody></table></div>';
    modalBody.innerHTML = html;
  }

  // ── Szenario-Panel ────────────────────────────────────────────────────
  function renderScenario(clients, employees) {
    var empOpts = '<option value="">–</option>' + employees.map(function (e) {
      return '<option value="' + e.id + '">' + e.name + '</option>';
    }).join('');

    // Kunden-Status (verloren ab Monat)
    var lostRows = clients.map(function (c) {
      var cur = scenario.lost[c.id] || '';
      var opts = '<option value="">aktiv</option>';
      for (var m = 1; m <= 12; m++) opts += '<option value="' + m + '"' + (cur == m ? ' selected' : '') + '>verloren ab ' + MONTHS[m - 1] + '</option>';
      return '<tr><td>' + c.name + '</td><td><select data-lost="' + c.id + '" class="mini-sel">' + opts + '</select></td></tr>';
    }).join('');

    // Potenzielle Neukunden
    var prospRows = scenario.prospects.map(function (p, i) {
      return '<tr>' +
        '<td>' + (p.name || '(ohne Name)') + '</td>' +
        '<td>' + empName(employees, p.amEmpId) + ' / ' + empName(employees, p.advEmpId) + '</td>' +
        '<td class="right">' + (p.amBudget || 0) + ' / ' + (p.advBudget || 0) + ' h</td>' +
        '<td class="right">' + fmtEur(+p.revenue || 0) + '</td>' +
        '<td>ab ' + MONTHS[(p.startMonth || 1) - 1] + '</td>' +
        '<td class="right"><button class="btn-link-del" data-del="' + i + '">×</button></td>' +
      '</tr>';
    }).join('');

    scenarioWrap.innerHTML =
      '<div class="scn-grid">' +
        '<div class="scn-card">' +
          '<div class="scn-h">Kunden-Status (Forecast)</div>' +
          '<div class="scn-scroll"><table class="mini-table"><tbody>' + lostRows + '</tbody></table></div>' +
        '</div>' +
        '<div class="scn-card">' +
          '<div class="scn-h">Potenzielle Neukunden</div>' +
          '<div class="scn-scroll"><table class="mini-table"><thead><tr><th>Name</th><th>AM / ADV</th><th class="right">Std AM/ADV</th><th class="right">Umsatz/Mon</th><th>Start</th><th></th></tr></thead><tbody>' +
            (prospRows || '<tr><td colspan="6" class="muted">Noch keine.</td></tr>') + '</tbody></table></div>' +
          '<div class="prosp-form">' +
            '<input id="pName" placeholder="Name" class="inp">' +
            '<select id="pAm" class="inp" title="Account Manager">' + empOpts + '</select>' +
            '<select id="pAdv" class="inp" title="Advertising">' + empOpts + '</select>' +
            '<input id="pAmB" type="number" placeholder="Std AM" class="inp inp-s">' +
            '<input id="pAdvB" type="number" placeholder="Std ADV" class="inp inp-s">' +
            '<input id="pRev" type="number" placeholder="Umsatz/Mon €" class="inp inp-s">' +
            '<select id="pStart" class="inp inp-s">' + MONTHS.map(function (mn, i) { return '<option value="' + (i + 1) + '"' + ((i + 1) === ym.month + 1 ? ' selected' : '') + '>' + mn + '</option>'; }).join('') + '</select>' +
            '<button id="pAdd" class="btn btn-primary btn-sm">+ Hinzufügen</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div style="margin-top:10px"><button id="scnReset" class="btn btn-sm">Szenario zurücksetzen</button> <span class="muted" style="font-size:12px">Änderungen wirken nur auf Forecast-Monate (P). Lokal gespeichert.</span></div>';

    // Events
    scenarioWrap.querySelectorAll('select[data-lost]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var cid = sel.getAttribute('data-lost');
        if (sel.value) scenario.lost[cid] = parseInt(sel.value); else delete scenario.lost[cid];
        saveScenario(scenario); compute();
      });
    });
    scenarioWrap.querySelectorAll('button[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        scenario.prospects.splice(parseInt(b.getAttribute('data-del')), 1);
        saveScenario(scenario); compute();
      });
    });
    var addBtn = document.getElementById('pAdd');
    if (addBtn) addBtn.addEventListener('click', function () {
      scenario.prospects.push({
        name: document.getElementById('pName').value.trim(),
        amEmpId: document.getElementById('pAm').value || null,
        advEmpId: document.getElementById('pAdv').value || null,
        amBudget: parseFloat(document.getElementById('pAmB').value) || 0,
        advBudget: parseFloat(document.getElementById('pAdvB').value) || 0,
        revenue: parseFloat(document.getElementById('pRev').value) || 0,
        startMonth: parseInt(document.getElementById('pStart').value) || (ym.month + 1),
      });
      saveScenario(scenario); compute();
    });
    var rst = document.getElementById('scnReset');
    if (rst) rst.addEventListener('click', function () {
      scenario = { lost: {}, prospects: [] }; saveScenario(scenario); compute();
    });
  }

  function empName(employees, id) {
    if (!id) return '–';
    var e = employees.find(function (x) { return x.id === id; });
    return e ? e.name : '–';
  }

  // ── Events / Boot ─────────────────────────────────────────────────────
  loadBtn.addEventListener('click', loadData);
  metricSel.addEventListener('change', function () { if (DATA) compute(); });
  yearSel.addEventListener('change', loadData);
  loadData();
})();
