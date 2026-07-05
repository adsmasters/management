(function () {
  'use strict';

  var el = function (id) { return document.getElementById(id); };
  var loadingEl = el('loading'), contentEl = el('content'), errorEl = el('error');
  var INVOICES = [];
  var sortKey = 'overdueDays', sortDir = -1;

  function supaUrl() { return localStorage.getItem('supabaseUrl') || 'https://lgrnmiszhhahfcmctmwo.supabase.co'; }
  function supaKey() { return localStorage.getItem('supabaseKey') || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxncm5taXN6aGhhaGZjbWN0bXdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NjE2NDksImV4cCI6MjA4OTIzNzY0OX0.FDZRGMESves7XbAMs_oMLWmvnywMlVqe8p7f1kt06qk'; }
  function lexKey() { return (localStorage.getItem('lexofficeKey') || '').trim(); }
  function authToken() { try { var t = JSON.parse(localStorage.getItem('sb-lgrnmiszhhahfcmctmwo-auth-token')); return (t && (t.access_token || (t.currentSession && t.currentSession.access_token))) || supaKey(); } catch (e) { return supaKey(); } }

  function fmtEur(n) { return (Math.round(n * 100) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; }
  function fmtEur0(n) { return Math.round(n).toLocaleString('de-DE') + ' €'; }
  function fmtDate(s) { if (!s) return '—'; var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '.' + m[2] + '.' + m[1] : s; }
  function daysOverdue(due) {
    if (!due) return 0;
    var m = String(due).match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return 0;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    var now = new Date(); var today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    return Math.round((today - d) / 86400000);
  }
  function showError(msg) { loadingEl.classList.add('hidden'); errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' + msg + '</div>'; }

  var BUCKETS = [
    { key: 'future', label: 'Noch nicht fällig', color: '#10b981', test: function (d) { return d <= 0; } },
    { key: 'b1', label: '1–30 Tage', color: '#eab308', test: function (d) { return d >= 1 && d <= 30; } },
    { key: 'b2', label: '31–60 Tage', color: '#f97316', test: function (d) { return d >= 31 && d <= 60; } },
    { key: 'b3', label: '61–90 Tage', color: '#ef4444', test: function (d) { return d >= 61 && d <= 90; } },
    { key: 'b4', label: '> 90 Tage', color: '#b91c1c', test: function (d) { return d > 90; } },
  ];

  function load() {
    if (!lexKey()) { showError('LexOffice ist in diesem Browser nicht verbunden. Bitte in den <a href="settings.html">Einstellungen</a> den API-Key eintragen.'); return; }
    errorEl.innerHTML = ''; loadingEl.classList.remove('hidden'); contentEl.classList.add('hidden');
    el('reloadBtn').disabled = true;
    fetch(supaUrl() + '/functions/v1/open-invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken(), 'apikey': supaKey() },
      body: JSON.stringify({ lexofficeKey: lexKey() }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      el('reloadBtn').disabled = false;
      if (d.error) { showError('LexOffice: ' + d.error); return; }
      INVOICES = (d.invoices || []).map(function (v) { v.overdueDays = daysOverdue(v.dueDate); return v; });
      loadingEl.classList.add('hidden'); contentEl.classList.remove('hidden');
      var now = new Date();
      el('stamp').textContent = 'Stand: ' + now.toLocaleString('de-DE');
      render();
    }).catch(function (e) { el('reloadBtn').disabled = false; showError(e.message); });
  }

  function filtered() {
    var q = (el('search').value || '').trim().toLowerCase();
    var f = el('filter').value;
    return INVOICES.filter(function (v) {
      if (f === 'overdue' && v.overdueDays <= 0) return false;
      if (q && (v.contact || '').toLowerCase().indexOf(q) === -1 && (v.number || '').toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }

  function render() {
    var rows = filtered();
    var total = rows.reduce(function (s, v) { return s + v.open; }, 0);
    var clients = {}; rows.forEach(function (v) { clients[(v.contact || '').toLowerCase()] = 1; });
    var overdue = rows.filter(function (v) { return v.overdueDays > 0; });
    var overdueSum = overdue.reduce(function (s, v) { return s + v.open; }, 0);

    el('kSum').textContent = fmtEur(total);
    el('kSumSub').textContent = rows.length + ' offene Rechnung' + (rows.length === 1 ? '' : 'en');
    el('kCount').textContent = rows.length;
    el('kClients').textContent = Object.keys(clients).length;
    el('kOverdue').textContent = fmtEur(overdueSum);
    el('kOverdueSub').textContent = overdue.length + ' Rechnung' + (overdue.length === 1 ? '' : 'en') + ' überfällig';

    // Aging
    var bAmt = {}, bCnt = {}; BUCKETS.forEach(function (b) { bAmt[b.key] = 0; bCnt[b.key] = 0; });
    rows.forEach(function (v) { for (var i = 0; i < BUCKETS.length; i++) { if (BUCKETS[i].test(v.overdueDays)) { bAmt[BUCKETS[i].key] += v.open; bCnt[BUCKETS[i].key]++; break; } } });
    var maxA = Math.max(1, Math.max.apply(null, BUCKETS.map(function (b) { return bAmt[b.key]; })));
    el('agingBars').innerHTML = BUCKETS.map(function (b) {
      var w = Math.round(bAmt[b.key] / maxA * 100);
      return '<div class="aging-row"><span class="lbl">' + b.label + '</span>' +
        '<span class="bar" style="width:' + Math.max(w, bAmt[b.key] > 0 ? 3 : 0) + '%;background:' + b.color + '"></span>' +
        '<span class="amt">' + (bAmt[b.key] > 0 ? fmtEur0(bAmt[b.key]) + ' <span style="color:var(--text-secondary);font-weight:400">(' + bCnt[b.key] + ')</span>' : '<span style="color:var(--text-muted,#9aa)">–</span>') + '</span></div>';
    }).join('');
    drawChart(bAmt);

    // Table
    rows.sort(function (a, b) {
      var x = a[sortKey], y = b[sortKey];
      if (typeof x === 'string') { x = (x || '').toLowerCase(); y = (y || '').toLowerCase(); return x < y ? -sortDir : x > y ? sortDir : 0; }
      return ((x || 0) - (y || 0)) * sortDir;
    });
    var body = rows.map(function (v) {
      var d = v.overdueDays, cls = d <= 0 ? 'p-future' : d <= 30 ? 'p-1' : d <= 60 ? 'p-2' : 'p-3';
      var lbl = d <= 0 ? (d === 0 ? 'heute fällig' : 'in ' + (-d) + ' T') : d + ' T überfällig';
      return '<tr><td style="font-weight:600">' + esc(v.contact) + '</td>' +
        '<td style="color:var(--text-secondary)">' + esc(v.number) + '</td>' +
        '<td>' + fmtDate(v.voucherDate) + '</td>' +
        '<td>' + fmtDate(v.dueDate) + '</td>' +
        '<td class="right"><span class="pill ' + cls + '">' + lbl + '</span></td>' +
        '<td class="right" style="font-weight:700">' + fmtEur(v.open) + '</td></tr>';
    }).join('');
    el('oiBody').innerHTML = body;
    var emptyEl = el('empty');
    if (!rows.length) { emptyEl.classList.remove('hidden'); emptyEl.textContent = '✓ Keine offenen Rechnungen für diesen Filter.'; }
    else emptyEl.classList.add('hidden');
  }

  var chart = null;
  function drawChart(bAmt) {
    var ctx = el('agingChart').getContext('2d');
    var data = BUCKETS.map(function (b) { return Math.round(bAmt[b.key]); });
    var cfg = {
      type: 'doughnut',
      data: { labels: BUCKETS.map(function (b) { return b.label; }), datasets: [{ data: data, backgroundColor: BUCKETS.map(function (b) { return b.color; }), borderWidth: 2, borderColor: '#fff' }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '58%', plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: function (c) { return c.label + ': ' + fmtEur0(c.parsed); } } } } },
    };
    if (chart) { chart.data = cfg.data; chart.update(); } else chart = new Chart(ctx, cfg);
  }

  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  el('reloadBtn').addEventListener('click', load);
  el('search').addEventListener('input', function () { if (INVOICES.length) render(); });
  el('filter').addEventListener('change', function () { if (INVOICES.length) render(); });
  document.querySelectorAll('table.oi thead th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-sort');
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = (k === 'contact' || k === 'number') ? 1 : -1; }
      render();
    });
  });

  load();
})();
