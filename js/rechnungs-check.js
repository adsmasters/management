(function () {
  'use strict';

  var loadingEl  = document.getElementById('loading');
  var errorEl    = document.getElementById('error');
  var tabsEl     = document.getElementById('tabs');
  var tabMatrix  = document.getElementById('tabMatrix');
  var tabAbgleich= document.getElementById('tabAbgleich');
  var viewMatrix = document.getElementById('viewMatrix');
  var viewAbgleich = document.getElementById('viewAbgleich');

  // Matrix elements
  var rcHead     = document.getElementById('rcHead');
  var rcBody     = document.getElementById('rcBody');
  var searchEl   = document.getElementById('search');
  var onlyGapsEl = document.getElementById('onlyGaps');
  var monthsEl   = document.getElementById('monthsBack');
  var summaryEl  = document.getElementById('rcSummary');

  // Abgleich elements
  var abMonth = document.getElementById('abMonth');
  var abYear  = document.getElementById('abYear');
  var abInput = document.getElementById('abInput');
  var abRun   = document.getElementById('abRun');
  var abClear = document.getElementById('abClear');
  var abResult= document.getElementById('abResult');

  var MONTHS_SHORT = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  var MONTHS_LONG  = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  var now   = new Date();
  var curYM = now.getFullYear() * 12 + now.getMonth();

  var DATA = null; // contact_name → { ym → summe }

  function fmtEur(n)  { return Math.round(n).toLocaleString('de-DE') + ' €'; }
  function fmtEur2(n) { return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; }
  function norm(s)    { return (s || '').trim().toLowerCase(); }
  function escHtml(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function excludeKeywords() {
    var user = (localStorage.getItem('revenueExcludeKeywords') || '')
      .split('\n').map(function (k) { return k.trim().toLowerCase(); }).filter(Boolean);
    return user.concat(['media-budget', 'mediabudget', 'zweckgebundener ausgleich']);
  }
  function isExcluded(name) {
    var n = norm(name);
    return excludeKeywords().some(function (k) { return n.indexOf(k) !== -1; });
  }

  // ── Load ──────────────────────────────────────────────────────────────
  function load() {
    errorEl.innerHTML = '';
    window.db.revenue.allRows().then(function (rows) {
      var byContact = {};
      rows.forEach(function (r) {
        if (!r.contact_name || isExcluded(r.contact_name)) return;
        var ym = r.year * 12 + (r.month - 1);
        if (!byContact[r.contact_name]) byContact[r.contact_name] = {};
        byContact[r.contact_name][ym] = (byContact[r.contact_name][ym] || 0) + (Number(r.total_amount) || 0);
      });
      DATA = byContact;
      loadingEl.classList.add('hidden');
      tabsEl.classList.remove('hidden');
      setTab('matrix');
      render();
      buildAbControls();
    }).catch(function (e) {
      loadingEl.classList.add('hidden');
      errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' +
        (e.message === 'NOT_CONFIGURED'
          ? 'Keine Supabase-Verbindung. Bitte <a href="settings.html">Einstellungen</a> prüfen.'
          : escHtml(e.message)) + '</div>';
    });
  }

  // ── Tabs ──────────────────────────────────────────────────────────────
  function setTab(which) {
    var matrix = which === 'matrix';
    viewMatrix.classList.toggle('hidden', !matrix);
    viewAbgleich.classList.toggle('hidden', matrix);
    tabMatrix.className   = 'btn btn-sm ' + (matrix ? 'btn-primary' : 'btn-secondary');
    tabAbgleich.className = 'btn btn-sm ' + (matrix ? 'btn-secondary' : 'btn-primary');
  }
  tabMatrix.addEventListener('click',   function () { setTab('matrix'); });
  tabAbgleich.addEventListener('click', function () { setTab('abgleich'); });

  // ── Matrix ────────────────────────────────────────────────────────────
  function render() {
    if (!DATA) return;
    var monthsBack = parseInt(monthsEl.value, 10) || 15;
    var cols = [];
    for (var i = monthsBack - 1; i >= 0; i--) cols.push(curYM - i);

    var search = norm(searchEl.value), onlyGaps = onlyGapsEl.checked;

    var rowsData = Object.keys(DATA).map(function (name) {
      var m = DATA[name];
      var cells = cols.map(function (ym) { return { ym: ym, amount: m[ym] || 0 }; });
      var filledIdx = [];
      cells.forEach(function (c, idx) { if (c.amount > 0) filledIdx.push(idx); });
      var gaps = [];
      if (filledIdx.length >= 2) {
        var firstF = filledIdx[0], lastF = filledIdx[filledIdx.length - 1];
        for (var j = firstF + 1; j < lastF; j++) {
          if (cells[j].amount === 0 && cells[j].ym !== curYM) gaps.push(j);
        }
      }
      var windowTotal = cells.reduce(function (s, c) { return s + c.amount; }, 0);
      return { name: name, cells: cells, gaps: gaps, total: windowTotal };
    });

    var withGaps  = rowsData.filter(function (r) { return r.gaps.length > 0; }).length;
    var totalGaps = rowsData.reduce(function (s, r) { return s + r.gaps.length; }, 0);
    summaryEl.textContent = rowsData.length + ' Kunden · ' + monthsBack + ' Monate · ' +
      withGaps + ' Kunden mit Lücke (' + totalGaps + ' Zellen markiert)';

    var filtered = rowsData.filter(function (r) {
      if (search && norm(r.name).indexOf(search) === -1) return false;
      if (onlyGaps && r.gaps.length === 0) return false;
      return true;
    });
    filtered.sort(function (a, b) {
      if (b.gaps.length !== a.gaps.length) return b.gaps.length - a.gaps.length;
      return b.total - a.total;
    });

    var head = '<tr><th class="name">Kunde</th>';
    cols.forEach(function (ym) {
      var y = Math.floor(ym / 12), mo = ym % 12, isCur = ym === curYM;
      head += '<th class="num' + (isCur ? ' cur' : '') + '">' + MONTHS_SHORT[mo] +
        '<br><span style="font-weight:400">’' + String(y).slice(2) + (isCur ? ' lfd.' : '') + '</span></th>';
    });
    head += '<th class="num">Summe</th></tr>';
    rcHead.innerHTML = head;

    rcBody.innerHTML = filtered.map(function (r) {
      var tds = r.cells.map(function (c, idx) {
        var isCur = c.ym === curYM;
        if (r.gaps.indexOf(idx) !== -1) return '<td class="gap" title="Lücke – Umsatz davor und danach, aber nicht in diesem Monat. Bitte prüfen.">—</td>';
        if (c.amount === 0) return '<td class="empty' + (isCur ? ' cur' : '') + '">·</td>';
        return '<td class="num' + (isCur ? ' cur' : '') + '">' + fmtEur(c.amount) + '</td>';
      }).join('');
      var dot = r.gaps.length ? '<span class="gap-dot"></span>' : '';
      return '<tr><td class="name" title="' + escHtml(r.name) + '">' + dot + escHtml(r.name) + '</td>' +
        tds + '<td class="num" style="font-weight:600">' + fmtEur(r.total) + '</td></tr>';
    }).join('') || '<tr><td class="name">Keine Kunden gefunden.</td></tr>';
  }

  searchEl.addEventListener('input',  render);
  onlyGapsEl.addEventListener('change', render);
  monthsEl.addEventListener('change', render);

  // ── Abgleich (Soll/Ist) ───────────────────────────────────────────────
  function buildAbControls() {
    MONTHS_LONG.forEach(function (name, i) {
      var o = document.createElement('option'); o.value = i + 1; o.textContent = name; abMonth.appendChild(o);
    });
    var y = now.getFullYear();
    for (var yy = y - 2; yy <= y; yy++) { var o = document.createElement('option'); o.value = yy; o.textContent = yy; abYear.appendChild(o); }
    // default: previous month (the one you usually reconcile)
    var prev = curYM - 1;
    abMonth.value = (prev % 12) + 1;
    abYear.value  = Math.floor(prev / 12);
  }

  function germanNum(s) { return parseFloat(String(s).replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.')) || 0; }

  function parseSollLine(line) {
    line = line.replace(/\s+$/, '').replace(/^\s+/, '');
    if (!line) return null;
    var m;
    // "2.500   EVIA GmbH"  (Betrag zuerst)
    m = line.match(/^([0-9][0-9.\s]*(?:,[0-9]+)?)\s*€?\s+(.+)$/);
    if (m && /[a-zA-ZäöüÄÖÜß]/.test(m[2])) return { soll: germanNum(m[1]), name: m[2].replace(/€/g, '').trim() };
    // "EVIA GmbH   2.500"  (Betrag am Ende)
    m = line.match(/^(.+?)\s+€?\s*([0-9][0-9.]*(?:,[0-9]+)?)\s*€?$/);
    if (m && /[a-zA-ZäöüÄÖÜß]/.test(m[1])) return { soll: germanNum(m[2]), name: m[1].trim() };
    // Nur Name, kein Betrag
    return { soll: null, name: line.replace(/€/g, '').trim() };
  }

  var LEGAL = /\b(gmbh|mbh|ag|kg|kgaa|ohg|ug|co|ek|e\.k|ltd|limited|inc|llc|sarl|bv|sp|z|o\.o|haftungsbeschränkt|und|the|for|cats|gbr)\b/g;
  function normMatch(s) {
    return (s || '').toLowerCase()
      .replace(/[äöü]/g, function (c) { return { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue' }[c]; })
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(LEGAL, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function toks(s) { return normMatch(s).split(' ').filter(function (t) { return t.length >= 2; }); }
  function tokMatch(x, y) {
    if (x === y) return true;
    var sh = x.length <= y.length ? x : y, lo = x.length <= y.length ? y : x;
    return sh.length >= 4 && lo.indexOf(sh) === 0; // ein Token ist Präfix des anderen
  }
  function similarity(a, b) {
    var na = normMatch(a), nb = normMatch(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    if (na.length >= 4 && (na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1)) return 0.9;
    var s2 = na.replace(/ /g, ''), t2 = nb.replace(/ /g, '');
    if ((s2.length >= 3 && t2.indexOf(s2) === 0) || (t2.length >= 3 && s2.indexOf(t2) === 0)) return 0.85;
    var ta = toks(a), tb = toks(b);
    if (!ta.length || !tb.length) return 0;
    var inter = 0;
    ta.forEach(function (t) { if (tb.some(function (u) { return tokMatch(t, u); })) inter++; });
    if (inter === 0) return 0;
    var firstBoost = (ta[0] === tb[0] && ta[0].length >= 3) ? 0.2 : 0;
    return Math.min(0.95, inter / Math.max(ta.length, tb.length) + firstBoost);
  }

  function runAbgleich() {
    if (!DATA) return;
    var ym = parseInt(abYear.value, 10) * 12 + (parseInt(abMonth.value, 10) - 1);
    var monLabel = MONTHS_LONG[parseInt(abMonth.value, 10) - 1] + ' ' + abYear.value;

    // Soll-Liste parsen
    var soll = abInput.value.split('\n').map(parseSollLine).filter(function (x) { return x && x.name; });
    if (!soll.length) { abResult.innerHTML = '<div class="muted">Bitte oben eine Soll-Liste einfügen.</div>'; return; }

    // Ist (LexOffice) für den Monat
    var ist = []; // {name, amount}
    Object.keys(DATA).forEach(function (name) {
      var a = DATA[name][ym] || 0;
      if (a > 0) ist.push({ name: name, amount: a });
    });

    // Greedy-Matching: beste Paare zuerst
    var pairs = [];
    soll.forEach(function (s, si) {
      ist.forEach(function (it, ii) {
        var sc = similarity(s.name, it.name);
        if (sc >= 0.5) pairs.push({ si: si, ii: ii, sc: sc });
      });
    });
    pairs.sort(function (a, b) { return b.sc - a.sc; });
    var sollMatch = {}, istUsed = {};
    pairs.forEach(function (p) {
      if (sollMatch[p.si] === undefined && !istUsed[p.ii]) { sollMatch[p.si] = p.ii; istUsed[p.ii] = true; }
    });

    var TOL = 1;
    var rows = soll.map(function (s, si) {
      var mi = sollMatch[si];
      if (mi === undefined) return { s: s, status: 'miss', istName: null, istAmount: 0, diff: (s.soll || 0) ? -(s.soll) : 0 };
      var it = ist[mi];
      var diff = (s.soll != null) ? (it.amount - s.soll) : null;
      var status = (s.soll == null) ? 'ok' : (Math.abs(diff) <= TOL ? 'ok' : 'warn');
      return { s: s, status: status, istName: it.name, istAmount: it.amount, diff: diff };
    });

    var extra = ist.filter(function (it, ii) { return !istUsed[ii]; })
                   .sort(function (a, b) { return b.amount - a.amount; });

    // KPIs
    var nOk   = rows.filter(function (r) { return r.status === 'ok'; }).length;
    var nWarn = rows.filter(function (r) { return r.status === 'warn'; }).length;
    var nMiss = rows.filter(function (r) { return r.status === 'miss'; }).length;
    var sollSum = soll.reduce(function (s, x) { return s + (x.soll || 0); }, 0);
    var istSum  = ist.reduce(function (s, x) { return s + x.amount; }, 0);

    var html = '';
    html += '<div class="ab-kpi">' +
      kpi('Soll-Summe', fmtEur(sollSum)) +
      kpi('Ist in LexOffice', fmtEur(istSum)) +
      kpi('✓ Abgerechnet & passt', nOk) +
      kpi('⚠️ Betrag weicht ab', nWarn) +
      kpi('❌ Nicht abgerechnet', nMiss) +
      '</div>';

    // Soll-Tabelle
    html += '<div class="ab-card" style="margin-bottom:16px;padding:0;overflow:hidden">';
    html += '<table class="ab"><thead><tr><th>Status</th><th>Soll-Kunde</th><th class="num">Soll</th><th>LexOffice-Kontakt</th><th class="num">Ist</th><th class="num">Differenz</th></tr></thead><tbody>';
    // sort: miss first, then warn, then ok
    var order = { miss: 0, warn: 1, ok: 2 };
    rows.sort(function (a, b) { return order[a.status] - order[b.status]; });
    rows.forEach(function (r) {
      var st = r.status === 'ok' ? '<span class="st st-ok">✓ passt</span>'
             : r.status === 'warn' ? '<span class="st st-warn">⚠️ Betrag</span>'
             : '<span class="st st-miss">❌ fehlt</span>';
      html += '<tr>' +
        '<td>' + st + '</td>' +
        '<td>' + escHtml(r.s.name) + '</td>' +
        '<td class="num">' + (r.s.soll != null ? fmtEur2(r.s.soll) : '<span class="muted">—</span>') + '</td>' +
        '<td>' + (r.istName ? escHtml(r.istName) : '<span class="muted">—</span>') + '</td>' +
        '<td class="num">' + (r.istName ? fmtEur2(r.istAmount) : '<span class="muted">—</span>') + '</td>' +
        '<td class="num">' + (r.diff != null && r.istName ? (r.diff > 0 ? '+' : '') + fmtEur2(r.diff) : '<span class="muted">—</span>') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';

    // Extra (in LexOffice, nicht auf Liste)
    html += '<div style="font-size:13px;font-weight:600;margin:6px 0 8px">In LexOffice abgerechnet, aber nicht auf deiner Liste (' + extra.length + ')</div>';
    if (extra.length) {
      html += '<div class="ab-card" style="padding:0;overflow:hidden"><table class="ab"><thead><tr><th>Status</th><th>LexOffice-Kontakt</th><th class="num">Ist</th></tr></thead><tbody>';
      extra.forEach(function (it) {
        html += '<tr><td><span class="st st-extra">＋ extra</span></td><td>' + escHtml(it.name) + '</td><td class="num">' + fmtEur2(it.amount) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<div class="muted" style="font-size:13px">Nichts — alles in LexOffice ist deiner Liste zugeordnet.</div>';
    }

    html = '<div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">Abgleich für <strong>' + monLabel + '</strong> · ' + soll.length + ' Soll-Positionen vs ' + ist.length + ' LexOffice-Kontakte. Namen werden automatisch zugeordnet (Tippfehler/andere Firmennamen können einzeln daneben liegen — dann steht der Kunde unter „fehlt" und der echte Kontakt unter „extra").</div>' + html;

    abResult.innerHTML = html;
  }

  function kpi(label, val) {
    return '<div class="box"><div class="l">' + label + '</div><div class="v">' + val + '</div></div>';
  }

  abRun.addEventListener('click', runAbgleich);
  abClear.addEventListener('click', function () { abInput.value = ''; abResult.innerHTML = ''; });

  load();
})();
