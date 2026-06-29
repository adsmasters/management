(function () {
  'use strict';

  var loadingEl  = document.getElementById('loading');
  var contentEl  = document.getElementById('content');
  var errorEl    = document.getElementById('error');
  var rcHead     = document.getElementById('rcHead');
  var rcBody     = document.getElementById('rcBody');
  var searchEl   = document.getElementById('search');
  var onlyGapsEl = document.getElementById('onlyGaps');
  var monthsEl   = document.getElementById('monthsBack');
  var summaryEl  = document.getElementById('rcSummary');

  var MONTHS_SHORT = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  var now   = new Date();
  var curYM = now.getFullYear() * 12 + now.getMonth(); // index of current (incomplete) month

  var DATA = null; // contact_name → { ym → summe }

  function fmtEur(n) { return Math.round(n).toLocaleString('de-DE') + ' €'; }
  function norm(s)   { return (s || '').trim().toLowerCase(); }
  function escHtml(s){ return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // Pass-through/Werbekosten ausblenden (werden beim Sync ohnehin ausgeschlossen,
  // hier nur zur Sicherheit + User-Stichwörter aus den Einstellungen).
  function excludeKeywords() {
    var user = (localStorage.getItem('revenueExcludeKeywords') || '')
      .split('\n').map(function (k) { return k.trim().toLowerCase(); }).filter(Boolean);
    return user.concat(['media-budget', 'mediabudget', 'zweckgebundener ausgleich']);
  }
  function isExcluded(name) {
    var n = norm(name);
    return excludeKeywords().some(function (k) { return n.indexOf(k) !== -1; });
  }

  function load() {
    errorEl.innerHTML = '';
    loadingEl.classList.remove('hidden');
    contentEl.classList.add('hidden');

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
      contentEl.classList.remove('hidden');
      render();
    }).catch(function (e) {
      loadingEl.classList.add('hidden');
      errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' +
        (e.message === 'NOT_CONFIGURED'
          ? 'Keine Supabase-Verbindung. Bitte <a href="settings.html">Einstellungen</a> prüfen.'
          : escHtml(e.message)) + '</div>';
    });
  }

  function render() {
    if (!DATA) return;
    var monthsBack = parseInt(monthsEl.value, 10) || 15;

    // Spalten: die letzten N Monate bis einschließlich aktueller Monat
    var cols = [];
    for (var i = monthsBack - 1; i >= 0; i--) cols.push(curYM - i);

    var search   = norm(searchEl.value);
    var onlyGaps = onlyGapsEl.checked;

    var rowsData = Object.keys(DATA).map(function (name) {
      var m = DATA[name];
      var cells = cols.map(function (ym) { return { ym: ym, amount: m[ym] || 0 }; });

      // Interne Lücke = leere Zelle, die im sichtbaren Fenster sowohl einen gefüllten
      // Monat DAVOR als auch DANACH hat. Der laufende Monat zählt nie als Lücke.
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

    // Kennzahlen über ALLE Kunden (vor Filter)
    var withGaps  = rowsData.filter(function (r) { return r.gaps.length > 0; }).length;
    var totalGaps = rowsData.reduce(function (s, r) { return s + r.gaps.length; }, 0);
    summaryEl.textContent = rowsData.length + ' Kunden · ' + monthsBack + ' Monate · ' +
      withGaps + ' Kunden mit Lücke (' + totalGaps + ' Zellen markiert)';

    // Filter
    var filtered = rowsData.filter(function (r) {
      if (search && norm(r.name).indexOf(search) === -1) return false;
      if (onlyGaps && r.gaps.length === 0) return false;
      return true;
    });

    // Sortierung: Kunden mit Lücken zuerst, dann nach Umsatz
    filtered.sort(function (a, b) {
      if (b.gaps.length !== a.gaps.length) return b.gaps.length - a.gaps.length;
      return b.total - a.total;
    });

    // Kopfzeile
    var head = '<tr><th class="name">Kunde</th>';
    cols.forEach(function (ym) {
      var y = Math.floor(ym / 12), mo = ym % 12, isCur = ym === curYM;
      head += '<th class="num' + (isCur ? ' cur' : '') + '">' + MONTHS_SHORT[mo] +
        '<br><span style="font-weight:400">’' + String(y).slice(2) + (isCur ? ' lfd.' : '') + '</span></th>';
    });
    head += '<th class="num">Summe</th></tr>';
    rcHead.innerHTML = head;

    // Zeilen
    rcBody.innerHTML = filtered.map(function (r) {
      var tds = r.cells.map(function (c, idx) {
        var isCur = c.ym === curYM;
        if (r.gaps.indexOf(idx) !== -1) {
          return '<td class="gap" title="Lücke – Umsatz davor und danach, aber nicht in diesem Monat. Bitte prüfen.">—</td>';
        }
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

  load();
})();
