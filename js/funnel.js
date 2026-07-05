/**
 * Profit-Funnel – Margen-Kaskade DB1 → DB2 → DB3 → Gewinn.
 * Umsatz aus der revenue-Tabelle (netto), Kosten aus der Kostenanalyse
 * (window.CostEngine.summarize → byCategory netto). Die Zuordnung
 * Kategorie → Funnel-Stufe ist im Tool editierbar (localStorage).
 */
(function () {
  'use strict';

  var E = window.CostEngine;
  var el = function (id) { return document.getElementById(id); };
  var loadingEl = el('loading'), contentEl = el('content'), errorEl = el('error');

  var MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

  // ── Funnel-Stufen ────────────────────────────────────────────────────
  var STAGES = [
    { key: 'ma',        label: 'Mitarbeiterkosten',  color: '#6366f1' },
    { key: 'direkt',    label: 'Direkte Sachkosten', color: '#0ea5e9' },
    { key: 'fix',       label: 'Fixkosten',          color: '#f59e0b' },
    { key: 'marketing', label: 'Marketing',          color: '#ec4899' },
    { key: 'ignore',    label: 'Ignorieren',         color: '#94a3b8' },
  ];
  var STAGE_BY_KEY = {}; STAGES.forEach(function (s) { STAGE_BY_KEY[s.key] = s; });

  // Sinnvolle Standard-Zuordnung nach Kategorie-Name (überschreibbar).
  var DEFAULT_MAP = {
    'Employee': 'ma', 'Mitarbeiter': 'ma', 'Personal': 'ma', 'Gehalt': 'ma', 'Lohn': 'ma',
    'Freelancer': 'ma', 'Freelancer/Externe': 'ma', 'Externe': 'ma',
    'Software': 'direkt', 'SaaS': 'direkt', 'Reisekosten': 'direkt', 'Reise': 'direkt', 'Hotel': 'direkt',
    'Büro': 'fix', 'Buero': 'fix', 'Equipment': 'fix', 'Restaurant': 'fix', 'Bewirtung': 'fix',
    'Team-Event': 'fix', 'PayPal': 'fix', 'Andere': 'fix', 'Sonstiges': 'fix', '—': 'fix',
    'Marketing': 'marketing', 'Werbung': 'marketing', 'Ads': 'marketing',
    'Steuern': 'ignore', 'Umsatzsteuer': 'ignore', 'Umsatzsteuervoranmeldung': 'ignore',
  };

  function loadMap() { try { return JSON.parse(localStorage.getItem('funnelStageMap') || '{}') || {}; } catch (e) { return {}; } }
  function saveMap(m) { localStorage.setItem('funnelStageMap', JSON.stringify(m)); }

  // Stufe für eine Kategorie: User-Override → Name-Default → Heuristik →
  // Kostenanalyse-Einstellung (nicht profit-relevant ⇒ ignore) → Fallback Fixkosten.
  function stageFor(cat) {
    var m = STATE.map;
    if (m && m[cat]) return m[cat];
    if (DEFAULT_MAP[cat]) return DEFAULT_MAP[cat];
    var n = (cat || '').toLowerCase();
    if (/steuer|vorsteuer|finanzamt/.test(n)) return 'ignore';
    if (/marketing|werb|\bads\b|kampagn/.test(n)) return 'marketing';
    if (/mitarbeiter|gehalt|lohn|personal|freelanc|employee|extern/.test(n)) return 'ma';
    if (/software|saas|abo|hosting|reise|hotel|travel|flug/.test(n)) return 'direkt';
    if (STATE.settings && STATE.settings[cat] === false) return 'ignore';
    return 'fix';
  }

  // ── State ────────────────────────────────────────────────────────────
  var STATE = { revenue: [], excluded: {}, byMonth: {}, settings: {}, map: {}, cats: {}, minYm: null, maxYm: null };

  function normC(s) { return (s || '').trim().toLowerCase(); }
  function getExcludeKeywords() {
    return (localStorage.getItem('revenueExcludeKeywords') || '')
      .split('\n').map(function (k) { return k.trim().toLowerCase(); }).filter(function (k) { return k.length > 0; });
  }
  function isExcluded(name) {
    if (STATE.excluded[normC(name)]) return true;
    var kws = getExcludeKeywords(); if (!kws.length) return false;
    var n = (name || '').toLowerCase(); return kws.some(function (kw) { return n.indexOf(kw) !== -1; });
  }

  function fmtEur(n) { return Math.round(n).toLocaleString('de-DE') + ' €'; }
  function fmtPct(part, whole) { if (!whole) return '—'; return (part / whole * 100).toFixed(1).replace('.', ',') + ' %'; }
  function showError(msg) { loadingEl.classList.add('hidden'); errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' + msg + '</div>'; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // ── Laden ────────────────────────────────────────────────────────────
  function load() {
    errorEl.innerHTML = ''; loadingEl.classList.remove('hidden'); contentEl.classList.add('hidden');
    STATE.map = loadMap();
    Promise.all([
      window.db.revenue.allRows(),
      (window.db.contactOverrides ? window.db.contactOverrides.listAll() : Promise.resolve([])).catch(function () { return []; }),
      window.db.cost.transactions.all(),
      window.db.cost.categorySettings.list().catch(function () { return []; }),
    ]).then(function (r) {
      STATE.excluded = {};
      (r[1] || []).forEach(function (o) { if (o.status === 'excluded') STATE.excluded[normC(o.contact_name)] = 1; });
      STATE.settings = {};
      (r[3] || []).forEach(function (s) { STATE.settings[s.category] = s.include_in_profit; });

      // Umsatz je Monat (netto, ohne ausgeschlossene Kontakte)
      var rev = {}, minYm = null, maxYm = null;
      (r[0] || []).forEach(function (row) {
        if (!row.contact_name || isExcluded(row.contact_name)) return;
        var amt = Number(row.total_amount) || 0; if (!amt) return;
        var ym = row.year * 12 + (row.month - 1);
        rev[ym] = (rev[ym] || 0) + amt;
        if (minYm === null || ym < minYm) minYm = ym; if (maxYm === null || ym > maxYm) maxYm = ym;
      });
      STATE.revenue = rev;

      // Kosten je Monat/Kategorie (netto) via Cost-Engine
      var by = E.summarize(r[2] || [], STATE.settings);
      STATE.byMonth = by;
      Object.keys(by).forEach(function (k) {
        var b = by[k]; var ym = b.year * 12 + (b.month - 1);
        if (minYm === null || ym < minYm) minYm = ym; if (maxYm === null || ym > maxYm) maxYm = ym;
      });

      if (minYm === null) { minYm = maxYm = (new Date().getUTCFullYear()) * 12; }
      STATE.minYm = minYm; STATE.maxYm = maxYm;

      buildPeriodSelectors();
      loadingEl.classList.add('hidden'); contentEl.classList.remove('hidden');
      compute();
    }).catch(function (e) { showError(e.message || String(e)); });
  }

  // ── Periodenauswahl ──────────────────────────────────────────────────
  function ymToYear(ym) { return Math.floor(ym / 12); }
  function ymToMonth(ym) { return (ym % 12) + 1; }

  function buildPeriodSelectors() {
    var y0 = ymToYear(STATE.minYm), y1 = ymToYear(STATE.maxYm);
    var years = [];
    for (var y = y0; y <= y1; y++) years.push(y);
    var monthOpts = MONTHS.map(function (m, i) { return '<option value="' + (i + 1) + '">' + m + '</option>'; }).join('');
    var yearOpts = years.map(function (y) { return '<option value="' + y + '">' + y + '</option>'; }).join('');
    el('fromM').innerHTML = monthOpts; el('toM').innerHTML = monthOpts;
    el('fromY').innerHTML = yearOpts; el('toY').innerHTML = yearOpts;

    // Default: laufendes Jahr des jüngsten Monats, Jan → jüngster Monat
    var defFrom = ymToYear(STATE.maxYm) * 12 + 0;               // Jan des Jahres
    if (defFrom < STATE.minYm) defFrom = STATE.minYm;
    el('fromM').value = ymToMonth(defFrom); el('fromY').value = ymToYear(defFrom);
    el('toM').value = ymToMonth(STATE.maxYm); el('toY').value = ymToYear(STATE.maxYm);
  }

  function selectedRange() {
    var from = (+el('fromY').value) * 12 + (+el('fromM').value - 1);
    var to = (+el('toY').value) * 12 + (+el('toM').value - 1);
    if (from > to) { var t = from; from = to; to = t; }
    return { from: from, to: to };
  }

  // ── Berechnung ───────────────────────────────────────────────────────
  function compute() {
    var rng = selectedRange();

    // Umsatz über Periode
    var umsatz = 0;
    Object.keys(STATE.revenue).forEach(function (ym) {
      if (+ym >= rng.from && +ym <= rng.to) umsatz += STATE.revenue[ym];
    });

    // Kosten je Kategorie über Periode
    var catCost = {};
    Object.keys(STATE.byMonth).forEach(function (k) {
      var b = STATE.byMonth[k]; var ym = b.year * 12 + (b.month - 1);
      if (ym < rng.from || ym > rng.to) return;
      Object.keys(b.byCategory).forEach(function (c) {
        catCost[c] = (catCost[c] || 0) + b.byCategory[c];
      });
    });
    STATE.cats = catCost;

    // Kosten je Stufe (+ Kategorien je Stufe für Aufschlüsselung)
    var stageCost = { ma: 0, direkt: 0, fix: 0, marketing: 0, ignore: 0 };
    var stageCats = { ma: [], direkt: [], fix: [], marketing: [], ignore: [] };
    Object.keys(catCost).forEach(function (c) {
      var st = stageFor(c);
      stageCost[st] += catCost[c];
      stageCats[st].push({ cat: c, amount: catCost[c] });
    });
    Object.keys(stageCats).forEach(function (k) { stageCats[k].sort(function (a, b) { return b.amount - a.amount; }); });

    var db1 = umsatz - stageCost.ma;
    var db2 = db1 - stageCost.direkt;
    var db3 = db2 - stageCost.fix;
    var gewinn = db3 - stageCost.marketing;

    var res = { umsatz: umsatz, stageCost: stageCost, stageCats: stageCats, db1: db1, db2: db2, db3: db3, gewinn: gewinn };
    renderKpis(res);
    renderWaterfall(res);
    renderBreakdown(res);
    renderMap();
  }

  // ── KPI-Strip ────────────────────────────────────────────────────────
  function renderKpis(r) {
    function card(label, value, sub, cls) {
      return '<div class="kpi-card ' + (cls || '') + '"><div class="kpi-label">' + label + '</div>' +
        '<div class="kpi-value' + (cls === 'profit' ? (r.gewinn >= 0 ? ' pos' : ' neg') : '') + '">' + value + '</div>' +
        '<div class="kpi-sub">' + sub + '</div></div>';
    }
    el('kpis').innerHTML =
      card('Umsatz (netto)', fmtEur(r.umsatz), 'Gesamt in der Periode') +
      card('DB1 · nach Mitarbeitern', fmtEur(r.db1), '− ' + fmtEur(r.stageCost.ma) + ' MA · Marge ' + fmtPct(r.db1, r.umsatz), 'db') +
      card('DB2 · nach Sachkosten', fmtEur(r.db2), '− ' + fmtEur(r.stageCost.direkt) + ' direkt · Marge ' + fmtPct(r.db2, r.umsatz), 'db') +
      card('DB3 · nach Fixkosten', fmtEur(r.db3), '− ' + fmtEur(r.stageCost.fix) + ' fix · Marge ' + fmtPct(r.db3, r.umsatz), 'db') +
      card('Gewinn', fmtEur(r.gewinn), '− ' + fmtEur(r.stageCost.marketing) + ' Marketing · Marge ' + fmtPct(r.gewinn, r.umsatz), 'profit');
  }

  // ── Waterfall ────────────────────────────────────────────────────────
  var chart = null;
  function renderWaterfall(r) {
    var GREEN = '#10b981', BLUE = '#3b82f6', RED = '#ef4444';
    // steps: {label, lo, hi, color, value}
    var steps = [];
    steps.push({ label: 'Umsatz', lo: 0, hi: r.umsatz, color: GREEN, value: r.umsatz });
    var run = r.umsatz;
    function dec(label, amount) { steps.push({ label: label, lo: run - amount, hi: run, color: RED, value: -amount }); run -= amount; }
    function sub(label, val) { steps.push({ label: label, lo: 0, hi: val, color: BLUE, value: val }); }
    dec('− Mitarbeiter', r.stageCost.ma);
    sub('DB1', r.db1);
    dec('− Sachkosten', r.stageCost.direkt);
    sub('DB2', r.db2);
    dec('− Fixkosten', r.stageCost.fix);
    sub('DB3', r.db3);
    dec('− Marketing', r.stageCost.marketing);
    steps.push({ label: 'Gewinn', lo: Math.min(0, r.gewinn), hi: Math.max(0, r.gewinn), color: r.gewinn >= 0 ? GREEN : RED, value: r.gewinn });

    var labels = steps.map(function (s) { return s.label; });
    var data = steps.map(function (s) { return [s.lo, s.hi]; });
    var colors = steps.map(function (s) { return s.color; });

    var valuePlugin = {
      id: 'wfValues',
      afterDatasetsDraw: function (c) {
        var ctx = c.ctx, meta = c.getDatasetMeta(0);
        ctx.save();
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        meta.data.forEach(function (bar, i) {
          var s = steps[i];
          var txt = (s.value > 0 ? '' : (s.value < 0 ? '−' : '')) + fmtEur(Math.abs(s.value)).replace(' €', '') + ' €';
          ctx.fillStyle = '#334155';
          ctx.fillText(txt, bar.x, bar.y - 5);
        });
        ctx.restore();
      },
    };

    var cfg = {
      type: 'bar',
      data: { labels: labels, datasets: [{ data: data, backgroundColor: colors, borderRadius: 3, borderSkipped: false, barPercentage: 0.72, categoryPercentage: 0.86 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 11 }, maxRotation: 0, autoSkip: false } },
          y: { beginAtZero: true, ticks: { callback: function (v) { return (v / 1000) + 'k'; }, font: { size: 11 } }, grid: { color: '#f1f5f9' } },
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (c) { var s = steps[c.dataIndex]; return (s.value < 0 ? 'Kosten: ' : '') + fmtEur(Math.abs(s.value)); } } },
        },
      },
      plugins: [valuePlugin],
    };
    if (chart) chart.destroy();
    chart = new Chart(el('waterfall').getContext('2d'), cfg);
  }

  // ── Aufschlüsselung je Stufe ─────────────────────────────────────────
  function renderBreakdown(r) {
    var cols = ['ma', 'direkt', 'fix', 'marketing'].map(function (key) {
      var st = STAGE_BY_KEY[key];
      var rows = r.stageCats[key];
      var body = rows.length
        ? rows.map(function (x) { return '<div class="brk-row"><span>' + esc(x.cat) + '</span><span>' + fmtEur(x.amount) + '</span></div>'; }).join('')
        : '<div class="brk-row" style="opacity:.6">keine Kosten</div>';
      return '<div class="brk-col"><h4><span><span class="stage-chip" style="background:' + st.color + '"></span>' + st.label + '</span>' +
        '<span>' + fmtEur(r.stageCost[key]) + '</span></h4>' + body + '</div>';
    }).join('');
    var ign = r.stageCats.ignore;
    if (ign.length) {
      cols += '<div class="brk-col" style="opacity:.75"><h4><span><span class="stage-chip" style="background:' + STAGE_BY_KEY.ignore.color + '"></span>Ignoriert</span>' +
        '<span>' + fmtEur(r.stageCost.ignore) + '</span></h4>' +
        ign.map(function (x) { return '<div class="brk-row"><span>' + esc(x.cat) + '</span><span>' + fmtEur(x.amount) + '</span></div>'; }).join('') + '</div>';
    }
    el('breakdown').innerHTML = cols;
  }

  // ── Zuordnungs-Editor ────────────────────────────────────────────────
  function renderMap() {
    var cats = Object.keys(STATE.cats).sort(function (a, b) { return STATE.cats[b] - STATE.cats[a]; });
    var optsFor = function (sel) {
      return STAGES.map(function (s) { return '<option value="' + s.key + '"' + (s.key === sel ? ' selected' : '') + '>' + s.label + '</option>'; }).join('');
    };
    el('mapBody').innerHTML = cats.map(function (c) {
      var st = stageFor(c);
      var chip = '<span class="stage-chip" style="background:' + STAGE_BY_KEY[st].color + '"></span>';
      return '<tr><td>' + chip + esc(c) + '</td><td class="right">' + fmtEur(STATE.cats[c]) + '</td>' +
        '<td><select class="stage-sel" data-cat="' + esc(c) + '">' + optsFor(st) + '</select></td></tr>';
    }).join('') || '<tr><td colspan="3" style="opacity:.6;padding:14px">Keine Kosten in dieser Periode.</td></tr>';

    Array.prototype.forEach.call(document.querySelectorAll('.stage-sel'), function (sel) {
      sel.addEventListener('change', function () {
        var m = STATE.map || {};
        m[sel.getAttribute('data-cat')] = sel.value;
        STATE.map = m; saveMap(m);
        compute();
      });
    });
  }

  // ── Events ───────────────────────────────────────────────────────────
  el('loadBtn').addEventListener('click', function () { if (contentEl.classList.contains('hidden')) load(); else compute(); });
  ['fromM', 'fromY', 'toM', 'toY'].forEach(function (id) {
    el(id).addEventListener('change', function () { if (!contentEl.classList.contains('hidden')) compute(); });
  });

  load();
})();
