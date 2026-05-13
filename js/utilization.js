(function () {
  'use strict';

  var yearSel        = document.getElementById('yearSelect');
  var deductHolidays = document.getElementById('deductHolidays');
  var loadBtn        = document.getElementById('loadBtn');
  var tableWrap   = document.getElementById('tableWrap');
  var loadingEl   = document.getElementById('loading');
  var errorEl     = document.getElementById('error');
  var setupHint   = document.getElementById('setupHint');
  var infoBar     = document.getElementById('infoBar');
  var holidayInfo = document.getElementById('holidayInfo');

  // ── Init ──────────────────────────────────────────────────────────────
  (function () {
    var ym = window.currentYearMonth();
    for (var y = ym.year; y >= ym.year - 4; y--) {
      var o = document.createElement('option');
      o.value = y; o.textContent = y;
      yearSel.appendChild(o);
    }
    deductHolidays.checked = localStorage.getItem('deductHolidays') === '1';
  })();

  // Dashlane intercepts clicks on the checkbox itself — listen on label instead
  var deductHolidaysLabel = document.querySelector('label[for="deductHolidays"]');
  if (deductHolidaysLabel) {
    deductHolidaysLabel.addEventListener('click', function () {
      setTimeout(function () {
        localStorage.setItem('deductHolidays', deductHolidays.checked ? '1' : '0');
        loadData();
      }, 0);
    });
  }
  deductHolidays.addEventListener('click', function () {
    localStorage.setItem('deductHolidays', deductHolidays.checked ? '1' : '0');
    loadData();
  });

  // ── Working days ──────────────────────────────────────────────────────
  function getWorkDays(year, month) {
    var count = 0;
    var days  = new Date(year, month, 0).getDate();
    for (var d = 1; d <= days; d++) {
      var dow = new Date(year, month - 1, d).getDay();
      if (dow >= 1 && dow <= 5) count++;
    }
    return count;
  }

  // ── German public holidays ────────────────────────────────────────────
  function getGermanHolidays(year) {
    var a = year%19, b = Math.floor(year/100), c = year%100;
    var d = Math.floor(b/4), e = b%4, f = Math.floor((b+8)/25);
    var g = Math.floor((b-f+1)/3), h = (19*a+b-d-g+15)%30;
    var i = Math.floor(c/4), k = c%4, l = (32+2*e+2*i-h-k)%7;
    var m = Math.floor((a+11*h+22*l)/451);
    var mo = Math.floor((h+l-7*m+114)/31);
    var dy = ((h+l-7*m+114)%31)+1;
    var E  = new Date(year, mo-1, dy);
    function add(dt, n) { var r = new Date(dt); r.setDate(r.getDate()+n); return r; }
    return [
      { name:'Neujahr',                   date: new Date(year,0,1)  },
      { name:'Karfreitag',                date: add(E,-2)           },
      { name:'Ostermontag',               date: add(E,1)            },
      { name:'Tag der Arbeit',            date: new Date(year,4,1)  },
      { name:'Christi Himmelfahrt',       date: add(E,39)           },
      { name:'Pfingstmontag',             date: add(E,50)           },
      { name:'Tag der Deutschen Einheit', date: new Date(year,9,3)  },
      { name:'1. Weihnachtstag',          date: new Date(year,11,25)},
      { name:'2. Weihnachtstag',          date: new Date(year,11,26)},
    ];
  }

  function holidayWorkdaysByMonth(year) {
    var counts = {};
    getGermanHolidays(year).forEach(function (h) {
      var dow = h.date.getDay();
      if (dow >= 1 && dow <= 5) {
        var m = h.date.getMonth() + 1;
        counts[m] = (counts[m] || 0) + 1;
      }
    });
    return counts;
  }

  // ── State helpers ─────────────────────────────────────────────────────
  function showLoading() {
    loadingEl.innerHTML = '<div class="loading-bar"><div class="spinner"></div>Lade Daten…</div>';
    loadingEl.classList.remove('hidden');
    tableWrap.classList.add('hidden');
    infoBar.classList.add('hidden');
    holidayInfo.classList.add('hidden');
    errorEl.innerHTML = '';
  }
  function hideLoading() { loadingEl.classList.add('hidden'); }
  function showError(msg) {
    errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' + msg + '</div>';
    loadingEl.classList.add('hidden');
  }

  // ── Load data ─────────────────────────────────────────────────────────
  function loadData() {
    showLoading();
    var ym          = window.currentYearMonth();
    var year        = parseInt(yearSel.value);
    var subtract    = deductHolidays.checked;
    var holidayDays = subtract ? holidayWorkdaysByMonth(year) : {};

    var available = {}, netAvail = {}, workDays = {};
    for (var m = 1; m <= 12; m++) {
      workDays[m]  = getWorkDays(year, m);
      var effDays  = workDays[m] - (holidayDays[m] || 0);
      available[m] = effDays * 8;
      netAvail[m]  = available[m];
    }

    Promise.all([
      window.db.employees.listActive(),
      window.db.utilHours.forYear(year),
      window.db.entries.forYear(year),
      window.db.clients.list(),
      window.db.absences.forYear(year).catch(function () { return []; }),
    ]).then(function (results) {
      var employees    = results[0];
      var utilData     = results[1];
      var entriesData  = results[2];
      var clientsData  = results[3];
      var absencesData = results[4];

      if (!employees.length) {
        hideLoading();
        errorEl.innerHTML = '<div class="state-box"><div class="icon">👥</div><h3>Keine aktiven Mitarbeiter</h3><p>Lege zuerst <a href="employees.html">Mitarbeiter</a> an.</p></div>';
        return;
      }

      // util_hours per employee per month (total + intern)
      var empEntries = {};
      var empIntern  = {};
      utilData.forEach(function (u) {
        if (!empEntries[u.employee_id]) empEntries[u.employee_id] = {};
        empEntries[u.employee_id][u.month] = u.hours || 0;
        if (!empIntern[u.employee_id]) empIntern[u.employee_id] = {};
        empIntern[u.employee_id][u.month] = u.intern_hours || 0;
      });

      // entries per employee per month (for forecast)
      var entriesPerEmp = {};
      entriesData.forEach(function (e) {
        if (!entriesPerEmp[e.employee_id]) entriesPerEmp[e.employee_id] = {};
        entriesPerEmp[e.employee_id][e.month] =
          (entriesPerEmp[e.employee_id][e.month] || 0) + (e.hours || 0);
      });

      // client breakdown per employee per month (for modal)
      var clientMap = {};
      clientsData.forEach(function (c) { clientMap[c.id] = c; });

      var clientBreakdown = {};
      entriesData.forEach(function (e) {
        if (!clientBreakdown[e.employee_id]) clientBreakdown[e.employee_id] = {};
        if (!clientBreakdown[e.employee_id][e.month]) clientBreakdown[e.employee_id][e.month] = {};
        var cid = e.client_id;
        clientBreakdown[e.employee_id][e.month][cid] =
          (clientBreakdown[e.employee_id][e.month][cid] || 0) + (e.hours || 0);
      });

      // absence map: { empId: { month: { vacation, sick } } }
      var absenceMap = {};
      absencesData.forEach(function (a) {
        if (!absenceMap[a.employee_id]) absenceMap[a.employee_id] = {};
        absenceMap[a.employee_id][a.month] = {
          vacation: a.vacation_days || 0,
          sick:     a.sick_days     || 0,
        };
      });

      // forecast per employee per future month
      var forecastByEmp = {};
      var avgByEmp = {};
      employees.forEach(function (emp) {
        var monthMap = entriesPerEmp[emp.id] || {};
        var recent = [];
        for (var fm2 = ym.month; fm2 >= 1 && recent.length < 3; fm2--) {
          if (monthMap[fm2] > 0) recent.push(monthMap[fm2]);
        }
        if (recent.length > 0) {
          avgByEmp[emp.id] = recent.reduce(function (a, b) { return a + b; }, 0) / recent.length;
        }
      });

      if (year === ym.year && ym.month < 12) {
        for (var fm = ym.month + 1; fm <= 12; fm++) {
          employees.forEach(function (emp) {
            var budgetSum = 0;
            clientsData.forEach(function (c) {
              if (c.contract_start) {
                var cs = new Date(c.contract_start);
                var csY = cs.getUTCFullYear(), csM = cs.getUTCMonth() + 1;
                if (csY > year || (csY === year && fm < csM)) return;
              }
              if (c.is_project && c.project_end) {
                var pe = new Date(c.project_end);
                var peY = pe.getUTCFullYear(), peM = pe.getUTCMonth() + 1;
                if (year > peY || (year === peY && fm > peM)) return;
              }
              if (c.am_employee_id  === emp.id && c.am_budget)  budgetSum += c.am_budget;
              if (c.adv_employee_id === emp.id && c.adv_budget) budgetSum += c.adv_budget;
            });
            var clientHours = budgetSum > 0 ? budgetSum : (avgByEmp[emp.id] || 0);
            if (clientHours > 0) {
              if (!forecastByEmp[emp.id]) forecastByEmp[emp.id] = {};
              forecastByEmp[emp.id][fm] = Math.round(clientHours * 4) / 4;
            }
          });
        }
      }

      // internal % from util_hours.intern_hours
      var internalPctByEmp = {};
      employees.forEach(function (emp) {
        internalPctByEmp[emp.id] = {};
        for (var mi = 1; mi <= 12; mi++) {
          var tot    = (empEntries[emp.id] || {})[mi] || 0;
          var intern = (empIntern[emp.id]  || {})[mi] || 0;
          if (tot > 0 && intern > 0) {
            internalPctByEmp[emp.id][mi] = Math.round(intern / tot * 100);
          }
        }
      });

      renderTable(employees, empEntries, empIntern, forecastByEmp, internalPctByEmp,
                  available, netAvail, workDays, year, subtract, holidayDays,
                  clientBreakdown, clientMap, absenceMap);
      renderHolidayInfo(year);
      hideLoading();
      tableWrap.classList.remove('hidden');
      holidayInfo.classList.remove('hidden');
    }).catch(function (e) {
      showError('Fehler: ' + e.message);
    });
  }

  // ── Donut chart (pure SVG) ────────────────────────────────────────────
  function buildDonut(segments, size) {
    var R  = size / 2;
    var r  = R * 0.58;
    var cx = R, cy = R;
    var total = segments.reduce(function (s, x) { return s + x.value; }, 0);
    if (!total) return '<svg width="' + size + '" height="' + size + '"></svg>';

    if (segments.length === 1) {
      return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
        '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="' + segments[0].color + '"/>' +
        '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="var(--surface)"/>' +
        '</svg>';
    }

    var paths = '';
    var startAngle = -Math.PI / 2;

    segments.forEach(function (seg) {
      var sweep    = (seg.value / total) * Math.PI * 2;
      var endAngle = startAngle + sweep;
      var large    = sweep > Math.PI ? 1 : 0;

      var ox1 = cx + R * Math.cos(startAngle);
      var oy1 = cy + R * Math.sin(startAngle);
      var ox2 = cx + R * Math.cos(endAngle);
      var oy2 = cy + R * Math.sin(endAngle);
      var ix1 = cx + r * Math.cos(endAngle);
      var iy1 = cy + r * Math.sin(endAngle);
      var ix2 = cx + r * Math.cos(startAngle);
      var iy2 = cy + r * Math.sin(startAngle);

      var d = 'M ' + ox1.toFixed(2) + ' ' + oy1.toFixed(2) +
              ' A ' + R + ' ' + R + ' 0 ' + large + ' 1 ' + ox2.toFixed(2) + ' ' + oy2.toFixed(2) +
              ' L ' + ix1.toFixed(2) + ' ' + iy1.toFixed(2) +
              ' A ' + r + ' ' + r + ' 0 ' + large + ' 0 ' + ix2.toFixed(2) + ' ' + iy2.toFixed(2) +
              ' Z';

      paths += '<path d="' + d + '" fill="' + seg.color + '"/>';
      startAngle = endAngle;
    });

    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
      paths + '</svg>';
  }

  // ── Month detail modal ────────────────────────────────────────────────
  var CHART_COLORS = [
    '#4f46e5','#10b981','#f59e0b','#06b6d4',
    '#ef4444','#8b5cf6','#ec4899','#84cc16',
    '#f97316','#14b8a6','#3b82f6','#a78bfa',
  ];
  var INTERN_COLOR = '#94a3b8';

  function showMonthDetail(emp, month, year, clientBreakdown, clientMap,
                           empIntern, utilTotal, empAvailForMonth) {
    var existing = document.getElementById('util-month-modal');
    if (existing) existing.remove();

    var monthName = window.MONTHS_DE[month - 1];
    var avail     = empAvailForMonth || 0;

    // Client segments
    var raw = (clientBreakdown[emp.id] || {})[month] || {};
    var segments = Object.keys(raw).map(function (cid) {
      return { name: (clientMap[cid] || {}).name || 'Unbekannt', hours: raw[cid], isIntern: false };
    }).sort(function (a, b) { return b.hours - a.hours; });

    segments.forEach(function (s, i) { s.color = CHART_COLORS[i % CHART_COLORS.length]; });

    // Intern segment
    var internHrs = (empIntern[emp.id] || {})[month] || 0;
    if (internHrs > 0) {
      segments.push({ name: 'Intern', hours: internHrs, color: INTERN_COLOR, isIntern: true });
    }

    // Sonstige = util_hours − known entries − intern
    var knownSum = segments.reduce(function (s, x) { return s + x.hours; }, 0);
    var otherHrs = (utilTotal || 0) - knownSum;
    if (otherHrs > 0.1) {
      segments.push({ name: 'Sonstige Kunden', hours: Math.round(otherHrs * 4) / 4,
                      color: '#cbd5e1', isOther: true });
    }

    var totalHrs = utilTotal || knownSum;

    // Sync warning: entries sum > util_hours (synced at different times)
    var entriesSum = knownSum; // includes client + intern + other
    var hasSyncWarning = (knownSum - (utilTotal || 0)) > 0.3;

    // Recalculate percentages on totalHrs
    segments.forEach(function (s) {
      s.pct = totalHrs > 0 ? Math.round(s.hours / totalHrs * 100) : 0;
    });

    var utilPct = avail > 0 ? Math.round(totalHrs / avail * 100) : 0;
    var donutSvg = buildDonut(
      segments.map(function (s) { return { value: s.hours, color: s.color }; }),
      160
    );

    var clientSegments = segments.filter(function (s) { return !s.isIntern && !s.isOther; });
    var clientTotal    = clientSegments.reduce(function (s, x) { return s + x.hours; }, 0);

    var rowHtml = function (s) {
      var dimmed = s.isIntern || s.isOther;
      return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-light)' + (dimmed ? ';opacity:.75' : '') + '">' +
        '<div style="width:10px;height:10px;border-radius:' + (s.isOther ? '2px' : '50%') + ';background:' + s.color + ';flex-shrink:0"></div>' +
        '<div style="flex:1;font-size:13px;font-weight:500;color:' + (dimmed ? 'var(--text-secondary)' : 'var(--text)') + '">' + s.name + '</div>' +
        '<div style="font-size:13px;font-variant-numeric:tabular-nums;font-weight:600">' + window.fmtHours(s.hours) + '</div>' +
        '<div style="font-size:12px;color:var(--text-muted);width:36px;text-align:right">' + s.pct + '%</div>' +
      '</div>';
    };

    var listHtml;
    if (segments.length) {
      var clientRows = clientSegments.map(rowHtml).join('');
      var internRow  = internHrs > 0
        ? rowHtml({ name: 'Intern', hours: internHrs, color: INTERN_COLOR, isIntern: true,
                    pct: totalHrs > 0 ? Math.round(internHrs / totalHrs * 100) : 0 })
        : '';
      var otherSeg = segments.find(function (s) { return s.isOther; });
      var otherRow = otherSeg ? rowHtml(otherSeg) : '';

      listHtml =
        (clientRows || '<div style="padding:8px 0;font-size:12.5px;color:var(--text-muted)">Keine Kundenstunden erfasst</div>') +
        (clientSegments.length
          ? '<div style="display:flex;justify-content:space-between;padding:7px 0;font-size:12.5px;border-bottom:1px solid var(--border);color:var(--text-muted)">' +
              '<span>Kundenstunden</span>' +
              '<span style="font-variant-numeric:tabular-nums">' + window.fmtHours(clientTotal) + '</span>' +
            '</div>'
          : '') +
        internRow +
        otherRow +
        '<div style="display:flex;justify-content:space-between;padding-top:9px;font-size:13px">' +
          '<span style="font-weight:700">Gesamt</span>' +
          '<span style="font-weight:700;font-variant-numeric:tabular-nums">' + window.fmtHours(totalHrs) + '</span>' +
        '</div>' +
        (hasSyncWarning
          ? '<div style="margin-top:10px;padding:8px 10px;background:#fef9c3;border:1px solid #fde68a;border-radius:6px;font-size:11.5px;color:#92400e">' +
              '⚠️ Kundenstunden übersteigen Gesamtstunden – Daten wurden zu unterschiedlichen Zeitpunkten synchronisiert. Bitte neu synchronisieren.' +
            '</div>'
          : '');
    } else {
      listHtml = '<div style="text-align:center;padding:20px 0;color:var(--text-muted);font-size:13px">Keine Stunden für diesen Monat</div>';
    }

    var modal = document.createElement('div');
    modal.id = 'util-month-modal';
    modal.style.cssText =
      'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;' +
      'padding:20px;background:rgba(15,23,42,.45);backdrop-filter:blur(3px)';

    modal.innerHTML =
      '<div style="background:var(--surface);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.22);' +
              'width:100%;max-width:540px;max-height:90vh;overflow-y:auto">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;' +
                'padding:18px 20px;border-bottom:1px solid var(--border)">' +
          '<div>' +
            '<div style="font-size:16px;font-weight:700">' + emp.name + '</div>' +
            '<div style="font-size:12.5px;color:var(--text-secondary);margin-top:2px">' +
              monthName + ' ' + year +
              ' &nbsp;·&nbsp; ' + window.fmtHours(totalHrs) + ' von ' + window.fmtHours(avail) +
              ' &nbsp;·&nbsp; <strong style="color:' +
                (utilPct > 100 ? '#dc2626' : utilPct > 80 ? '#d97706' : '#059669') +
              '">' + utilPct + '%</strong> Auslastung' +
            '</div>' +
          '</div>' +
          '<button id="util-modal-close" style="border:none;background:var(--bg);color:var(--text-secondary);' +
                  'border-radius:6px;width:32px;height:32px;font-size:20px;cursor:pointer;' +
                  'display:flex;align-items:center;justify-content:center;line-height:1;flex-shrink:0">×</button>' +
        '</div>' +
        '<div style="padding:20px;display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap">' +
          '<div style="position:relative;display:flex;align-items:center;justify-content:center;flex-shrink:0">' +
            donutSvg +
            '<div style="position:absolute;text-align:center;pointer-events:none;user-select:none">' +
              '<div style="font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.2">' +
                window.fmtHours(totalHrs) +
              '</div>' +
              '<div style="font-size:11px;color:var(--text-muted);margin-top:1px">' + utilPct + '%</div>' +
            '</div>' +
          '</div>' +
          '<div style="flex:1;min-width:200px">' + listHtml + '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);
    document.getElementById('util-modal-close').addEventListener('click', function () { modal.remove(); });
    modal.addEventListener('click', function (e) { if (e.target === modal) modal.remove(); });
    function onKey(e) { if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', onKey); } }
    document.addEventListener('keydown', onKey);
  }

  // ── Absence editor popover ────────────────────────────────────────────
  function showAbsenceEditor(empId, empName, month, year, current, onSaved) {
    var existing = document.getElementById('util-abs-popover');
    if (existing) existing.remove();

    var monthName = window.MONTHS_DE[month - 1];
    var vac  = current.vacation || 0;
    var sick = current.sick     || 0;

    var pop = document.createElement('div');
    pop.id = 'util-abs-popover';
    pop.style.cssText =
      'position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;' +
      'padding:20px;background:rgba(15,23,42,.3);backdrop-filter:blur(2px)';

    pop.innerHTML =
      '<div style="background:var(--surface);border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.18);' +
              'width:100%;max-width:320px;overflow:hidden">' +
        '<div style="padding:14px 16px;border-bottom:1px solid var(--border);' +
                'font-size:14px;font-weight:600">' +
          empName + ' · ' + monthName + ' ' + year +
        '</div>' +
        '<div style="padding:16px;display:flex;flex-direction:column;gap:12px">' +
          '<div style="display:flex;align-items:center;gap:10px">' +
            '<span style="font-size:18px">🏖</span>' +
            '<label style="flex:1;font-size:13px;font-weight:500">Urlaubstage</label>' +
            '<div style="display:flex;align-items:center;gap:6px">' +
              '<button class="abs-dec" data-target="vac" style="' + absBtn() + '">−</button>' +
              '<input id="abs-vac" type="number" min="0" max="30" value="' + vac + '" ' +
                'style="width:52px;text-align:center;padding:5px 6px;border:1px solid var(--border);' +
                'border-radius:6px;font-size:14px;font-variant-numeric:tabular-nums">' +
              '<button class="abs-inc" data-target="vac" style="' + absBtn() + '">+</button>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:10px">' +
            '<span style="font-size:18px">🤒</span>' +
            '<label style="flex:1;font-size:13px;font-weight:500">Krankheitstage</label>' +
            '<div style="display:flex;align-items:center;gap:6px">' +
              '<button class="abs-dec" data-target="sick" style="' + absBtn() + '">−</button>' +
              '<input id="abs-sick" type="number" min="0" max="30" value="' + sick + '" ' +
                'style="width:52px;text-align:center;padding:5px 6px;border:1px solid var(--border);' +
                'border-radius:6px;font-size:14px;font-variant-numeric:tabular-nums">' +
              '<button class="abs-inc" data-target="sick" style="' + absBtn() + '">+</button>' +
            '</div>' +
          '</div>' +
          '<div style="font-size:11.5px;color:var(--text-muted);text-align:center">Jeder Tag zieht 8h von der verfügbaren Arbeitszeit ab</div>' +
        '</div>' +
        '<div style="padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">' +
          '<button id="abs-cancel" style="' + secBtn() + '">Abbrechen</button>' +
          '<button id="abs-save" style="' + priBtn() + '">Speichern</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(pop);

    var vacInput  = document.getElementById('abs-vac');
    var sickInput = document.getElementById('abs-sick');

    // +/− buttons
    pop.querySelectorAll('.abs-dec, .abs-inc').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var inp = btn.getAttribute('data-target') === 'vac' ? vacInput : sickInput;
        var val = parseInt(inp.value) || 0;
        var delta = btn.classList.contains('abs-inc') ? 1 : -1;
        inp.value = Math.max(0, val + delta);
      });
    });

    document.getElementById('abs-cancel').addEventListener('click', function () { pop.remove(); });
    pop.addEventListener('click', function (e) { if (e.target === pop) pop.remove(); });

    function onKey(e) { if (e.key === 'Escape') { pop.remove(); document.removeEventListener('keydown', onKey); } }
    document.addEventListener('keydown', onKey);

    document.getElementById('abs-save').addEventListener('click', function () {
      var newVac  = Math.max(0, parseInt(vacInput.value)  || 0);
      var newSick = Math.max(0, parseInt(sickInput.value) || 0);
      var btn = document.getElementById('abs-save');
      btn.disabled = true;
      btn.textContent = 'Speichern…';
      window.db.absences.upsert(empId, year, month, newVac, newSick)
        .then(function () {
          pop.remove();
          onSaved();
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = 'Speichern';
          alert('Fehler beim Speichern: ' + err.message);
        });
    });
  }

  function absBtn() {
    return 'width:24px;height:24px;border:1px solid var(--border);background:var(--bg);' +
           'border-radius:5px;font-size:15px;cursor:pointer;display:flex;align-items:center;' +
           'justify-content:center;color:var(--text-secondary);line-height:1;padding:0';
  }
  function priBtn() {
    return 'padding:7px 16px;background:var(--primary);color:#fff;border:none;border-radius:7px;' +
           'font-size:13px;font-weight:600;cursor:pointer';
  }
  function secBtn() {
    return 'padding:7px 16px;background:var(--bg);color:var(--text-secondary);border:1px solid var(--border);' +
           'border-radius:7px;font-size:13px;font-weight:500;cursor:pointer';
  }

  // ── Render table ──────────────────────────────────────────────────────
  function renderTable(employees, empEntries, empIntern, forecastByEmp, internalPctByEmp,
                       available, netAvail, workDays, year, subtract, holidayDays,
                       clientBreakdown, clientMap, absenceMap) {
    var ym = window.currentYearMonth();

    // Info bar (team-level, no personal absences here)
    infoBar.innerHTML = '<div class="stats-row">' +
      window.MONTHS_DE.map(function (mn, i) {
        var m = i + 1;
        var isFuture = year > ym.year || (year === ym.year && m > ym.month);
        var dayLabel = subtract && holidayDays[m]
          ? (workDays[m] - holidayDays[m]) + ' AT <span style="color:var(--text-muted)">(-' + holidayDays[m] + ' FT)</span>'
          : workDays[m] + ' AT';
        return '<div class="stat-card" style="padding:10px 14px' + (isFuture ? ';opacity:.6' : '') + '">' +
          '<div class="label" style="font-size:10px">' + mn.substring(0,3) + '</div>' +
          '<div style="font-size:13px;font-weight:600;font-variant-numeric:tabular-nums' + (isFuture ? ';font-style:italic' : '') + '">' +
            window.fmtHours(netAvail[m]) +
          '</div>' +
          '<div style="font-size:10px;color:var(--text-muted)">' + dayLabel + '</div>' +
        '</div>';
      }).join('') +
    '</div>';
    infoBar.classList.remove('hidden');

    var html = '<div class="table-wrap"><table>';

    html += '<thead><tr>' +
      '<th style="min-width:160px;position:sticky;left:0;background:var(--bg);z-index:1">Mitarbeiter</th>' +
      '<th style="min-width:80px">Rolle</th>';
    window.MONTHS_DE.forEach(function (mn, i) {
      var m = i + 1;
      var isFuture = year > ym.year || (year === ym.year && m > ym.month);
      var hdNote = window.fmtHours(netAvail[m]);
      if (subtract && holidayDays[m]) hdNote += ' <span style="color:var(--text-muted)">-' + holidayDays[m] + 'FT</span>';
      html += '<th class="center util-bar-cell" style="min-width:95px' + (isFuture ? ';opacity:.6' : '') + '">' +
        mn.substring(0,3) +
        '<div style="font-size:9px;font-weight:400;color:var(--text-muted);margin-top:1px' + (isFuture ? ';font-style:italic' : '') + '">' + hdNote + '</div>' +
        '</th>';
    });
    html += '<th class="right" style="min-width:90px">Gesamt</th></tr></thead><tbody>';

    employees.forEach(function (emp) {
      var monthMap = empEntries[emp.id] || {};
      var total = 0;
      var cells = '';

      window.MONTHS_DE.forEach(function (mn, i) {
        var m = i + 1;
        var isFuture = year > ym.year || (year === ym.year && m > ym.month);
        var hrs = monthMap[m] || 0;
        total += hrs;

        if (isFuture) {
          var fcastClient = (forecastByEmp[emp.id] || {})[m] || 0;
          var fcast = fcastClient ? Math.round((fcastClient + netAvail[m] * 0.15) * 4) / 4 : null;
          if (fcast) {
            var fnet = netAvail[m];
            var fPct = fnet > 0 ? (fcast / fnet) * 100 : 0;
            var fCls = fPct > 100 ? 'high' : fPct > 80 ? 'medium' : 'low';
            var fW   = Math.min(fPct, 100).toFixed(0);
            cells += '<td class="center util-bar-cell" style="opacity:.5">' +
              '<div class="util-bar-wrap">' +
                '<div style="font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;margin-bottom:2px;font-style:italic">~' + window.fmtHours(fcast) + '</div>' +
                '<div class="util-bar-track"><div class="util-bar-fill ' + fCls + '" style="width:' + fW + '%;background-image:repeating-linear-gradient(45deg,transparent,transparent 3px,rgba(255,255,255,.35) 3px,rgba(255,255,255,.35) 6px)"></div></div>' +
                '<div class="util-bar-label" style="font-style:italic">~' + Math.round(fPct) + '%</div>' +
                '<div style="font-size:9px;color:var(--text-muted);font-style:italic;margin-top:1px">15% intern</div>' +
              '</div>' +
            '</td>';
          } else {
            cells += '<td class="center util-bar-cell"><span class="text-muted" style="font-size:12px">—</span></td>';
          }
          return;
        }

        // Per-employee available hours (subtract absences)
        var absData  = (absenceMap[emp.id] || {})[m] || {};
        var vacDays  = absData.vacation || 0;
        var sickDays = absData.sick     || 0;
        var absDays  = vacDays + sickDays;
        var empNet   = Math.max(0, netAvail[m] - absDays * 8);

        var pctUsed = empNet > 0 ? (hrs / empNet) * 100 : (hrs > 0 ? 100 : 0);
        var fillCls = pctUsed > 100 ? 'high' : pctUsed > 80 ? 'medium' : 'low';
        var fillW   = Math.min(pctUsed, 100).toFixed(0);
        var intPct  = (internalPctByEmp[emp.id] || {})[m];
        var hasData = hrs > 0;

        // Absence badge line
        var absLine = '';
        if (absDays > 0) {
          absLine = '<div style="font-size:9px;color:var(--text-muted);margin-top:2px;line-height:1.4">';
          if (vacDays  > 0) absLine += '🏖 ' + vacDays + 'd&nbsp;';
          if (sickDays > 0) absLine += '🤒 ' + sickDays + 'd';
          absLine += '</div>';
        }

        // Absence edit trigger (always shown, subtle)
        var absEditTrigger =
          '<div data-abs-emp-id="' + emp.id + '" data-abs-month="' + m + '" ' +
               'data-abs-emp-name="' + emp.name + '" ' +
               'class="abs-edit-btn" ' +
               'style="font-size:9px;color:var(--primary);cursor:pointer;margin-top:2px;opacity:0;transition:opacity .15s">' +
            (absDays > 0 ? '✏ bearbeiten' : '+ Urlaub / Krank') +
          '</div>';

        var clickAttrs = hasData
          ? ' data-emp-id="' + emp.id + '" data-month="' + m + '" class="center util-bar-cell util-month-clickable' + (pctUsed > 100 ? ' cell-over' : '') + '"'
          : ' class="center util-bar-cell' + (pctUsed > 100 ? ' cell-over' : '') + '"';

        cells += '<td' + clickAttrs + '>' +
          '<div class="util-bar-wrap">' +
            '<div style="font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;margin-bottom:2px">' +
              (hrs > 0 ? window.fmtHours(hrs) : '<span class="text-muted">—</span>') +
            '</div>' +
            (hrs > 0 ? '<div class="util-bar-track"><div class="util-bar-fill ' + fillCls + '" style="width:' + fillW + '%"></div></div>' : '') +
            (hrs > 0 ? '<div class="util-bar-label">' + Math.round(pctUsed) + '%</div>' : '') +
            (hrs > 0 && intPct !== undefined ? '<div style="font-size:9px;color:var(--text-muted);margin-top:1px">' + intPct + '% intern</div>' : '') +
            absLine +
            absEditTrigger +
          '</div>' +
        '</td>';
      });

      var empFcastMap = forecastByEmp[emp.id] || {};
      var projected = null;
      if (Object.keys(empFcastMap).length > 0) {
        var projSum = 0;
        for (var pm = ym.month + 1; pm <= 12; pm++) {
          var pmClient = empFcastMap[pm] || 0;
          if (pmClient > 0) projSum += pmClient + netAvail[pm] * 0.15;
        }
        if (projSum > 0) projected = total + Math.round(projSum * 4) / 4;
      }

      html += '<tr>' +
        '<td style="font-weight:500;position:sticky;left:0;background:var(--surface);z-index:1">' + emp.name + '</td>' +
        '<td><span class="role-badge ' + window.getRoleCls(emp.role) + '">' + window.getRoleShort(emp.role) + '</span></td>' +
        cells +
        '<td class="right" style="font-variant-numeric:tabular-nums">' +
          '<div style="font-weight:600">' + (total > 0 ? window.fmtHours(total) : '—') + '</div>' +
          (projected ? '<div style="font-size:11px;color:var(--text-muted);font-style:italic;margin-top:2px">~' + window.fmtHours(projected) + ' Prog.</div>' : '') +
        '</td>' +
      '</tr>';
    });

    html += '</tbody></table></div>';

    var hasForecast = Object.keys(forecastByEmp).length > 0;
    if (hasForecast) {
      html += '<div style="margin-top:10px;font-size:11px;color:var(--text-muted);padding:0 4px">' +
        '<span style="opacity:.5;font-style:italic">~ Prognose</span> · Summe Kundenbudgets (AM+ADV) + 15% der verfügbaren Stunden · gedimmte Zellen = Schätzwerte</div>';
    }

    tableWrap.innerHTML = html;

    // Hover: show absence edit trigger
    tableWrap.addEventListener('mouseover', function (e) {
      var td = e.target.closest('td');
      if (!td) return;
      var btn = td.querySelector('.abs-edit-btn');
      if (btn) btn.style.opacity = '1';
    });
    tableWrap.addEventListener('mouseout', function (e) {
      var td = e.target.closest('td');
      if (!td) return;
      var btn = td.querySelector('.abs-edit-btn');
      if (btn) btn.style.opacity = '0';
    });

    // Event delegation
    tableWrap.addEventListener('click', function (e) {

      // Absence edit click (higher priority)
      var absEl = e.target.closest('[data-abs-emp-id]');
      if (absEl) {
        e.stopPropagation();
        var empId    = absEl.getAttribute('data-abs-emp-id');
        var month    = parseInt(absEl.getAttribute('data-abs-month'), 10);
        var empName  = absEl.getAttribute('data-abs-emp-name');
        var yr       = parseInt(yearSel.value);
        var current  = (absenceMap[empId] || {})[month] || { vacation: 0, sick: 0 };
        showAbsenceEditor(empId, empName, month, yr, current, function () { loadData(); });
        return;
      }

      // Month detail click
      var td = e.target.closest('td.util-month-clickable');
      if (!td) return;
      var empId    = td.getAttribute('data-emp-id');
      var month    = parseInt(td.getAttribute('data-month'), 10);
      var yr       = parseInt(yearSel.value);
      var emp      = employees.find(function (em) { return em.id === empId; });
      if (!emp) return;
      var utilTotal = (empEntries[empId] || {})[month] || 0;
      var absData   = (absenceMap[empId] || {})[month] || {};
      var absDays   = (absData.vacation || 0) + (absData.sick || 0);
      var empAvail  = Math.max(0, (netAvail[month] || 0) - absDays * 8);
      showMonthDetail(emp, month, yr, clientBreakdown, clientMap, empIntern, utilTotal, empAvail);
    });
  }

  // ── Holiday info ──────────────────────────────────────────────────────
  function renderHolidayInfo(year) {
    var holidays  = getGermanHolidays(year);
    var deducting = deductHolidays.checked;
    var label = deducting
      ? 'Bundesweite Feiertage ' + year + ' – werden als Abzug berechnet (nur Mo–Fr)'
      : 'Bundesweite Feiertage ' + year + ' (nur Info – nicht als Abzug berechnet)';
    var html = '<div class="card" style="padding:16px 20px">' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:10px">' + label + '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px 20px">';
    var opts = { day: '2-digit', month: '2-digit' };
    holidays.forEach(function (h) {
      var dow = h.date.getDay();
      var isWeekend = dow === 0 || dow === 6;
      var dimmed = deducting && isWeekend ? ';opacity:.45' : '';
      html += '<span style="font-size:12.5px;color:var(--text-secondary)' + dimmed + '">' +
        '<strong style="font-variant-numeric:tabular-nums">' + h.date.toLocaleDateString('de-DE', opts) + '</strong> ' + h.name +
        (isWeekend ? ' <span style="font-size:10px;color:var(--text-muted)">(WE)</span>' : '') +
        '</span>';
    });
    html += '</div></div>';
    holidayInfo.innerHTML = html;
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  if (!window.isConfigured()) {
    setupHint.classList.remove('hidden');
  } else {
    loadData();
  }
  loadBtn.addEventListener('click', loadData);
})();
