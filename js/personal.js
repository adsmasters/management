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
  var _holCache = {};
  function holidaysNRW(y) {
    if (_holCache[y]) return _holCache[y];
    var E = easter(y), D = 86400000;
    var iso = function (t) { return new Date(t).toISOString().slice(0, 10); };
    _holCache[y] = {};
    [y + '-01-01', iso(E - 2 * D), iso(E + D), y + '-05-01', iso(E + 39 * D), iso(E + 50 * D),
     iso(E + 60 * D), y + '-10-03', y + '-11-01', y + '-12-25', y + '-12-26']
      .forEach(function (d) { _holCache[y][d] = 1; });
    return _holCache[y];
  }
  function isWorkday(iso) {
    var d = new Date(iso + 'T12:00:00Z'), wd = d.getUTCDay();
    if (wd === 0 || wd === 6) return false;
    return !holidaysNRW(+iso.slice(0, 4))[iso];
  }
  function addDaysIso(iso, n) {
    var d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function workdays(startIso, endIso) {
    var n = 0, d = startIso, guard = 0;
    while (d <= endIso && guard++ < 800) { if (isWorkday(d)) n++; d = addDaysIso(d, 1); }
    return n;
  }
  // Verteilung eines Eintrags auf Monate: {'YYYY-MM': Tage}. Weicht entry.days
  // vom rechnerischen Wert ab (z.B. 0,5 Tage), wird proportional skaliert.
  function monthlyBreakdown(entry) {
    var per = {}, total = 0, d = entry.start_date, guard = 0;
    while (d <= entry.end_date && guard++ < 800) {
      if (isWorkday(d)) { var ym = d.slice(0, 7); per[ym] = (per[ym] || 0) + 1; total++; }
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
  function empYearStats(empId, year) {
    var taken = 0, planned = 0, sick = 0, today = todayIso();
    state.entries.forEach(function (e) {
      if (e.employee_id !== empId) return;
      var bd = monthlyBreakdown(e);
      Object.keys(bd).forEach(function (ym) {
        if (+ym.slice(0, 4) !== year) return;
        if (e.type === 'sick') { sick += bd[ym]; return; }
        // Urlaub: vergangen vs. geplant (grob über Startdatum des Monats-Anteils)
        if (ym < today.slice(0, 7) || (ym === today.slice(0, 7) && e.start_date <= today)) taken += bd[ym];
        else planned += bd[ym];
      });
    });
    return { taken: Math.round(taken * 100) / 100, planned: Math.round(planned * 100) / 100, sick: Math.round(sick * 100) / 100 };
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
  function visibleEmployees() {
    return state.employees.filter(function (e) {
      if (e.name === 'PPC Software') return false;              // Kostenstelle, kein Mensch
      if (e.role === 'freelancer') return false;                // Freelancer: kein Urlaubs-/HR-Tracking
      if (e.name === 'Tobias') return false;                    // Inhaber, nicht als Mitarbeiter führen
      return state.showInactive || e.active;
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
      var quota = Number(emp.vacation_days_per_year) || 0;
      var used = s.taken + s.planned;
      var pct = quota ? Math.min(100, used / quota * 100) : 0;
      var cur = currentAbsence(emp.id), nxt = nextAbsence(emp.id);
      var meta = [];
      if (emp.start_date) meta.push('<span class="mi">🗓 seit ' + deDate(emp.start_date) + '</span>');
      if (emp.work_location) meta.push('<span class="mi">📍 ' + esc(emp.work_location) + '</span>');
      return '<div class="emp-card' + (emp.active ? '' : ' inactive') + '" data-emp="' + emp.id + '">' +
        '<div class="emp-head"><span class="avatar" style="background:' + avatarColor(emp.name) + '">' + esc(initials(emp.name)) + '</span>' +
        '<div><div class="en">' + esc(emp.name) + (cur ? ' <span class="pill today">' + (cur.type === 'sick' ? 'krank' : 'Urlaub') + '</span>' : '') + '</div>' +
        '<div class="er">' + esc(window.getRoleLabel(emp.role)) + '</div></div></div>' +
        '<div class="emp-meta">' + meta.join('') + '</div>' +
        '<div class="emp-kpis">' +
          '<div class="ek"><div class="ekl">Urlaub ' + state.year + '</div><div class="ekv">' + fmtDays(used) + (quota ? ' / ' + fmtDays(quota) : '') + '</div>' +
            (quota ? '<div class="vac-bar"><div class="' + (used > quota ? 'over' : '') + '" style="width:' + pct + '%"></div></div><div class="muted">Rest ' + fmtDays(quota - used) + (s.planned ? ' · ' + fmtDays(s.planned) + ' verplant' : '') + '</div>' : '<div class="muted">kein Anspruch hinterlegt</div>') +
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
      var quota = Number(emp.vacation_days_per_year) || 0;
      var rest = quota ? quota - s.taken - s.planned : null;
      return '<tr><td>' + esc(emp.name) + '</td>' +
        '<td class="num">' + (quota ? fmtDays(quota) : '<span class="muted">—</span>') + '</td>' +
        '<td class="num">' + fmtDays(s.taken) + '</td>' +
        '<td class="num">' + fmtDays(s.planned) + '</td>' +
        '<td class="num" style="font-weight:600' + (rest != null && rest < 0 ? ';color:#b91c1c' : '') + '">' + (rest != null ? fmtDays(rest) : '—') + '</td>' +
        '<td class="num">' + fmtDays(s.sick) + '</td></tr>';
    }).join('');
    el('yearTable').innerHTML =
      '<thead><tr><th>Mitarbeiter</th><th>Anspruch</th><th>Genommen</th><th>Verplant</th><th>Rest</th><th>Krank</th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="6" class="muted">Keine Daten.</td></tr>') + '</tbody>';
    el('footNote').textContent = 'Urlaubstage = Arbeitstage Mo–Fr ohne NRW-Feiertage. „Genommen" = bis heute, „Verplant" = zukünftig. Quelle: Google-Urlaubskalender (Sync) + manuelle Einträge. Die Auslastungs-Seite wird automatisch mitaktualisiert.';
  }
  function renderAll() {
    renderYearSel(); renderAwayStrip(); renderCards(); renderYearTable();
  }

  // ── Detail-Modal ───────────────────────────────────────────────────────────
  var FIXED_FIELDS = [
    ['email', 'E-Mail', 'text'], ['iban', 'IBAN', 'text'], ['start_date', 'Eintrittsdatum', 'date'],
    ['work_location', 'Arbeitsort', 'text'], ['applied_via', 'Beworben über', 'text'],
    ['personality_test', 'Persönlichkeitstest', 'text'], ['vacation_days_per_year', 'Urlaubsanspruch (Tage/Jahr)', 'number'],
  ];
  function openModal(empId) {
    state.openEmpId = empId;
    var emp = empById(empId); if (!emp) return;
    var custom = emp.hr_custom || {};
    var fixedHtml = FIXED_FIELDS.map(function (f) {
      var v = emp[f[0]] == null ? '' : emp[f[0]];
      if (f[2] === 'date' && v) v = String(v).slice(0, 10);
      return '<div class="fld"><label>' + f[1] + '</label><input type="' + f[2] + '" data-fx="' + f[0] + '" value="' + esc(v) + '"></div>';
    }).join('');
    var customHtml = state.fields.map(function (f) {
      return '<div class="fld"><label>' + esc(f.label) +
        '<span class="fdel" data-fdel="' + f.id + '" title="Feld für alle Mitarbeiter entfernen">✕ Feld löschen</span></label>' +
        '<input type="text" data-cf="' + f.id + '" value="' + esc(custom[f.id] == null ? '' : custom[f.id]) + '"></div>';
    }).join('');
    var entries = state.entries.filter(function (e) { return e.employee_id === empId; })
      .sort(function (a, b) { return a.start_date < b.start_date ? 1 : -1; }).slice(0, 60);
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
          '<div style="display:flex;gap:8px;align-items:center"><button class="btn btn-primary btn-sm" id="hrmSave">Profil speichern</button>' +
          '<button class="btn btn-secondary btn-sm" id="hrmAddField">+ Eigenes Feld</button><span class="muted" id="hrmSaveInfo"></span></div>' +
        '</div></div></div>' +
        '<div class="hrm-col"><div class="card"><div class="card-header"><h2>Abwesenheiten</h2></div><div class="card-body">' +
          '<div class="abs-add">' +
            '<div class="fld"><label>Typ</label><select id="naType"><option value="vacation">Urlaub</option><option value="sick">Krank</option></select></div>' +
            '<div class="fld"><label>Von</label><input type="date" id="naFrom"></div>' +
            '<div class="fld"><label>Bis</label><input type="date" id="naTo"></div>' +
            '<div class="fld"><label>Tage</label><input type="number" id="naDays" step="0.5" style="width:70px" title="Arbeitstage; wird automatisch berechnet, kann überschrieben werden"></div>' +
            '<button class="btn btn-primary btn-sm" id="naAdd">+</button>' +
          '</div>' +
          '<table class="abs"><tbody>' + (entriesHtml || '<tr><td class="muted">Noch keine Einträge.</td></tr>') + '</tbody></table>' +
        '</div></div></div>' +
      '</div></div></div>';
    bindModal(emp);
  }
  function closeModal() { el('hrModalWrap').innerHTML = ''; state.openEmpId = null; }
  function bindModal(emp) {
    el('hrmClose').addEventListener('click', closeModal);
    el('hrmOverlay').addEventListener('click', function (e) { if (e.target === el('hrmOverlay')) closeModal(); });

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
      if (f) el('naDays').value = workdays(f, t);
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
        var days = half ? 0.5 : workdays(start, end);
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
