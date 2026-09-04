(function () {
  'use strict';

  var loadingEl   = document.getElementById('loading');
  var contentEl   = document.getElementById('content');
  var errorEl     = document.getElementById('error');
  var emptyState  = document.getElementById('emptyState');
  var yearSelect  = document.getElementById('yearSelect');
  var caveatBox   = document.getElementById('caveatBox');
  var custBody    = document.getElementById('custBody');

  var toggleCostDetails  = document.getElementById('toggleCostDetails');
  var costDetailsCard    = document.getElementById('costDetailsCard');
  var costDetailsYear    = document.getElementById('costDetailsYear');
  var costDetailsBody    = document.getElementById('costDetailsBody');
  var costDetailsSum     = document.getElementById('costDetailsSum');
  var costDetailsUndated = document.getElementById('costDetailsUndated');

  var MONTHS_LABEL = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];

  var TYPE_LABELS = {
    'messe':            'Messe',
    'online-marketing': 'Online-Marketing',
    'seo':              'SEO',
    'ki':               'KI-Suche',
    'kaltakquise':       'Kaltakquise',
    'empfehlung':        'Empfehlung',
    'sonstige':          'Sonstige',
  };

  function fmt(n) {
    return (n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }
  function fmtInt(n) { return (n || 0).toLocaleString('de-DE'); }
  function ym(year, month) { return year * 12 + (month - 1); }
  function ymLabel(year, month) { return MONTHS_LABEL[month - 1] + ' ' + year; }
  function ymToYearMonth(v) { return { year: Math.floor(v / 12), month: (v % 12) + 1 }; }

  function showError(msg) {
    errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' + msg + '</div>';
  }

  var allRevenue  = [];  // raw rows from revenue table
  var allCosts    = [];  // raw rows from acquisition_costs
  var allOverrides = []; // contact_overrides ({contact_name, status})
  var revByContact = {}; // contact_name -> [{year,month,amount}] sorted asc
  var firstYmByContact = {}; // contact_name -> ym of first-ever revenue
  var earliestDataYm = null;
  var latestDataYm   = null;

  function normC(s) { return (s || '').trim().toLowerCase(); }

  function buildIndexes() {
    // Software-/PPC-Tools-Kunden ausschließen (manuell getaggt + 99-€-Auto-Erkennung)
    var excluded = {};
    allOverrides.forEach(function (o) {
      if (o.status === 'excluded') excluded[normC(o.contact_name)] = 1;
      else if (o.status && o.status.indexOf('cat:') === 0 && o.status.slice(4) === 'Software') excluded[normC(o.contact_name)] = 1;
    });
    var auto = window.detectSoftwareContacts ? window.detectSoftwareContacts(allRevenue) : {};
    Object.keys(auto).forEach(function (k) { excluded[k] = 1; });

    revByContact = {};
    allRevenue.forEach(function (r) {
      if (!r.contact_name || excluded[normC(r.contact_name)]) return;
      if (!revByContact[r.contact_name]) revByContact[r.contact_name] = [];
      revByContact[r.contact_name].push({ year: r.year, month: r.month, amount: r.total_amount || 0 });
    });
    firstYmByContact = {};
    Object.keys(revByContact).forEach(function (name) {
      var rows = revByContact[name];
      rows.sort(function (a, b) { return ym(a.year, a.month) - ym(b.year, b.month); });
      firstYmByContact[name] = ym(rows[0].year, rows[0].month);
    });
    var allYms = allRevenue.map(function (r) { return ym(r.year, r.month); });
    earliestDataYm = allYms.length ? Math.min.apply(null, allYms) : null;
    latestDataYm   = allYms.length ? Math.max.apply(null, allYms) : null;
  }

  function populateYearSelect() {
    var earliestYear = earliestDataYm !== null ? ymToYearMonth(earliestDataYm).year : new Date().getFullYear();
    var latestYear    = latestDataYm !== null ? ymToYearMonth(latestDataYm).year : new Date().getFullYear();
    yearSelect.innerHTML = '';
    for (var y = latestYear; y >= earliestYear; y--) {
      var opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      yearSelect.appendChild(opt);
    }
    // Default to 2025 if present, otherwise the most recent full year
    var preferred = 2025;
    var hasPreferred = Array.prototype.slice.call(yearSelect.options).some(function (o) { return parseInt(o.value, 10) === preferred; });
    yearSelect.value = hasPreferred ? String(preferred) : String(latestYear);
  }

  var breakevenChart = null;

  function render(year) {
    caveatBox.innerHTML = '';

    var isFirstDataYear = earliestDataYm !== null && year === ymToYearMonth(earliestDataYm).year;
    var latestFullMonth = latestDataYm !== null ? ymToYearMonth(latestDataYm) : null;
    var isCurrentIncompleteYear = latestFullMonth && year === latestFullMonth.year && latestFullMonth.month < 12;

    var caveats = [];
    if (isFirstDataYear) {
      caveats.push('<strong>Erstes Datenjahr:</strong> Ob diese Kunden wirklich neu gewonnen wurden oder schon vorher bestanden, lässt sich nicht sicher feststellen — vor ' + year + ' liegen keine Umsatzdaten vor.');
    }
    if (isCurrentIncompleteYear) {
      caveats.push('<strong>Laufendes Jahr:</strong> ' + year + ' ist noch nicht abgeschlossen (Daten bis ' + ymLabel(latestFullMonth.year, latestFullMonth.month) + '). Zahlen werden sich noch ändern.');
    }
    if (caveats.length) {
      caveatBox.innerHTML = '<div class="caveat-box">⚠️ ' + caveats.join('<br>') + '</div>';
    }

    // ── Marketing-Investment im Kohortenjahr ──────────────────────────
    var investment = 0;
    var costsInYear = [];
    allCosts.forEach(function (c) {
      if (!c.cost_date) return;
      var y = parseInt(c.cost_date.slice(0, 4), 10);
      if (y === year) { investment += (c.amount || 0); costsInYear.push(c); }
    });
    renderCostDetails(year, costsInYear, investment);

    // ── Neue Kunden im Kohortenjahr ────────────────────────────────────
    var newCustomers = Object.keys(firstYmByContact).filter(function (name) {
      return ymToYearMonth(firstYmByContact[name]).year === year;
    }).sort(function (a, b) { return a.localeCompare(b, 'de'); });

    var cac = newCustomers.length > 0 ? investment / newCustomers.length : 0;

    // ── Per-Kunde Auswertung ────────────────────────────────────────────
    var rows = newCustomers.map(function (name) {
      var startYm = firstYmByContact[name];
      var start = ymToYearMonth(startYm);
      var history = revByContact[name]; // sorted asc, from their first month onward (may extend beyond cohort year)

      var revYear = 0;
      history.forEach(function (r) { if (r.year === year) revYear += r.amount; });

      var rev90 = 0;
      history.forEach(function (r) { if (ym(r.year, r.month) < startYm + 3) rev90 += r.amount; });

      var revTotal = history.reduce(function (s, r) { return s + r.amount; }, 0);

      // Break-even: walk cumulative revenue from start month forward.
      var cumulative = 0;
      var breakevenYm = null;
      history.forEach(function (r) {
        cumulative += r.amount;
        if (breakevenYm === null && cac > 0 && cumulative >= cac) breakevenYm = ym(r.year, r.month);
      });
      var monthsToBreakeven = breakevenYm !== null ? (breakevenYm - startYm) : null;

      return {
        name: name, start: start, revYear: revYear, rev90: rev90, revTotal: revTotal,
        breakevenYm: breakevenYm, monthsToBreakeven: monthsToBreakeven,
      };
    });

    // ── KPIs ─────────────────────────────────────────────────────────
    document.getElementById('kpiInvestment').textContent = fmt(investment);
    document.getElementById('kpiNewCustomers').textContent = fmtInt(newCustomers.length);
    document.getElementById('kpiCac').textContent = newCustomers.length > 0 ? fmt(cac) : '—';

    var totalRevYear = rows.reduce(function (s, r) { return s + r.revYear; }, 0);
    var avgRevYear   = rows.length ? totalRevYear / rows.length : 0;
    var avgRev90     = rows.length ? rows.reduce(function (s, r) { return s + r.rev90; }, 0) / rows.length : 0;
    document.getElementById('kpiRevYear').textContent = rows.length ? fmt(avgRevYear) : '—';
    document.getElementById('kpiRev90').textContent   = rows.length ? fmt(avgRev90) : '—';

    var kpiRevYearTotalEl = document.getElementById('kpiRevYearTotal');
    var kpiRoiHintEl      = document.getElementById('kpiRoiHint');
    kpiRevYearTotalEl.textContent = rows.length ? fmt(totalRevYear) : '—';
    if (investment > 0 && rows.length) {
      var roi = totalRevYear / investment;
      kpiRoiHintEl.innerHTML = 'Alle neuen Kunden zusammen, im Kohortenjahr · <span class="' + (roi >= 1 ? 'pos' : 'neg') + '">' + roi.toFixed(1) + '× Investment</span>';
    } else {
      kpiRoiHintEl.textContent = 'Alle neuen Kunden zusammen, im Kohortenjahr';
    }

    var beCount = rows.filter(function (r) { return r.breakevenYm !== null; }).length;
    document.getElementById('kpiBreakeven').textContent = rows.length ? (beCount + ' / ' + rows.length) : '—';
    document.getElementById('kpiBreakevenHint').textContent = rows.length
      ? Math.round(100 * beCount / rows.length) + '% der neuen Kunden (Stand ' + (latestFullMonth ? ymLabel(latestFullMonth.year, latestFullMonth.month) : 'heute') + ')'
      : 'von neuen Kunden (Stand heute)';

    // ── Tabelle ──────────────────────────────────────────────────────
    custBody.innerHTML = '';
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      var beHtml = r.breakevenYm !== null
        ? '<span class="be-badge be-yes">✓ nach ' + r.monthsToBreakeven + ' Monat' + (r.monthsToBreakeven === 1 ? '' : 'en') + ' (' + ymLabel(ymToYearMonth(r.breakevenYm).year, ymToYearMonth(r.breakevenYm).month) + ')</span>'
        : '<span class="be-badge be-no">noch nicht erreicht</span>';
      tr.innerHTML =
        '<td style="font-weight:500">' + escHtml(r.name) + '</td>' +
        '<td>' + ymLabel(r.start.year, r.start.month) + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt(r.revYear) + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt(r.rev90) + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt(r.revTotal) + '</td>' +
        '<td>' + beHtml + '</td>';
      custBody.appendChild(tr);
    });

    // ── Break-even-Chart: Ø kumulierter Umsatz je Monat seit Start vs. CAC ──
    renderChart(rows, cac);

    // ── Empty state ──────────────────────────────────────────────────
    if (newCustomers.length === 0) {
      contentEl.classList.add('hidden');
      emptyState.classList.remove('hidden');
    } else {
      contentEl.classList.remove('hidden');
      emptyState.classList.add('hidden');
    }
  }

  function renderChart(rows, cac) {
    var ctx = document.getElementById('breakevenChart');
    if (!ctx) return;

    // Average cumulative revenue at month-offset 0,1,2,... since each customer's start,
    // averaged across all customers who have data at that offset.
    var maxOffset = 0;
    var perCustomerSeries = rows.map(function (r) {
      var startYm = firstYmByContact[r.name];
      var history = revByContact[r.name];
      var byOffset = {};
      var cumulative = 0;
      history.forEach(function (h) {
        var offset = ym(h.year, h.month) - startYm;
        if (offset < 0) return;
        cumulative += h.amount;
        byOffset[offset] = cumulative;
        if (offset > maxOffset) maxOffset = offset;
      });
      return byOffset;
    });

    maxOffset = Math.min(maxOffset, 17); // cap at 18 months for readability
    var labels = [];
    var avgData = [];
    for (var o = 0; o <= maxOffset; o++) {
      labels.push('M' + (o + 1));
      var sum = 0, count = 0;
      perCustomerSeries.forEach(function (series) {
        // Once a customer's series has a value at offset o, use last-known cumulative
        // (carry forward) so customers with sparse months don't drop out of the average.
        var lastKnown = null;
        for (var i = o; i >= 0; i--) { if (series[i] !== undefined) { lastKnown = series[i]; break; } }
        if (lastKnown !== null) { sum += lastKnown; count++; }
      });
      avgData.push(count > 0 ? sum / count : null);
    }

    if (breakevenChart) breakevenChart.destroy();
    breakevenChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Ø kumulierter Umsatz je Kunde',
            data: avgData,
            borderColor: '#4f46e5',
            backgroundColor: 'rgba(79,70,229,.08)',
            fill: true,
            tension: .2,
            pointRadius: 2,
          },
          {
            label: 'Blended CAC',
            data: labels.map(function () { return cac > 0 ? cac : null; }),
            borderColor: '#ef4444',
            borderDash: [6, 4],
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
        scales: {
          y: { ticks: { callback: function (v) { return v.toLocaleString('de-DE') + ' €'; } } },
          x: { title: { display: true, text: 'Monate seit Kundenstart', font: { size: 11 } } },
        },
      },
    });
  }

  function escHtml(str) {
    return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Itemized list of exactly which acquisition_costs entries make up the
  // "Marketing-Investment" KPI for the selected year — so the number can be
  // checked against the actual entries in Akquisition, not just trusted blind.
  function renderCostDetails(year, costsInYear, investment) {
    costDetailsYear.textContent = year;

    var sorted = costsInYear.slice().sort(function (a, b) {
      return (b.cost_date || '').localeCompare(a.cost_date || '');
    });

    costDetailsBody.innerHTML = '';
    if (sorted.length === 0) {
      costDetailsBody.innerHTML = '<tr><td colspan="4" style="color:var(--text-secondary)">Keine Akquisitionskosten mit Datum in ' + year + '.</td></tr>';
    } else {
      sorted.forEach(function (c) {
        var typeLabel = TYPE_LABELS[c.source_type] || c.source_type || '—';
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td style="font-weight:500">' + escHtml(c.source_name || '—') +
            (c.notes ? '<br><span style="font-size:11px;color:var(--text-secondary);font-weight:400">' + escHtml(c.notes) + '</span>' : '') +
          '</td>' +
          '<td><span style="font-size:12px;background:var(--surface-hover,#f1f5f9);padding:2px 8px;border-radius:4px;border:1px solid var(--border)">' + typeLabel + '</span></td>' +
          '<td>' + (c.cost_date || '—') + '</td>' +
          '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt(c.amount || 0) + '</td>';
        costDetailsBody.appendChild(tr);
      });
    }
    costDetailsSum.textContent = fmt(investment);

    // Entries with NO date at all never enter ANY year's total — surface them
    // so nothing is silently missing from every cohort year without a trace.
    var undated = allCosts.filter(function (c) { return !c.cost_date; });
    if (undated.length > 0) {
      var undatedSum = undated.reduce(function (s, c) { return s + (c.amount || 0); }, 0);
      var names = undated.map(function (c) { return escHtml(c.source_name || '—') + ' (' + fmt(c.amount || 0) + ')'; }).join(', ');
      costDetailsUndated.innerHTML =
        '⚠️ <strong>' + undated.length + ' Eintrag' + (undated.length === 1 ? '' : 'e') + ' ohne Datum</strong> (Summe ' + fmt(undatedSum) + ') ' +
        'fließen in <strong>kein</strong> Kohortenjahr ein: ' + names + '. ' +
        'Datum in <a href="acquisition.html">Akquisition</a> nachtragen, falls sie zu ' + year + ' oder einem anderen Jahr gehören.';
    } else {
      costDetailsUndated.innerHTML = '';
    }
  }

  function loadData() {
    errorEl.innerHTML = '';
    loadingEl.classList.remove('hidden');
    contentEl.classList.add('hidden');
    emptyState.classList.add('hidden');

    Promise.all([
      window.db.revenue.allRows(),
      window.db.acquisitionCosts.list(),
      (window.db.contactOverrides ? window.db.contactOverrides.listAll() : Promise.resolve([])).catch(function () { return []; }),
    ]).then(function (results) {
      allRevenue   = results[0];
      allCosts     = results[1];
      allOverrides = results[2] || [];
      buildIndexes();
      populateYearSelect();
      loadingEl.classList.add('hidden');
      render(parseInt(yearSelect.value, 10));
    }).catch(function (e) {
      loadingEl.classList.add('hidden');
      showError(e.message === 'NOT_CONFIGURED'
        ? 'Keine Supabase-Verbindung. Bitte <a href="settings.html">Einstellungen</a> prüfen.'
        : e.message);
    });
  }

  yearSelect.addEventListener('change', function () {
    render(parseInt(yearSelect.value, 10));
  });

  toggleCostDetails.addEventListener('click', function (e) {
    e.preventDefault();
    var isHidden = costDetailsCard.classList.contains('hidden');
    if (isHidden) {
      costDetailsCard.classList.remove('hidden');
      toggleCostDetails.textContent = 'Details ausblenden';
    } else {
      costDetailsCard.classList.add('hidden');
      toggleCostDetails.textContent = 'Details anzeigen';
    }
  });

  loadData();
})();
