(function () {
  'use strict';

  var params   = new URLSearchParams(location.search);
  var empId    = params.get('id');
  var empName  = params.get('name') || 'Mitarbeiter';

  var monthFrom  = document.getElementById('monthFrom');
  var monthTo    = document.getElementById('monthTo');
  var loadBtn    = document.getElementById('loadBtn');
  var loadingEl  = document.getElementById('loading');
  var contentEl  = document.getElementById('content');
  var emptyEl    = document.getElementById('emptyState');
  var errorEl    = document.getElementById('error');
  var detailBody = document.getElementById('detailBody');

  // ── Set employee name in header ───────────────────────────────────────
  document.getElementById('empName').textContent   = empName;
  document.getElementById('empAvatar').textContent = empName.charAt(0).toUpperCase();
  document.title = empName + ' – Stunden';

  if (!empId) {
    errorEl.innerHTML = '<div class="alert alert-danger">Kein Mitarbeiter ausgewählt.</div>';
    return;
  }

  // ── Default to current month ──────────────────────────────────────────
  var now = new Date();
  var cur = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  monthFrom.value = cur;
  monthTo.value   = cur;

  monthFrom.addEventListener('change', function () {
    if (monthTo.value < monthFrom.value) monthTo.value = monthFrom.value;
  });
  monthTo.addEventListener('change', function () {
    if (monthTo.value < monthFrom.value) monthFrom.value = monthTo.value;
  });

  function monthsInRange(fy, fm, ty, tm) {
    var list = [];
    var y = fy, m = fm;
    while (y < ty || (y === ty && m <= tm)) {
      list.push({ year: y, month: m });
      m++; if (m > 12) { m = 1; y++; }
    }
    return list;
  }

  // ── Load ──────────────────────────────────────────────────────────────
  loadBtn.addEventListener('click', load);

  function load() {
    var fp = monthFrom.value.split('-');
    var tp = monthTo.value.split('-');
    if (!fp[0] || !tp[0]) return;

    var months = monthsInRange(+fp[0], +fp[1], +tp[0], +tp[1]);

    errorEl.innerHTML = '';
    loadingEl.classList.remove('hidden');
    contentEl.classList.add('hidden');
    emptyEl.classList.add('hidden');

    // Fetch entries for all months in range
    Promise.all(
      months.map(function (m) {
        return window.db.entries.forEmployeeMonth(empId, m.year, m.month);
      })
    )
    .then(function (results) {
      loadingEl.classList.add('hidden');

      // Aggregate by client across months
      var clientMap = {}; // clientId → { name, hours }
      results.forEach(function (entries) {
        entries.forEach(function (entry) {
          var id   = entry.client_id;
          var name = (entry.clients && entry.clients.name) || id;
          if (!clientMap[id]) clientMap[id] = { name: name, hours: 0 };
          clientMap[id].hours += (entry.hours || 0);
        });
      });

      var rows = Object.values(clientMap).filter(function (r) { return r.hours > 0; });
      rows.sort(function (a, b) { return b.hours - a.hours; });

      if (rows.length === 0) {
        emptyEl.classList.remove('hidden');
        return;
      }

      var total = rows.reduce(function (s, r) { return s + r.hours; }, 0);

      detailBody.innerHTML = '';

      rows.forEach(function (r) {
        var pct    = total > 0 ? (r.hours / total) * 100 : 0;
        var pctFmt = pct.toFixed(1) + '%';
        var barW   = Math.min(pct, 100).toFixed(1);

        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td style="font-weight:500">' + r.name + '</td>' +
          '<td class="right" style="font-variant-numeric:tabular-nums;font-weight:600">' +
            r.hours.toFixed(1) + ' h</td>' +
          '<td>' +
            '<div style="display:flex;align-items:center;gap:10px">' +
              '<div class="hours-bar-wrap" style="flex:1">' +
                '<div class="hours-bar" style="width:' + barW + '%"></div>' +
              '</div>' +
              '<span style="font-size:13px;color:var(--text-secondary);min-width:42px;text-align:right">' +
                pctFmt + '</span>' +
            '</div>' +
          '</td>';
        detailBody.appendChild(tr);
      });

      // Total row
      var totalTr = document.createElement('tr');
      totalTr.className = 'total-row';
      totalTr.innerHTML =
        '<td>Gesamt</td>' +
        '<td class="right">' + total.toFixed(1) + ' h</td>' +
        '<td></td>';
      detailBody.appendChild(totalTr);

      contentEl.classList.remove('hidden');
    })
    .catch(function (e) {
      loadingEl.classList.add('hidden');
      errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' + e.message + '</div>';
    });
  }

  load();

  // ── Gehalts-/Stundensatz-Historie ────────────────────────────────────
  var rateBody     = document.getElementById('rateBody');
  var rateBaseHint = document.getElementById('rateBaseHint');
  var rateMonth    = document.getElementById('rateMonth');
  var rateMonthly  = document.getElementById('rateMonthly');
  var rateHourly   = document.getElementById('rateHourly');
  var rateAddBtn   = document.getElementById('rateAddBtn');
  var rateErr      = document.getElementById('rateErr');

  var MONTHS_LABEL = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

  function eur(n) {
    if (n == null || n === '') return '—';
    return Number(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }
  function ymLabel(dateStr) {
    var d = new Date(dateStr);
    return MONTHS_LABEL[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function loadRates() {
    Promise.all([
      window.db.employees.list(),
      window.db.employeeRates.forEmployee(empId),
    ]).then(function (res) {
      var emp = (res[0] || []).filter(function (e) { return e.id === empId; })[0] || {};
      var rates = res[1] || [];

      var baseParts = [];
      if (emp.monthly_cost) baseParts.push('Gehalt ' + eur(emp.monthly_cost) + '/Monat');
      if (emp.hourly_rate)  baseParts.push('Stundensatz ' + eur(emp.hourly_rate) + '/h');
      rateBaseHint.innerHTML = baseParts.length
        ? 'Basis (gilt bis zur ersten Änderung): <strong>' + baseParts.join(' · ') + '</strong>'
        : 'Keine Basis-Vergütung hinterlegt — bitte auf der Mitarbeiter-Seite eintragen.';

      rateBody.innerHTML = '';
      if (!rates.length) {
        rateBody.innerHTML = '<tr><td colspan="4" style="padding:8px;color:var(--text-muted);font-style:italic">Noch keine Änderungen — nur die Basis-Vergütung gilt.</td></tr>';
        return;
      }
      rates.forEach(function (r) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td style="padding:6px 8px">' + ymLabel(r.effective_from) + '</td>' +
          '<td style="padding:6px 8px;text-align:right">' + eur(r.monthly_cost) + '</td>' +
          '<td style="padding:6px 8px;text-align:right">' + (r.hourly_rate ? eur(r.hourly_rate) + '/h' : '—') + '</td>' +
          '<td style="padding:6px 8px;text-align:right"><button class="rate-del" data-id="' + r.id + '" title="Löschen" style="border:none;background:none;color:var(--text-muted);cursor:pointer;font-size:15px;line-height:1">×</button></td>';
        rateBody.appendChild(tr);
      });
      Array.prototype.forEach.call(rateBody.querySelectorAll('.rate-del'), function (btn) {
        btn.addEventListener('click', function () {
          btn.disabled = true;
          window.db.employeeRates.delete(btn.getAttribute('data-id'))
            .then(loadRates)
            .catch(function (e) { rateErr.textContent = 'Löschen fehlgeschlagen: ' + e.message; rateErr.style.display = 'inline'; btn.disabled = false; });
        });
      });
    }).catch(function (e) {
      rateBaseHint.textContent = 'Fehler beim Laden der Historie: ' + e.message;
    });
  }

  rateAddBtn.addEventListener('click', function () {
    rateErr.style.display = 'none';
    var month   = rateMonth.value;                  // 'YYYY-MM'
    var monthly = parseFloat(rateMonthly.value);
    var hourly  = parseFloat(rateHourly.value);
    if (!month) { rateErr.textContent = 'Bitte „Gültig ab" wählen.'; rateErr.style.display = 'inline'; return; }
    if ((!monthly || monthly <= 0) && (!hourly || hourly <= 0)) {
      rateErr.textContent = 'Bitte Gehalt oder Stundensatz eingeben.'; rateErr.style.display = 'inline'; return;
    }
    rateAddBtn.disabled = true; rateAddBtn.textContent = '…';
    window.db.employeeRates.create(
      empId, month + '-01',
      (monthly && monthly > 0) ? monthly : null,
      (hourly  && hourly  > 0) ? hourly  : null
    ).then(function () {
      rateMonthly.value = ''; rateHourly.value = '';
      loadRates();
    }).catch(function (e) {
      rateErr.textContent = 'Fehler: ' + e.message; rateErr.style.display = 'inline';
    }).finally(function () {
      rateAddBtn.disabled = false; rateAddBtn.textContent = '+ Änderung';
    });
  });

  loadRates();
})();
