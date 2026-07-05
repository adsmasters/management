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
  var CUR = null;            // letztes Berechnungsergebnis (für Klick-Detail)
  var selectedStage = null;  // aktuell aufgeklappter Kostenblock

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

    CUR = { umsatz: umsatz, stageCost: stageCost, stageCats: stageCats, db1: db1, db2: db2, db3: db3, gewinn: gewinn };
    renderKpis(CUR);
    renderFunnel(CUR);
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

  // ── Echter Funnel (SVG) ──────────────────────────────────────────────
  // Trapez-Segmente, die nach unten enger werden. Breite ∝ Geldbetrag.
  // Kostenblöcke (MA/Sachkosten/Fix/Marketing) sind klickbar.
  function svgEsc(s) { return esc(s); }

  function renderFunnel(r) {
    var U = r.umsatz || 0;
    var vals = [U, r.db1, r.db2, r.db3, r.gewinn];               // Umsatz → DB1 → DB2 → DB3 → Gewinn
    var CX = 330, MAXW = 520, MINW = 58, TOPY = 26, HB = 90;
    var W = vals.map(function (v) { return U > 0 ? Math.max(MINW, (Math.max(v, 0) / U) * MAXW) : MINW; });
    var Y = []; for (var i = 0; i < 5; i++) Y.push(TOPY + i * HB);
    var LX = CX + MAXW / 2 + 24;                                 // x der rechten Wertlabels

    var costs = [
      { stage: 'ma',        label: 'Mitarbeiterkosten',  amount: r.stageCost.ma,        color: '#6366f1' },
      { stage: 'direkt',    label: 'Direkte Sachkosten', amount: r.stageCost.direkt,    color: '#0ea5e9' },
      { stage: 'fix',       label: 'Fixkosten',          amount: r.stageCost.fix,       color: '#f59e0b' },
      { stage: 'marketing', label: 'Marketing',          amount: r.stageCost.marketing, color: '#ec4899' },
    ];
    var points = [
      { label: 'Umsatz', val: U,       pct: 100,                   bold: true,  color: '#065f46' },
      { label: 'DB1',    val: r.db1,   pct: U ? r.db1 / U * 100 : 0 },
      { label: 'DB2',    val: r.db2,   pct: U ? r.db2 / U * 100 : 0 },
      { label: 'DB3',    val: r.db3,   pct: U ? r.db3 / U * 100 : 0 },
      { label: 'Gewinn', val: r.gewinn, pct: U ? r.gewinn / U * 100 : 0, bold: true, color: r.gewinn >= 0 ? '#065f46' : '#991b1b' },
    ];

    function pct1(x) { return x.toFixed(1).replace('.', ',') + ' %'; }

    var svg = '<svg viewBox="0 0 900 430" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,-apple-system,sans-serif">';

    // Kostenblöcke als Trapeze
    costs.forEach(function (c, i) {
      var wt = W[i], wb = W[i + 1], yt = Y[i], yb = Y[i + 1];
      var pts = [
        (CX - wt / 2) + ',' + yt, (CX + wt / 2) + ',' + yt,
        (CX + wb / 2) + ',' + yb, (CX - wb / 2) + ',' + yb,
      ].join(' ');
      var yc = yt + HB / 2;
      var pctU = U ? c.amount / U * 100 : 0;
      svg += '<g class="fstage' + (selectedStage === c.stage ? ' sel' : '') + '" data-stage="' + c.stage + '">' +
        '<polygon points="' + pts + '" fill="' + c.color + '"></polygon>' +
        '<text x="' + CX + '" y="' + (yc - 4) + '" text-anchor="middle" fill="#fff" font-size="13" font-weight="700">' + svgEsc(c.label) + '</text>' +
        '<text x="' + CX + '" y="' + (yc + 15) + '" text-anchor="middle" fill="#eef2ff" font-size="12">−' + fmtEur(c.amount) + '  ·  ' + pct1(pctU) + '</text>' +
        '</g>';
    });

    // Gewinn-„Auslauf" (Basis)
    var wg = W[4], yg = Y[4];
    svg += '<rect x="' + (CX - wg / 2) + '" y="' + yg + '" width="' + wg + '" height="26" rx="3" fill="' + (r.gewinn >= 0 ? '#10b981' : '#ef4444') + '"></rect>';

    // Rechte Wert-Marker (Umsatz, DB1-3, Gewinn) mit Führungslinie
    points.forEach(function (p, i) {
      var y = Y[i], edge = CX + W[i] / 2;
      svg += '<line x1="' + edge + '" y1="' + y + '" x2="' + (LX - 8) + '" y2="' + y + '" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3,3"></line>' +
        '<circle cx="' + edge + '" cy="' + y + '" r="3" fill="#64748b"></circle>' +
        '<text x="' + LX + '" y="' + (y - 3) + '" font-size="13" font-weight="' + (p.bold ? '700' : '600') + '" fill="' + (p.color || '#0f172a') + '">' + svgEsc(p.label) + '</text>' +
        '<text x="' + LX + '" y="' + (y + 14) + '" font-size="12" fill="#475569">' + fmtEur(p.val) + '  ·  ' + pct1(p.pct) + '</text>';
    });

    svg += '</svg>';
    el('funnel').innerHTML = svg;
    applyStageDetail();
  }

  // ── Klick-Detail je Kostenblock ──────────────────────────────────────
  function applyStageDetail() {
    var box = el('stageDetail');
    if (!selectedStage || !CUR) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    var st = STAGE_BY_KEY[selectedStage];
    var cats = (CUR.stageCats[selectedStage] || []);
    var tot = CUR.stageCost[selectedStage] || 0;
    var U = CUR.umsatz || 0;
    var html = '<div class="sd-head"><span class="stage-chip" style="background:' + st.color + '"></span>' +
      st.label + ' — ' + fmtEur(tot) + '<span class="sd-pct">' + fmtPct(tot, U) + ' vom Umsatz</span></div>';
    if (cats.length) {
      html += cats.map(function (x) {
        return '<div class="sd-row"><span>' + esc(x.cat) + '</span>' +
          '<span class="sd-amt">' + fmtEur(x.amount) + '<span class="sd-pct">' + fmtPct(x.amount, tot) + ' der Stufe</span></span></div>';
      }).join('');
    } else {
      html += '<div class="sd-row" style="opacity:.6">Keine Einzelkosten in dieser Periode.</div>';
    }
    box.innerHTML = html; box.classList.remove('hidden');
  }

  function toggleStage(stage) {
    selectedStage = (selectedStage === stage) ? null : stage;
    // Auswahl-Rahmen ohne Neuberechnung aktualisieren
    Array.prototype.forEach.call(document.querySelectorAll('#funnel .fstage'), function (g) {
      g.classList.toggle('sel', g.getAttribute('data-stage') === selectedStage);
    });
    applyStageDetail();
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
  el('funnel').addEventListener('click', function (e) {
    var g = e.target.closest ? e.target.closest('.fstage') : null;
    if (g) toggleStage(g.getAttribute('data-stage'));
  });
  el('loadBtn').addEventListener('click', function () { if (contentEl.classList.contains('hidden')) load(); else compute(); });
  ['fromM', 'fromY', 'toM', 'toY'].forEach(function (id) {
    el(id).addEventListener('change', function () { if (!contentEl.classList.contains('hidden')) compute(); });
  });

  load();
})();
