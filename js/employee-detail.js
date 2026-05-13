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
})();
