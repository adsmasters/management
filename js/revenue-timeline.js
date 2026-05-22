(function () {
  'use strict';

  var yearFrom      = document.getElementById('yearFrom');
  var yearTo        = document.getElementById('yearTo');
  var loadBtn       = document.getElementById('loadBtn');
  var compareToggle = document.getElementById('compareToggle');
  var loadingEl     = document.getElementById('loading');
  var contentEl     = document.getElementById('content');
  var errorEl       = document.getElementById('error');
  var timelineBody  = document.getElementById('timelineBody');
  var thDelta       = document.getElementById('thDelta');

  var now      = new Date();
  var curYear  = now.getFullYear();
  var curMonth = now.getMonth() + 1;

  var MONTHS_LABEL = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

  // ── Build year selectors ──────────────────────────────────────────────
  for (var y = curYear - 3; y <= curYear + 1; y++) {
    var o1 = document.createElement('option');
    o1.value = y; o1.textContent = y;
    yearFrom.appendChild(o1);
    var o2 = document.createElement('option');
    o2.value = y; o2.textContent = y;
    yearTo.appendChild(o2);
  }
  yearFrom.value = curYear;
  yearTo.value   = curYear;

  // Keep from ≤ to
  yearFrom.addEventListener('change', function () {
    if (parseInt(yearFrom.value) > parseInt(yearTo.value)) yearTo.value = yearFrom.value;
  });
  yearTo.addEventListener('change', function () {
    if (parseInt(yearTo.value) < parseInt(yearFrom.value)) yearFrom.value = yearTo.value;
  });

  function fmt(n) {
    return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }

  function showError(msg) {
    errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' + msg + '</div>';
  }

  // ── Exclude keywords (same logic as profit.js) ────────────────────────
  function getExcludeKeywords() {
    return (localStorage.getItem('revenueExcludeKeywords') || '')
      .split('\n')
      .map(function (k) { return k.trim().toLowerCase(); })
      .filter(function (k) { return k.length > 0; });
  }

  function isExcluded(contactName) {
    var kws = getExcludeKeywords();
    if (!kws.length) return false;
    var n = (contactName || '').toLowerCase();
    return kws.some(function (kw) { return n.includes(kw); });
  }

  // ── Chart instance ────────────────────────────────────────────────────
  var chartInstance = null;

  function buildChart(labels, mainData, compareData, compareYear) {
    var ctx = document.getElementById('revenueChart').getContext('2d');
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

    var datasets = [{
      label: 'Umsatz',
      data: mainData,
      backgroundColor: '#4f46e5',
      borderRadius: 4,
      borderSkipped: false,
    }];

    if (compareData) {
      datasets.push({
        label: compareYear ? '' + compareYear : 'Vorjahr',
        data: compareData,
        backgroundColor: '#cbd5e1',
        borderRadius: 4,
        borderSkipped: false,
      });
    }

    chartInstance = new Chart(ctx, {
      type: 'bar',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: !!compareData, position: 'top' },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                return ' ' + fmt(ctx.parsed.y);
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false } },
          y: {
            beginAtZero: true,
            ticks: {
              callback: function (v) {
                return (v / 1000).toLocaleString('de-DE', { maximumFractionDigits: 0 }) + ' k €';
              }
            }
          }
        }
      }
    });
  }

  // ── Load ──────────────────────────────────────────────────────────────
  loadBtn.addEventListener('click', load);

  function load() {
    var fromYear   = parseInt(yearFrom.value);
    var toYear     = parseInt(yearTo.value);
    var doCompare  = compareToggle.checked;
    var compareYear = fromYear - 1; // use year before fromYear as compare

    errorEl.innerHTML = '';
    loadingEl.classList.remove('hidden');
    contentEl.classList.add('hidden');

    // Build all months in range
    var months = [];
    for (var y = fromYear; y <= toYear; y++) {
      for (var m = 1; m <= 12; m++) {
        months.push({ year: y, month: m });
      }
    }

    // Build compare months (same months but previous year)
    var compareMonths = doCompare ? months.map(function (mo) {
      return { year: mo.year - 1, month: mo.month };
    }) : [];

    // Also collect unique years for revenue + adjustments queries
    var allMonths = months.concat(compareMonths);

    Promise.all([
      Promise.all(allMonths.map(function (mo) { return window.db.revenue.forMonth(mo.year, mo.month); })),
      Promise.all(allMonths.map(function (mo) { return window.db.adjustments.forMonth(mo.year, mo.month); })),
    ])
    .then(function (results) {
      var revenueResults    = results[0];
      var adjustmentResults = results[1];

      // Build maps: 'YYYY-M' → netRevenue
      var revenueMap = {};
      allMonths.forEach(function (mo, i) {
        var key = mo.year + '-' + mo.month;
        var rev = 0;
        revenueResults[i].forEach(function (row) {
          if (!isExcluded(row.contact_name)) rev += (row.total_amount || 0);
        });
        adjustmentResults[i].forEach(function (row) {
          rev += (row.revenue_deduction || 0);
        });
        revenueMap[key] = (revenueMap[key] || 0) + rev;
      });

      loadingEl.classList.add('hidden');
      contentEl.classList.remove('hidden');

      render(months, revenueMap, doCompare);
    })
    .catch(function (e) {
      loadingEl.classList.add('hidden');
      showError(e.message);
    });
  }

  function render(months, revenueMap, doCompare) {
    var labels      = [];
    var mainData    = [];
    var compareData = doCompare ? [] : null;

    var total       = 0;
    var best        = 0;
    var currentVal  = null;

    months.forEach(function (mo) {
      var key     = mo.year + '-' + mo.month;
      var val     = revenueMap[key] || 0;
      labels.push(MONTHS_LABEL[mo.month - 1].slice(0, 3) + ' ' + mo.year);
      mainData.push(val);
      total += val;
      if (val > best) best = val;
      if (mo.year === curYear && mo.month === curMonth) currentVal = val;

      if (doCompare) {
        var prevKey = (mo.year - 1) + '-' + mo.month;
        compareData.push(revenueMap[prevKey] || 0);
      }
    });

    var avg = months.length > 0 ? total / months.length : 0;

    document.getElementById('kpiTotal').textContent   = fmt(total);
    document.getElementById('kpiAvg').textContent     = fmt(avg);
    document.getElementById('kpiBest').textContent    = fmt(best);
    document.getElementById('kpiCurrent').textContent = currentVal !== null ? fmt(currentVal) : '—';

    buildChart(labels, mainData, compareData, doCompare ? (parseInt(yearFrom.value) - 1) : null);

    // Show/hide delta column
    if (doCompare) {
      thDelta.classList.remove('hidden-col');
      document.querySelectorAll('td.hidden-col').forEach(function (td) { td.classList.remove('hidden-col'); });
    } else {
      thDelta.classList.add('hidden-col');
    }

    // Render table
    timelineBody.innerHTML = '';
    var running = 0;
    months.forEach(function (mo, i) {
      var val    = mainData[i];
      var prevVal = doCompare ? (compareData[i] || 0) : null;
      running += val;

      var deltaHtml = '';
      if (doCompare) {
        if (prevVal > 0) {
          var pct   = ((val - prevVal) / prevVal) * 100;
          var arrow = pct >= 0 ? '↑' : '↓';
          var cls   = pct >= 0 ? 'delta-pos' : 'delta-neg';
          deltaHtml = '<span class="' + cls + '">' + arrow + ' ' + Math.abs(pct).toFixed(1) + '%</span>';
        } else if (val > 0) {
          deltaHtml = '<span class="delta-pos">Neu</span>';
        } else {
          deltaHtml = '<span class="delta-neutral">—</span>';
        }
      }

      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + MONTHS_LABEL[mo.month - 1] + ' ' + mo.year + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt(val) + '</td>' +
        '<td class="right' + (doCompare ? '' : ' hidden-col') + '">' + (doCompare ? deltaHtml : '') + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums;color:var(--text-secondary)">' + fmt(running) + '</td>';
      timelineBody.appendChild(tr);
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  load();
})();
