/* ===========================================================================
 * personal.js – Personal-Seite (Mitarbeiterprofile + Urlaub/Krankheit).
 *
 * Datenmodell:
 *  - employees: Stammdaten + HR-Felder (iban, start_date, work_location, …)
 *    und hr_custom (jsonb) für selbst definierte Felder (Definitionen: hr_fields).
 *  - absence_entries: einzelne Abwesenheiten mit Zeitraum (vacation|sick),
 *    manuell erfasst oder per gcal-Sync aus dem Google-Urlaubskalender.
 *  - employee_absences (Monats-Aggregate, von der Auslastung genutzt) werden
 *    nach jeder Änderung automatisch aus den Einträgen neu berechnet.
 * =========================================================================== */
(function () {
  'use strict';

  var state = {
    employees: [], entries: [], fields: [],
    year: new Date().getFullYear(),
    showInactive: false,
    openEmpId: null,
    modalAllYears: false,   // Abwesenheiten im Profil: standardmäßig nur das gewählte Jahr
  };

  var AVATAR_COLORS = ['#2563eb', '#7c3aed', '#16a34a', '#0891b2', '#db2777', '#ca8a04', '#0d9488', '#dc2626', '#9333ea', '#f59e0b', '#e11d48', '#10b981'];

  // ── Hilfen ─────────────────────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtDays(n) { return (Math.round(n * 100) / 100).toLocaleString('de-DE'); }
  function deDate(iso) { if (!iso) return ''; var p = iso.slice(0, 10).split('-'); return p[2] + '.' + p[1] + '.' + p[0]; }
  function todayIso() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function initials(name) {
    var t = String(name || '?').trim().split(/\s+/);
    return (t[0][0] + (t[1] ? t[1][0] : '')).toUpperCase();
  }
  function avatarColor(name) {
    var h = 0; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
  }
  function showError(msg) {
    el('loading').style.display = 'none';
    var e = el('error'); e.style.display = ''; e.textContent = 'Fehler: ' + msg;
  }

  // ── Arbeitstage (Mo–Fr ohne NRW-Feiertage) ─────────────────────────────────
  function easter(y) {   // Gauß'sche Osterformel → UTC-Datum des Ostersonntags
    var a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4,
      f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30,
      i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7,
      m = Math.floor((a + 11 * h + 22 * l) / 451), mo = Math.floor((h + l - 7 * m + 114) / 31),
      da = ((h + l - 7 * m + 114) % 31) + 1;
    return Date.UTC(y, mo - 1, da);
  }
  // Feiertage je Bundesland. 'XX' = keine deutschen Feiertage (Ausland).
  var STATES = [
    ['NW', 'Nordrhein-Westfalen'], ['BW', 'Baden-Württemberg'], ['BY', 'Bayern'], ['BE', 'Berlin'],
    ['BB', 'Brandenburg'], ['HB', 'Bremen'], ['HH', 'Hamburg'], ['HE', 'Hessen'],
    ['MV', 'Mecklenburg-Vorpommern'], ['NI', 'Niedersachsen'], ['RP', 'Rheinland-Pfalz'],
    ['SL', 'Saarland'], ['SN', 'Sachsen'], ['ST', 'Sachsen-Anhalt'], ['SH', 'Schleswig-Holstein'],
    ['TH', 'Thüringen'], ['XX', 'Ausland (keine dt. Feiertage)'],
  ];
  var _holCache = {};
  function holidaysFor(y, st) {
    var key = st + '|' + y;
    if (_holCache[key]) return _holCache[key];
    var m = {};
    if (st !== 'XX') {
      var E = easter(y), D = 86400000;
      var iso = function (t) { return new Date(t).toISOString().slice(0, 10); };
      var add = function (d) { m[d] = 1; };
      var has = function (list) { return list.indexOf(st) !== -1; };
      // bundesweit
      [y + '-01-01', iso(E - 2 * D), iso(E + D), y + '-05-01', iso(E + 39 * D), iso(E + 50 * D),
       y + '-10-03', y + '-12-25', y + '-12-26'].forEach(add);
      if (has(['BW', 'BY', 'ST'])) add(y + '-01-06');                                  // Heilige Drei Könige
      if (has(['BE', 'MV'])) add(y + '-03-08');                                        // Frauentag
      if (has(['BW', 'BY', 'HE', 'NW', 'RP', 'SL'])) add(iso(E + 60 * D));             // Fronleichnam
      if (has(['SL'])) add(y + '-08-15');                                              // Mariä Himmelfahrt (BY nur teilw. → nicht pauschal)
      if (has(['TH'])) add(y + '-09-20');                                              // Weltkindertag
      if (has(['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH'])) add(y + '-10-31'); // Reformationstag
      if (has(['BW', 'BY', 'NW', 'RP', 'SL'])) add(y + '-11-01');                      // Allerheiligen
      if (has(['SN'])) {                                                               // Buß- und Bettag: Mittwoch vor dem 23.11.
        var d22 = new Date(Date.UTC(y, 10, 22, 12));
        while (d22.getUTCDay() !== 3) d22.setUTCDate(d22.getUTCDate() - 1);
        add(d22.toISOString().slice(0, 10));
      }
    }
    _holCache[key] = m;
    return m;
  }
  function stateOf(emp) { return (emp && emp.federal_state) || 'NW'; }
  function isWorkday(iso, st) {
    var d = new Date(iso + 'T12:00:00Z'), wd = d.getUTCDay();
    if (wd === 0 || wd === 6) return false;
    return !holidaysFor(+iso.slice(0, 4), st || 'NW')[iso];
  }
  function addDaysIso(iso, n) {
    var d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  // Wert eines Tages als Urlaubstag: 0 = Wochenende/Feiertag, 0,5 = Heiligabend/
  // Silvester (Firmenregel: 24.12. und 31.12. sind halbe Arbeitstage), sonst 1.
  function dayValue(iso, st) {
    if (!isWorkday(iso, st)) return 0;
    var mmdd = iso.slice(5);
    return (mmdd === '12-24' || mmdd === '12-31') ? 0.5 : 1;
  }
  function workdays(startIso, endIso, st) {
    var n = 0, d = startIso, guard = 0;
    while (d <= endIso && guard++ < 800) { n += dayValue(d, st); d = addDaysIso(d, 1); }
    return n;
  }
  // Verteilung eines Eintrags auf Monate: {'YYYY-MM': Tage}. Weicht entry.days
  // vom rechnerischen Wert ab (z.B. 0,5 Tage), wird proportional skaliert.
  function monthlyBreakdown(entry) {
    var st = stateOf(empById(entry.employee_id));
    var per = {}, total = 0, d = entry.start_date, guard = 0;
    while (d <= entry.end_date && guard++ < 800) {
      var dv = dayValue(d, st);
      if (dv) { var ym = d.slice(0, 7); per[ym] = (per[ym] || 0) + dv; total += dv; }
      d = addDaysIso(d, 1);
    }
    var days = Number(entry.days) || 0;
    if (!total) { per[entry.start_date.slice(0, 7)] = days; return per; }
    var scale = days / total;
    Object.keys(per).forEach(function (k) { per[k] = Math.round(per[k] * scale * 100) / 100; });
    return per;
  }
  function entryYears(entry) {
    var ys = {}; ys[+entry.start_date.slice(0, 4)] = 1; ys[+entry.end_date.slice(0, 4)] = 1;
    return Object.keys(ys).map(Number);
  }

  // ── Laden ──────────────────────────────────────────────────────────────────
  function loadAll() {
    return Promise.all([
      window.db.employees.list(),
      window.db.hr.absenceEntries.listAll(),
      window.db.hr.fields.list(),
    ]).then(function (r) {
      state.employees = r[0] || [];
      state.entries = r[1] || [];
      state.fields = r[2] || [];
    });
  }
  function empById(id) { for (var i = 0; i < state.employees.length; i++) if (state.employees[i].id === id) return state.employees[i]; return null; }

  // ── Statistik pro Mitarbeiter/Jahr ─────────────────────────────────────────
  // Jeder Eintrag zählt KOMPLETT im Jahr seines Startdatums (Silvester-Urlaub →
  // altes Jahr). So entspricht die Kartensumme exakt der Eintragsliste des Jahres.
  function empYearStats(empId, year) {
    var taken = 0, planned = 0, sick = 0, today = todayIso();
    state.entries.forEach(function (e) {
      if (e.employee_id !== empId || +e.start_date.slice(0, 4) !== year) return;
      var d = Number(e.days) || 0;
      if (e.type === 'sick') { sick += d; return; }
      if (e.start_date <= today) taken += d; else planned += d;
    });
    return { taken: Math.round(taken * 100) / 100, planned: Math.round(planned * 100) / 100, sick: Math.round(sick * 100) / 100 };
  }
  // ── Urlaubsanspruch & Übertrag ─────────────────────────────────────────────
  // Anspruch im Eintrittsjahr anteilig (volle Monate ab Eintritt, 1/12 je Monat).
  function quotaFor(emp, year) {
    var q = Number(emp.vacation_days_per_year) || 0;
    if (!q) return 0;
    var sd = emp.start_date ? String(emp.start_date).slice(0, 10) : null;
    if (sd && +sd.slice(0, 4) > year) return 0;
    if (sd && +sd.slice(0, 4) === year) {
      // 1/12 je VOLLEM Beschäftigungsmonat: Eintrittsmonat zählt nur bei Eintritt am 1.
      var m = +sd.slice(5, 7), day = +sd.slice(8, 10);
      var months = 12 - m + (day === 1 ? 1 : 0);
      return Math.round(q * months / 12 * 2) / 2;
    }
    return q;
  }
  function vacTakenInYear(empId, year) {
    var s = 0;
    state.entries.forEach(function (e) {
      if (e.employee_id === empId && e.type === 'vacation' && +e.start_date.slice(0, 4) === year) s += Number(e.days) || 0;
    });
    return s;
  }
  // Übertrag ins Jahr `year`: Summe (Anspruch − genommen) aller Vorjahre,
  // beginnend beim späteren von Eintrittsjahr / erstem erfasstem Urlaubsjahr
  // (frühere Jahre ohne Daten würden den Übertrag sonst verfälschen).
  function carryover(emp, year) {
    if (!(Number(emp.vacation_days_per_year) > 0)) return 0;
    var years = [];
    state.entries.forEach(function (e) {
      if (e.employee_id === emp.id && e.type === 'vacation') years.push(+e.start_date.slice(0, 4));
    });
    if (!years.length) return 0;
    var first = Math.min.apply(null, years);
    if (emp.start_date) first = Math.max(first, +String(emp.start_date).slice(0, 4));
    var co = 0;
    for (var y = first; y < year; y++) co += quotaFor(emp, y) - vacTakenInYear(emp.id, y);
    return Math.round(co * 100) / 100;
  }

  function currentAbsence(empId) {
    var today = todayIso();
    return state.entries.find(function (e) {
      return e.employee_id === empId && e.start_date <= today && e.end_date >= today;
    }) || null;
  }
  function nextAbsence(empId) {
    var today = todayIso(), best = null;
    state.entries.forEach(function (e) {
      if (e.employee_id !== empId || e.type !== 'vacation' || e.start_date <= today) return;
      if (!best || e.start_date < best.start_date) best = e;
    });
    return best;
  }

  // ── Monats-Aggregate (employee_absences) aktualisieren ─────────────────────
  // Die Auslastungs-Seite rechnet mit employee_absences. Für jedes betroffene
  // Jahr wird pro Mitarbeiter+Typ neu aggregiert – aber nur, wenn es für diesen
  // Typ überhaupt Einträge gibt (sonst bleiben manuell gepflegte Werte stehen).
  function rollupYears(years) {
    var uniq = {}; years.forEach(function (y) { uniq[y] = 1; });
    return Object.keys(uniq).map(Number).reduce(function (p, year) {
      return p.then(function () { return rollupYear(year); });
    }, Promise.resolve());
  }
  function rollupYear(year) {
    return window.db.absences.forYear(year).catch(function () { return []; }).then(function (existing) {
      var cur = {};   // empId|month → {vac, sick}
      (existing || []).forEach(function (a) { cur[a.employee_id + '|' + a.month] = { vac: Number(a.vacation_days) || 0, sick: Number(a.sick_days) || 0 }; });
      var agg = {}, hasType = {};   // empId → {month → {vac, sick}}, empId → {vacation, sick}
      state.entries.forEach(function (e) {
        var bd = monthlyBreakdown(e);
        var touchesYear = Object.keys(bd).some(function (ym) { return +ym.slice(0, 4) === year; });
        if (touchesYear) { hasType[e.employee_id] = hasType[e.employee_id] || {}; hasType[e.employee_id][e.type] = 1; }
        Object.keys(bd).forEach(function (ym) {
          if (+ym.slice(0, 4) !== year) return;
          var m = +ym.slice(5), eid = e.employee_id;
          agg[eid] = agg[eid] || {}; agg[eid][m] = agg[eid][m] || { vac: 0, sick: 0 };
          agg[eid][m][e.type === 'sick' ? 'sick' : 'vac'] += bd[ym];
        });
      });
      var writes = [];
      Object.keys(hasType).forEach(function (eid) {
        for (var m = 1; m <= 12; m++) {
          var a = (agg[eid] && agg[eid][m]) || { vac: 0, sick: 0 };
          var c = cur[eid + '|' + m] || { vac: 0, sick: 0 };
          var vac  = hasType[eid].vacation ? Math.round(a.vac * 100) / 100  : c.vac;
          var sick = hasType[eid].sick     ? Math.round(a.sick * 100) / 100 : c.sick;
          if (vac !== c.vac || sick !== c.sick) writes.push([eid, m, vac, sick]);
        }
      });
      return writes.reduce(function (p, w) {
        return p.then(function () { return window.db.absences.upsert(w[0], year, w[1], w[2], w[3]); });
      }, Promise.resolve());
    });
  }

  // ── Rendering: Übersicht ───────────────────────────────────────────────────
  // Aktuell abwesend laut Stammdaten (leave_start/leave_until, z.B. Mutterschutz)
  function onLeave(emp) {
    if (!emp.leave_start) return false;
    var today = todayIso();
    return emp.leave_start <= today && (!emp.leave_until || emp.leave_until >= today);
  }
  function visibleEmployees() {
    return state.employees.filter(function (e) {
      if (e.name === 'PPC Software') return false;              // Kostenstelle, kein Mensch
      if (e.role === 'freelancer') return false;                // Freelancer: kein Urlaubs-/HR-Tracking
      if (e.name === 'Tobias') return false;                    // Inhaber, nicht als Mitarbeiter führen
      if (state.showInactive) return true;
      return e.active && !e.hr_hidden && !onLeave(e);           // Standard: aktive, sichtbare, nicht abwesende
    });
  }
  function renderAwayStrip() {
    var chips = [];
    visibleEmployees().forEach(function (emp) {
      var cur = currentAbsence(emp.id);
      if (!cur) return;
      chips.push('<span class="away-chip"><span class="avatar" style="background:' + avatarColor(emp.name) + '">' + esc(initials(emp.name)) + '</span> ' +
        esc(emp.name.split(' ')[0]) + ' <span class="until">' + (cur.type === 'sick' ? 'krank' : 'im Urlaub') + ' bis ' + deDate(cur.end_date) + '</span></span>');
    });
    el('awayStrip').innerHTML = chips.length
      ? '<span class="muted" style="font-weight:600">Heute abwesend:</span> ' + chips.join('')
      : '<span class="muted">Heute sind alle da. 💪</span>';
  }
  function renderYearSel() {
    var years = {}; years[new Date().getFullYear()] = 1;
    state.entries.forEach(function (e) { entryYears(e).forEach(function (y) { years[y] = 1; }); });
    var ys = Object.keys(years).map(Number).sort(function (a, b) { return b - a; });
    el('yearSel').innerHTML = ys.map(function (y) { return '<option value="' + y + '"' + (y === state.year ? ' selected' : '') + '>' + y + '</option>'; }).join('');
  }
  function renderCards() {
    var grid = el('empGrid');
    grid.innerHTML = visibleEmployees().map(function (emp) {
      var s = empYearStats(emp.id, state.year);
      var quota = quotaFor(emp, state.year);
      var co = quota ? carryover(emp, state.year) : 0;
      var avail = Math.round((quota + co) * 100) / 100;
      var used = s.taken + s.planned;
      var pct = avail > 0 ? Math.min(100, used / avail * 100) : 0;
      var cur = currentAbsence(emp.id), nxt = nextAbsence(emp.id);
      var meta = [];
      if (emp.start_date) meta.push('<span class="mi">🗓 seit ' + deDate(emp.start_date) + '</span>');
      if (emp.work_location) meta.push('<span class="mi">📍 ' + esc(emp.work_location) + '</span>');
      return '<div class="emp-card' + (emp.active ? '' : ' inactive') + '" data-emp="' + emp.id + '">' +
        '<div class="emp-head"><span class="avatar" style="background:' + avatarColor(emp.name) + '">' + esc(initials(emp.name)) + '</span>' +
        '<div><div class="en">' + esc(emp.name) +
        (cur ? ' <span class="pill today">' + (cur.type === 'sick' ? 'krank' : 'Urlaub') + '</span>' : '') +
        (onLeave(emp) ? ' <span class="pill today">Abwesend' + (emp.leave_until ? ' bis ' + deDate(emp.leave_until) : '') + '</span>' : '') +
        (emp.hr_hidden ? ' <span class="pill">ausgeblendet</span>' : '') + '</div>' +
        '<div class="er">' + esc(window.getRoleLabel(emp.role)) + '</div></div></div>' +
        '<div class="emp-meta">' + meta.join('') + '</div>' +
        '<div class="emp-kpis">' +
          '<div class="ek"><div class="ekl">Urlaub ' + state.year + '</div><div class="ekv">' + fmtDays(used) + (quota ? ' / ' + fmtDays(avail) : '') + '</div>' +
            (quota ? '<div class="vac-bar"><div class="' + (used > avail ? 'over' : '') + '" style="width:' + pct + '%"></div></div><div class="muted">Rest ' + fmtDays(avail - used) +
              (co ? ' · Übertrag ' + (co > 0 ? '+' : '') + fmtDays(co) : '') +
              (s.planned ? ' · ' + fmtDays(s.planned) + ' verplant' : '') + '</div>' : '<div class="muted">kein Anspruch hinterlegt</div>') +
          '</div>' +
          '<div class="ek"><div class="ekl">Krank</div><div class="ekv">' + fmtDays(s.sick) + '</div><div class="muted">Tage</div></div>' +
        '</div>' +
        (nxt ? '<div class="next-vac">🌴 nächster Urlaub: ' + deDate(nxt.start_date) + ' – ' + deDate(nxt.end_date) + '</div>' : '') +
        '</div>';
    }).join('') || '<div class="muted">Keine Mitarbeiter.</div>';
    Array.prototype.forEach.call(grid.querySelectorAll('.emp-card'), function (c) {
      c.addEventListener('click', function () { openModal(c.dataset.emp); });
    });
  }
  function renderYearTable() {
    el('yearTableTitle').textContent = 'Jahresübersicht ' + state.year;
    var rows = visibleEmployees().map(function (emp) {
      var s = empYearStats(emp.id, state.year);
      var quota = quotaFor(emp, state.year);
      var co = quota ? carryover(emp, state.year) : 0;
      var rest = quota ? Math.round((quota + co - s.taken - s.planned) * 100) / 100 : null;
      return '<tr><td>' + esc(emp.name) + '</td>' +
        '<td class="num">' + (quota ? fmtDays(quota) : '<span class="muted">—</span>') + '</td>' +
        '<td class="num">' + (quota ? ((co > 0 ? '+' : '') + fmtDays(co)) : '<span class="muted">—</span>') + '</td>' +
        '<td class="num">' + fmtDays(s.taken) + '</td>' +
        '<td class="num">' + fmtDays(s.planned) + '</td>' +
        '<td class="num" style="font-weight:600' + (rest != null && rest < 0 ? ';color:#b91c1c' : '') + '">' + (rest != null ? fmtDays(rest) : '—') + '</td>' +
        '<td class="num">' + fmtDays(s.sick) + '</td></tr>';
    }).join('');
    el('yearTable').innerHTML =
      '<thead><tr><th>Mitarbeiter</th><th>Anspruch</th><th>Übertrag</th><th>Genommen</th><th>Verplant</th><th>Rest</th><th>Krank</th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="7" class="muted">Keine Daten.</td></tr>') + '</tbody>';
    el('footNote').textContent = 'Urlaubstage = Arbeitstage Mo–Fr ohne Feiertage des Bundeslands aus dem Profil (Sa/So zählen nie; Default NRW). 24.12. und 31.12. zählen als halbe Tage (Firmenregel). Werkstudenten/Teilzeit: anteilig über „Arbeitstage pro Woche". Jeder Urlaub zählt komplett im Jahr seines Startdatums (Silvester-Urlaub → altes Jahr). Übertrag = nicht genommener Resturlaub der Vorjahre seit Eintritt (Eintrittsjahr anteilig, 1/12 je vollem Monat); verfügbar = Anspruch + Übertrag. „Genommen" = bis heute, „Verplant" = zukünftig. Quelle: Google-Urlaubskalender (Sync) + manuelle Einträge.';
  }
  function renderAll() {
    renderYearSel(); renderAwayStrip(); renderCards(); renderYearTable();
  }

  // ── Detail-Modal ───────────────────────────────────────────────────────────
  var FIXED_FIELDS = [
    ['email', 'E-Mail', 'text'], ['iban', 'IBAN', 'text'], ['start_date', 'Eintrittsdatum', 'date'],
    ['work_location', 'Arbeitsort', 'text'], ['federal_state', 'Bundesland (Feiertage)', 'select'],
    ['applied_via', 'Beworben über', 'text'],
    ['personality_test', 'Persönlichkeitstest', 'text'], ['vacation_days_per_year', 'Urlaubsanspruch (Tage/Jahr)', 'number'],
    ['work_days_per_week', 'Arbeitstage pro Woche', 'number'],   // z.B. 2 bei Werkstudenten → Urlaub zählt anteilig
  ];
  // Werkstudenten & Teilzeit: Urlaubstage zählen anteilig (Arbeitstage/Woche ÷ 5).
  // Unterjährige Wechsel stehen im workdays_history ([{from, days}]) und gelten
  // tagesgenau ab ihrem Datum; davor gilt work_days_per_week (Basis).
  function wdPerWeekAt(emp, iso) {
    var w = Number(emp && emp.work_days_per_week) || 5;
    var best = null;
    ((emp && emp.workdays_history) || []).forEach(function (h) {
      if (h && h.from && h.from <= iso && (!best || h.from > best.from)) best = h;
    });
    if (best && isFinite(Number(best.days)) && Number(best.days) > 0) w = Number(best.days);
    return (isFinite(w) && w > 0) ? w : 5;
  }
  function factorAt(emp, iso) { var w = wdPerWeekAt(emp, iso); return w < 5 ? w / 5 : 1; }
  function scaledWorkdays(emp, startIso, endIso) {
    var n = 0, d = startIso, guard = 0, st = stateOf(emp);
    while (d <= endIso && guard++ < 800) { n += dayValue(d, st) * factorAt(emp, d); d = addDaysIso(d, 1); }
    return Math.round(n * 2) / 2;   // auf halbe Tage
  }
  function parseWdHistory(text) {
    var out = [];
    String(text || '').split(/[;\n]/).forEach(function (part) {
      var m = part.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s*:?\s*(\d+(?:[.,]\d+)?)/);
      if (m) out.push({ from: m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'), days: parseFloat(m[4].replace(',', '.')) });
    });
    out.sort(function (a, b) { return a.from < b.from ? -1 : 1; });
    return out;
  }
  function wdHistoryText(hist) {
    return (hist || []).map(function (h) { return 'ab ' + deDate(h.from) + ': ' + String(h.days).replace('.', ','); }).join('; ');
  }
  function openModal(empId) {
    state.openEmpId = empId;
    var emp = empById(empId); if (!emp) return;
    var custom = emp.hr_custom || {};
    var fixedHtml = FIXED_FIELDS.map(function (f) {
      var v = emp[f[0]] == null ? '' : emp[f[0]];
      if (f[2] === 'date' && v) v = String(v).slice(0, 10);
      if (f[2] === 'select') {   // aktuell nur Bundesland
        return '<div class="fld"><label>' + f[1] + '</label><select data-fx="' + f[0] + '">' +
          STATES.map(function (s) { return '<option value="' + s[0] + '"' + (String(v || 'NW') === s[0] ? ' selected' : '') + '>' + esc(s[1]) + '</option>'; }).join('') +
          '</select></div>';
      }
      return '<div class="fld"><label>' + f[1] + '</label><input type="' + f[2] + '" data-fx="' + f[0] + '" value="' + esc(v) + '"></div>';
    }).join('') +
    '<div class="fld"><label>Arbeitstage-Verlauf <span style="text-transform:none;font-weight:400">– bei unterjährigem Wechsel, z.B. „ab 01.06.2026: 2,5"</span></label>' +
      '<input type="text" id="wdHist" value="' + esc(wdHistoryText(emp.workdays_history)) + '" placeholder="leer = konstant wie oben; mehrere mit ; trennen"></div>';
    var customHtml = state.fields.map(function (f) {
      return '<div class="fld"><label>' + esc(f.label) +
        '<span class="fdel" data-fdel="' + f.id + '" title="Feld für alle Mitarbeiter entfernen">✕ Feld löschen</span></label>' +
        '<input type="text" data-cf="' + f.id + '" value="' + esc(custom[f.id] == null ? '' : custom[f.id]) + '"></div>';
    }).join('');
    var allEntries = state.entries.filter(function (e) { return e.employee_id === empId; })
      .sort(function (a, b) { return a.start_date < b.start_date ? 1 : -1; });
    var entries = (state.modalAllYears ? allEntries : allEntries.filter(function (e) {
      return +e.start_date.slice(0, 4) === state.year;   // Eintrag gehört zum Jahr seines Startdatums
    })).slice(0, 80);
    var nHidden = allEntries.length - entries.length;
    var entriesHtml = entries.map(function (e) {
      return '<tr><td><span class="pill ' + (e.type === 'sick' ? 'sick' : 'vac') + '">' + (e.type === 'sick' ? 'Krank' : 'Urlaub') + '</span></td>' +
        '<td>' + deDate(e.start_date) + (e.end_date !== e.start_date ? ' – ' + deDate(e.end_date) : '') + '</td>' +
        '<td class="num" style="font-weight:600">' + fmtDays(e.days) + ' T</td>' +
        '<td>' + (e.source === 'gcal' ? '<span class="pill gcal" title="aus Google-Urlaubskalender">📅 Kalender</span>' : '<span class="pill">manuell</span>') + '</td>' +
        '<td class="right"><button class="btn btn-ghost btn-sm" data-edel="' + e.id + '">✕</button></td></tr>';
    }).join('');
    el('hrModalWrap').innerHTML =
      '<div class="hrm-overlay" id="hrmOverlay"><div class="hrm">' +
      '<div class="hrm-head"><span class="avatar" style="background:' + avatarColor(emp.name) + '">' + esc(initials(emp.name)) + '</span>' +
      '<div><div class="hn">' + esc(emp.name) + '</div><div class="muted">' + esc(window.getRoleLabel(emp.role)) + (emp.active ? '' : ' · inaktiv') + '</div></div>' +
      '<button class="hx" id="hrmClose">×</button></div>' +
      '<div class="hrm-body">' +
        '<div class="hrm-col"><div class="card"><div class="card-header"><h2>Profil</h2></div><div class="card-body">' +
          fixedHtml + customHtml +
          '<div class="fld"><label>Notizen</label><textarea data-fx="hr_notes">' + esc(emp.hr_notes || '') + '</textarea></div>' +
          '<div class="fld"><label style="display:inline-flex;align-items:center;gap:7px;cursor:pointer;text-transform:none;font-size:13px;font-weight:400;color:var(--text)">' +
            '<input type="checkbox" id="hrHiddenCb"' + (emp.hr_hidden ? ' checked' : '') + '> Im Personal-Bereich ausblenden (z.B. Freelancer)</label></div>' +
          '<div style="display:flex;gap:8px;align-items:center"><button class="btn btn-primary btn-sm" id="hrmSave">Profil speichern</button>' +
          '<button class="btn btn-secondary btn-sm" id="hrmAddField">+ Eigenes Feld</button><span class="muted" id="hrmSaveInfo"></span></div>' +
        '</div></div></div>' +
        '<div class="hrm-col"><div class="card"><div class="card-header" style="display:flex;align-items:center;justify-content:space-between;gap:10px">' +
          '<h2>Abwesenheiten ' + (state.modalAllYears ? '(alle Jahre)' : state.year) + '</h2>' +
          '<label class="muted" style="cursor:pointer;display:inline-flex;align-items:center;gap:5px;white-space:nowrap"><input type="checkbox" id="absAllYears"' + (state.modalAllYears ? ' checked' : '') + '> alle Jahre</label>' +
        '</div><div class="card-body">' +
          '<div class="abs-add">' +
            '<div class="fld"><label>Typ</label><select id="naType"><option value="vacation">Urlaub</option><option value="sick">Krank</option></select></div>' +
            '<div class="fld"><label>Von</label><input type="date" id="naFrom"></div>' +
            '<div class="fld"><label>Bis</label><input type="date" id="naTo"></div>' +
            '<div class="fld"><label>Tage</label><input type="number" id="naDays" step="0.5" style="width:70px" title="Arbeitstage; wird automatisch berechnet, kann überschrieben werden"></div>' +
            '<button class="btn btn-primary btn-sm" id="naAdd">+</button>' +
          '</div>' +
          '<table class="abs"><tbody>' + (entriesHtml || '<tr><td class="muted">Keine Einträge' + (state.modalAllYears ? '' : ' in ' + state.year) + '.</td></tr>') + '</tbody></table>' +
          (nHidden > 0 && !state.modalAllYears ? '<div class="muted" style="margin-top:8px">' + nHidden + ' ältere Einträge ausgeblendet – „alle Jahre" anhaken zum Anzeigen.</div>' : '') +
        '</div></div></div>' +
      '</div></div></div>';
    bindModal(emp);
  }
  function closeModal() { el('hrModalWrap').innerHTML = ''; state.openEmpId = null; }
  function bindModal(emp) {
    el('hrmClose').addEventListener('click', closeModal);
    el('hrmOverlay').addEventListener('click', function (e) { if (e.target === el('hrmOverlay')) closeModal(); });
    el('absAllYears').addEventListener('change', function () {
      state.modalAllYears = el('absAllYears').checked;
      openModal(emp.id);
    });

    el('hrmSave').addEventListener('click', function () {
      var fields = {};
      Array.prototype.forEach.call(document.querySelectorAll('[data-fx]'), function (inp) {
        var v = inp.value.trim();
        fields[inp.dataset.fx] = v === '' ? null : (inp.type === 'number' ? parseFloat(v) : v);
      });
      var custom = Object.assign({}, emp.hr_custom || {});
      Array.prototype.forEach.call(document.querySelectorAll('[data-cf]'), function (inp) {
        var v = inp.value.trim();
        if (v === '') delete custom[inp.dataset.cf]; else custom[inp.dataset.cf] = v;
      });
      fields.hr_custom = custom;
      fields.hr_hidden = el('hrHiddenCb').checked;
      fields.workdays_history = parseWdHistory(el('wdHist').value);
      el('hrmSave').disabled = true;
      window.db.employees.update(emp.id, fields).then(function () {
        return loadAll();
      }).then(function () {
        el('hrmSave').disabled = false; el('hrmSaveInfo').textContent = '✓ gespeichert';
        renderAll();
        setTimeout(function () { var i = el('hrmSaveInfo'); if (i) i.textContent = ''; }, 2500);
      }).catch(function (e) { alert(e.message); el('hrmSave').disabled = false; });
    });

    el('hrmAddField').addEventListener('click', addCustomField);
    Array.prototype.forEach.call(document.querySelectorAll('[data-fdel]'), function (b) {
      b.addEventListener('click', function () {
        var f = state.fields.find(function (x) { return x.id === b.dataset.fdel; });
        if (!f || !confirm('Feld „' + f.label + '" für ALLE Mitarbeiter entfernen?')) return;
        window.db.hr.fields.delete(f.id).then(loadAll).then(function () { openModal(emp.id); renderAll(); }).catch(function (e) { alert(e.message); });
      });
    });

    // Abwesenheit hinzufügen: Tage automatisch berechnen
    function autoDays() {
      var f = el('naFrom').value, t = el('naTo').value || f;
      if (f) el('naDays').value = scaledWorkdays(emp, f, t);
    }
    el('naFrom').addEventListener('change', function () { if (!el('naTo').value || el('naTo').value < el('naFrom').value) el('naTo').value = el('naFrom').value; autoDays(); });
    el('naTo').addEventListener('change', autoDays);
    el('naAdd').addEventListener('click', function () {
      var f = el('naFrom').value, t = el('naTo').value || f, days = parseFloat(el('naDays').value);
      if (!f) { alert('Bitte Startdatum wählen.'); return; }
      if (t < f) { alert('„Bis" liegt vor „Von".'); return; }
      if (!isFinite(days) || days <= 0) { alert('Bitte Tage angeben (z.B. 0,5 für einen halben Tag).'); return; }
      el('naAdd').disabled = true;
      var row = { employee_id: emp.id, type: el('naType').value, start_date: f, end_date: t, days: days, source: 'manual' };
      window.db.hr.absenceEntries.create(row).then(loadAll)
        .then(function () { return rollupYears(entryYears(row)); })
        .then(function () { renderAll(); openModal(emp.id); })
        .catch(function (e) { alert(e.message); el('naAdd').disabled = false; });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-edel]'), function (b) {
      b.addEventListener('click', function () {
        var entry = state.entries.find(function (x) { return x.id === b.dataset.edel; });
        if (!entry) return;
        if (!confirm('Eintrag ' + deDate(entry.start_date) + ' (' + fmtDays(entry.days) + ' Tage) löschen?' +
          (entry.source === 'gcal' ? '\n\nHinweis: Der Eintrag kommt aus dem Google-Kalender – wird er dort nicht auch gelöscht, taucht er beim nächsten Sync wieder auf.' : ''))) return;
        b.disabled = true;
        window.db.hr.absenceEntries.delete(entry.id).then(loadAll)
          .then(function () { return rollupYears(entryYears(entry)); })
          .then(function () { renderAll(); openModal(emp.id); })
          .catch(function (e) { alert(e.message); b.disabled = false; });
      });
    });
  }
  function addCustomField() {
    var label = prompt('Name des neuen Profilfelds (gilt für alle Mitarbeiter):\nz.B. „Scrum-Rolle", „Notfallkontakt", „T-Shirt-Größe"');
    if (!label || !label.trim()) return;
    window.db.hr.fields.add(label.trim()).then(loadAll).then(function () {
      renderAll();
      if (state.openEmpId) openModal(state.openEmpId);
    }).catch(function (e) { alert(e.message); });
  }

  // ── Google-Kalender-Sync (ICS) ─────────────────────────────────────────────
  function icsUrl() { return localStorage.getItem('vacationIcsUrl') || ''; }
  function configureIcs() {
    var cur = icsUrl();
    var u = prompt('Private ICS-Adresse des Urlaubskalenders:\n\nGoogle Calendar → Einstellungen → „Urlaubskalender" → „Kalender integrieren" → „Privatadresse im iCal-Format" kopieren und hier einfügen.', cur || 'https://calendar.google.com/calendar/ical/…/basic.ics');
    if (u == null) return;
    u = u.trim();
    if (u) localStorage.setItem('vacationIcsUrl', u); else localStorage.removeItem('vacationIcsUrl');
    updateSyncInfo();
  }
  function updateSyncInfo() {
    var t = localStorage.getItem('hrGcalSyncedAt');
    el('syncInfo').textContent = !icsUrl() ? 'Kalender nicht verbunden (⚙︎)'
      : (t ? 'Kalender-Sync: ' + new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'noch nie synchronisiert');
  }

  // Mini-ICS-Parser: VEVENTs mit UID/SUMMARY/DTSTART/DTEND (DATE oder DATE-TIME).
  function parseIcs(text) {
    var lines = text.split(/\r?\n/), unfolded = [];
    lines.forEach(function (l) {
      if (/^[ \t]/.test(l) && unfolded.length) unfolded[unfolded.length - 1] += l.slice(1);
      else unfolded.push(l);
    });
    var events = [], cur = null;
    unfolded.forEach(function (l) {
      if (l === 'BEGIN:VEVENT') { cur = {}; return; }
      if (l === 'END:VEVENT') { if (cur) events.push(cur); cur = null; return; }
      if (!cur) return;
      var idx = l.indexOf(':'); if (idx === -1) return;
      var key = l.slice(0, idx), val = l.slice(idx + 1);
      var name = key.split(';')[0];
      if (name === 'UID') cur.uid = val;
      else if (name === 'SUMMARY') cur.summary = val.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/g, ' ');
      else if (name === 'DTSTART') { cur.start = val; cur.startIsDate = key.indexOf('VALUE=DATE') !== -1 || /^\d{8}$/.test(val); }
      else if (name === 'DTEND') { cur.end = val; cur.endIsDate = key.indexOf('VALUE=DATE') !== -1 || /^\d{8}$/.test(val); }
      else if (name === 'RRULE') cur.rrule = val;
      else if (name === 'STATUS') cur.status = val;
      else if (name === 'RECURRENCE-ID') cur.recurrenceId = val;
    });
    return events;
  }
  function icsDate(v) {   // '20260715' | '20260715T090000Z' → '2026-07-15'
    var m = String(v || '').match(/^(\d{4})(\d{2})(\d{2})/);
    return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
  }

  // Namens-Matching: alle Nicht-Füllwort-Tokens des Titels müssen auf genau
  // einen Mitarbeiter passen (Token = Präfix eines Namensworts, z.B. „u" →
  // „Uhlmann"). Mehrdeutiges oder Unbekanntes (Ex-Mitarbeiter) wird gemeldet.
  var TITLE_STOPWORDS = { urlaub: 1, urlaubstag: 1, von: 1, halber: 1, halbtags: 1, tag: 1, bis: 1, uhr: 1, ab: 1, und: 1 };
  function matchEmployee(summary) {
    var tokens = String(summary).toLowerCase().replace(/[0-9]/g, ' ').replace(/[^\wäöüß]+/g, ' ')
      .split(/\s+/).filter(function (t) { return t.length >= 1 && !TITLE_STOPWORDS[t] && !/^urlaub/.test(t); });
    if (!tokens.length) return null;
    var matches = state.employees.filter(function (emp) {
      var words = emp.name.toLowerCase().split(/\s+/);
      var firstNameHit = false;
      var allOk = tokens.every(function (t) {
        return words.some(function (w, i) {
          var ok = w.indexOf(t) === 0;
          if (ok && i === 0) firstNameHit = true;
          return ok;
        });
      });
      return allOk && firstNameHit;
    });
    return matches.length === 1 ? matches[0] : null;
  }

  function doSync(silent) {
    var url = icsUrl();
    if (!url) { if (!silent) configureIcs(); if (!icsUrl()) return Promise.resolve(); url = icsUrl(); }
    var btn = el('syncBtn');
    btn.disabled = true; btn.textContent = 'Sync läuft …';
    var supaUrl = localStorage.getItem('supabaseUrl') || 'https://lgrnmiszhhahfcmctmwo.supabase.co';
    var skey = localStorage.getItem('supabaseKey') || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxncm5taXN6aGhhaGZjbWN0bXdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NjE2NDksImV4cCI6MjA4OTIzNzY0OX0.FDZRGMESves7XbAMs_oMLWmvnywMlVqe8p7f1kt06qk';
    return fetch(supaUrl + '/functions/v1/ics-fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + skey, 'apikey': skey },
      body: JSON.stringify({ icsUrl: url }),
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data.error) throw new Error(data.error);
      var events = parseIcs(data.ics);
      var rows = [], unmatched = {}, skippedRecurring = 0, uids = [];
      events.forEach(function (ev) {
        if (!ev.uid || !ev.summary || !ev.start) return;
        if (ev.status === 'CANCELLED') return;
        if (!/urlaub/i.test(ev.summary)) return;                    // nur Urlaubs-Events
        if (ev.rrule) { skippedRecurring++; return; }               // Serientermine nicht unterstützt
        var emp = matchEmployee(ev.summary);
        if (!emp) { unmatched[ev.summary] = 1; return; }
        var start = icsDate(ev.start);
        var end = ev.end ? icsDate(ev.end) : start;
        if (ev.endIsDate) end = addDaysIso(end, -1);                // DTEND (DATE) ist exklusiv
        if (!start || !end || end < start) return;
        var half = /halber tag|halbtags|0[.,]5/i.test(ev.summary);
        var days = half ? 0.5 : scaledWorkdays(emp, start, end);
        var uid = ev.uid.replace(/@google\.com$/, '');
        uids.push(uid);
        rows.push({ employee_id: emp.id, type: 'vacation', start_date: start, end_date: end,
          days: days, note: ev.summary, source: 'gcal', gcal_uid: uid });
      });
      if (!rows.length) throw new Error('Keine zuordenbaren Urlaubs-Events im Kalender gefunden.');
      return window.db.hr.absenceEntries.upsertByUid(rows)
        .then(function () { return window.db.hr.absenceEntries.deleteGcalNotIn(uids); })
        .then(function (deleted) {
          return loadAll().then(function () {
            var years = {};
            rows.forEach(function (r) { entryYears(r).forEach(function (y) { years[y] = 1; }); });
            (deleted || []).forEach(function (r) { entryYears(r).forEach(function (y) { years[y] = 1; }); });
            return rollupYears(Object.keys(years).map(Number));
          }).then(function () {
            localStorage.setItem('hrGcalSyncedAt', new Date().toISOString());
            renderAll(); updateSyncInfo();
            var un = Object.keys(unmatched);
            var msg = rows.length + ' Urlaubs-Einträge synchronisiert.';
            if (un.length) msg += '\n\nNicht zugeordnet (kein eindeutiger Mitarbeiter):\n• ' + un.join('\n• ');
            if (skippedRecurring) msg += '\n\n' + skippedRecurring + ' Serientermin(e) übersprungen (bitte als normale Termine eintragen).';
            if (!silent) alert(msg);
          });
        });
    }).catch(function (e) {
      if (!silent) alert('Sync-Fehler: ' + e.message);
    }).finally(function () {
      btn.disabled = false; btn.textContent = '↻ Urlaubskalender syncen';
    });
  }
  function maybeAutoSync() {   // still, max. 1× pro Tag
    if (!icsUrl()) return;
    var t = localStorage.getItem('hrGcalSyncedAt');
    if (t && t.slice(0, 10) === new Date().toISOString().slice(0, 10)) return;
    doSync(true);
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  function bindStatic() {
    el('yearSel').addEventListener('change', function () { state.year = +el('yearSel').value; renderAll(); });
    el('showInactive').addEventListener('change', function () { state.showInactive = el('showInactive').checked; renderAll(); });
    el('addFieldBtn').addEventListener('click', addCustomField);
    el('syncBtn').addEventListener('click', function () { doSync(false); });
    el('icsCfgBtn').addEventListener('click', configureIcs);
    el('addAbsBtn').addEventListener('click', function () {
      var actives = visibleEmployees();
      var names = actives.map(function (e, i) { return (i + 1) + ' = ' + e.name; }).join('\n');
      var pick = prompt('Für wen? Nummer eingeben:\n' + names);
      if (pick == null) return;
      var emp = actives[parseInt(pick, 10) - 1];
      if (!emp) { alert('Ungültige Auswahl.'); return; }
      openModal(emp.id);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
  }
  function init() {
    bindStatic();
    if (!window.isConfigured()) { el('loading').style.display = 'none'; el('setupHint').classList.remove('hidden'); return; }
    loadAll().then(function () {
      el('loading').style.display = 'none';
      el('app').style.display = '';
      renderAll(); updateSyncInfo(); maybeAutoSync();
    }).catch(function (e) { showError(e.message); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
