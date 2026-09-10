(function () {
  'use strict';

  var addEntryBtn    = document.getElementById('addEntryBtn');
  var loadingEl      = document.getElementById('loading');
  var contentEl      = document.getElementById('content');
  var errorEl        = document.getElementById('error');
  var emptyState     = document.getElementById('emptyState');
  var acqBody        = document.getElementById('acqBody');

  var acqModal       = document.getElementById('acqModal');
  var acqModalTitle  = document.getElementById('acqModalTitle');
  var acqSourceInput = document.getElementById('acqSourceInput');
  var acqTypeSelect  = document.getElementById('acqTypeSelect');
  var acqAmountInput = document.getElementById('acqAmountInput');
  var acqDateInput   = document.getElementById('acqDateInput');
  var acqNotesInput  = document.getElementById('acqNotesInput');
  var acqModalClose  = document.getElementById('acqModalClose');
  var acqModalCancel = document.getElementById('acqModalCancel');
  var acqModalSave   = document.getElementById('acqModalSave');

  var deleteModal        = document.getElementById('deleteModal');
  var deleteEntryName    = document.getElementById('deleteEntryName');
  var deleteModalClose   = document.getElementById('deleteModalClose');
  var deleteModalCancel  = document.getElementById('deleteModalCancel');
  var deleteModalConfirm = document.getElementById('deleteModalConfirm');

  var assignModal       = document.getElementById('assignModal');
  var assignModalSource = document.getElementById('assignModalSource');
  var assignSearch      = document.getElementById('assignSearch');
  var assignClientList  = document.getElementById('assignClientList');
  var assignModalClose  = document.getElementById('assignModalClose');
  var assignModalCancel = document.getElementById('assignModalCancel');
  var assignModalSave   = document.getElementById('assignModalSave');

  var detailModal      = document.getElementById('detailModal');
  var detailModalTitle = document.getElementById('detailModalTitle');
  var detailModalBody  = document.getElementById('detailModalBody');
  var detailModalClose = document.getElementById('detailModalClose');

  var sortCol = null; // 'kosten' | 'umsatz' | 'roi'
  var sortDir = 'desc';

  var editingId      = null;
  var deletingId     = null;
  var assigningCost  = null;
  var selectedSet    = {};   // norm(contactName) → true/false — persists across search re-renders
  var savedLinks     = {};   // norm(contactName) → true — links already saved in DB for current cost
  var allClients     = [];   // sorted contact_name strings from revenue
  var allLinks       = [];   // all acquisition_contact_links rows
  var allOverrides   = [];   // contact_overrides rows (excluded / cat:…)
  var excludedSet    = {};   // norm(contactName) → 1 (kein Agenturkunde)
  var unassigned     = [];   // Kunden mit Umsatz ohne Quelle (aktueller Filter)
  var unassignedAll  = [];   // dito, ohne Zeitraumfilter
  var allCosts       = [];   // alle Akquisitionseinträge (für Zuordnen-Dropdown)
  var unassignedDirty= false;// wurde im Modal etwas zugeordnet?
  var tagSet         = {};   // norm(contactName) → Unterkanal im offenen Zuordnen-Dialog
  var savedTags      = {};   // norm(contactName) → in der DB gespeicherter Unterkanal

  var MONTHS_LABEL = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];

  // ── Laufende Kosten: Monatswerte ─────────────────────────────────────
  // Einmalige Aktivitäten (Messe, Webinar) behalten Betrag + Datum. Laufende
  // Kanäle (SEO, YouTube, Ads) werden pro Monat erfasst; der Gesamtbetrag in
  // acquisition_costs.amount ist die Summe daraus – so rechnen ROI-, Typ- und
  // CAC-Auswertung unverändert weiter, und man sieht trotzdem, bis wann
  // erfasst wurde.
  var monthsByCost    = {};    // costId → { 'YYYY-MM': { id, amount, auto, manual } }
  var monthsAvailable = true;  // false, solange die Migration nicht gelaufen ist

  // Kosten aus der Kostenanalyse: pro Eintrag Regeln auf den Buchungstext,
  // daraus je Monat die Summe der Nettobeträge.
  var rulesByCost   = {};      // costId → [ {id, pattern, label, match_type} ]
  var allTx         = [];      // cost_transactions (Roh)
  var vendorList    = [];      // [{ name, total, count }] – für die Vorschlagsliste
  var rulesAvailable = true;   // false, solange die Regel-Migration fehlt

  function txNet(t) {
    var v = t.amount_net != null ? t.amount_net : t.amount_gross;
    return Math.round((Number(v) || 0) * 100) / 100;
  }

  function txHaystack(t) {
    return ((t.payee || '') + ' ' + (t.description || '')).toLowerCase();
  }

  function txMatchesRule(t, rule) {
    var pat = (rule.pattern || '').trim().toLowerCase();
    if (!pat) return false;
    if (rule.match_type === 'category') {
      return (t.category || '').trim().toLowerCase() === pat;
    }
    if (rule.match_type === 'equals') {
      return (window.suggestVendorPattern(t.payee || t.description) || '').toLowerCase() === pat;
    }
    return txHaystack(t).indexOf(pat) !== -1;
  }

  function ruleLabel(rule) {
    return rule.match_type === 'category' ? 'Kategorie: ' + rule.pattern : rule.pattern;
  }

  // Ausgeschlossene Buchungen zählen auch hier nicht – sonst widerspricht die
  // Akquisition der Kostenanalyse.
  function matchingTx(rules) {
    if (!rules || !rules.length) return [];
    return allTx.filter(function (t) {
      if (t.excluded) return false;
      return rules.some(function (r) { return txMatchesRule(t, r); });
    });
  }

  function autoMonthsFor(rules) {
    var out = {};
    matchingTx(rules).forEach(function (t) {
      var ym = t.year + '-' + pad2(t.month);
      out[ym] = Math.round(((out[ym] || 0) + txNet(t)) * 100) / 100;
    });
    return out;
  }

  var categoryList = [];   // Kategorien aus der Kostenanalyse

  function buildCategoryList() {
    var seen = {};
    allTx.forEach(function (t) {
      var c = (t.category || '').trim();
      if (c) seen[c] = (seen[c] || 0) + 1;
    });
    categoryList = Object.keys(seen).sort(function (a, b) { return a.localeCompare(b, 'de'); });
  }

  function buildVendorList() {
    var byName = {};
    allTx.forEach(function (t) {
      if (t.excluded) return;
      var name = window.suggestVendorPattern(t.payee || t.description) || '(unbekannt)';
      if (!byName[name]) byName[name] = { name: name, total: 0, count: 0 };
      byName[name].total += txNet(t);
      byName[name].count += 1;
    });
    vendorList = Object.keys(byName).map(function (k) { return byName[k]; })
      .sort(function (a, b) { return b.total - a.total; });

    var dl = document.getElementById('vendorOptions');
    if (dl) {
      dl.innerHTML = vendorList.slice(0, 300).map(function (v) {
        return '<option value="' + escHtml(v.name) + '">' + escHtml(fmt(v.total) + ' · ' + v.count + ' Buchungen') + '</option>';
      }).join('');
    }
    var dlc = document.getElementById('categoryOptions');
    if (dlc) {
      dlc.innerHTML = categoryList.map(function (c) { return '<option value="' + escHtml(c) + '">'; }).join('');
    }
  }

  function pad2(n)     { return (n < 10 ? '0' : '') + n; }
  function ymIdx(ym)   { return parseInt(ym.slice(0, 4), 10) * 12 + parseInt(ym.slice(5, 7), 10) - 1; }
  function ymText(ym)  { return MONTHS_LABEL[parseInt(ym.slice(5, 7), 10) - 1] + ' ' + ym.slice(0, 4); }

  // Letzter abgeschlossener Monat – bis hierhin sollte erfasst sein.
  function dueYm() {
    var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  function monthsOf(costId) { return monthsByCost[costId] || {}; }

  function monthYms(costId) {
    var m = monthsOf(costId);
    return Object.keys(m).filter(function (k) { return (m[k].amount || 0) !== 0; }).sort();
  }

  function lastRecordedYm(costId) {
    var l = monthYms(costId);
    return l.length ? l[l.length - 1] : null;
  }

  function hasMonths(cost) { return monthYms(cost.id).length > 0; }

  // Jahr, für das ein laufender Eintrag geführt wird.
  function entryYear(cost) {
    if (cost.cost_date) return parseInt(cost.cost_date.slice(0, 4), 10);
    var last = lastRecordedYm(cost.id);
    return last ? parseInt(last.slice(0, 4), 10) : new Date().getFullYear();
  }

  // Status eines laufenden Eintrags. Gemahnt wird nur das laufende Jahr –
  // ein abgeschlossenes Vorjahr bekommt keine neuen Monate mehr.
  function recurringStatus(cost) {
    // Ohne Monatstabelle (Migration nicht gelaufen) verhält sich alles wie bisher.
    if (!cost.is_recurring || !monthsAvailable) return null;
    var last = lastRecordedYm(cost.id);
    if (entryYear(cost) < new Date().getFullYear()) return { state: 'done', last: last, missing: 0 };
    if (!last) return { state: 'none', last: null, missing: 0 };
    var due = dueYm();
    if (ymIdx(last) >= ymIdx(due)) return { state: 'ok', last: last, missing: 0 };
    return { state: 'open', last: last, missing: ymIdx(due) - ymIdx(last) };
  }

  // Betrag im aktiven Zeitraum. Ein laufender Eintrag zählt nur mit den
  // Monaten, die im Filter liegen – sonst schlüge der ganze Jahresbetrag in
  // einem Monatsfilter durch.
  function costAmt(cost) {
    var from = filterFrom.value, to = filterTo.value;
    if (!(from || to) || !hasMonths(cost)) return cost.amount || 0;
    var f = from ? from.slice(0, 7) : null;
    var t = to   ? to.slice(0, 7)   : null;
    var m = monthsOf(cost.id), sum = 0;
    Object.keys(m).forEach(function (k) {
      if (f && ymIdx(k) < ymIdx(f)) return;
      if (t && ymIdx(k) > ymIdx(t)) return;
      sum += (m[k].amount || 0);
    });
    return sum;
  }

  // Unterkanal = feinere Herkunft innerhalb einer Quelle. Ein Kostenblock wie
  // „Google Organic & KI" lässt sich damit auswerten, ohne die Kosten künstlich
  // aufzuteilen. Freitext – die Liste ist nur Vorschlag und wird um alle bereits
  // vergebenen Werte ergänzt.
  var TAG_SUGGESTIONS = ['Google organisch', 'ChatGPT', 'Perplexity', 'Claude', 'Gemini', 'Copilot', 'Sonstige KI'];

  function knownTags() {
    var seen = {}, out = [];
    TAG_SUGGESTIONS.forEach(function (t) { seen[t.toLowerCase()] = 1; out.push(t); });
    allLinks.forEach(function (l) {
      var t = (l.tag || '').trim();
      if (t && !seen[t.toLowerCase()]) { seen[t.toLowerCase()] = 1; out.push(t); }
    });
    return out.sort(function (a, b) { return a.localeCompare(b, 'de'); });
  }

  function refreshTagOptions() {
    var dl = document.getElementById('tagOptions');
    if (!dl) return;
    dl.innerHTML = knownTags().map(function (t) { return '<option value="' + escHtml(t) + '">'; }).join('');
  }

  function makeTagInput(value, placeholder) {
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.setAttribute('list', 'tagOptions');
    inp.value = value || '';
    inp.placeholder = placeholder || 'Unterkanal';
    inp.autocomplete = 'off';
    inp.style.cssText = 'padding:4px 8px;border:1px solid var(--border);border-radius:var(--radius);font-size:12px;background:var(--surface);color:var(--text);font-family:inherit';
    return inp;
  }

  var TYPE_LABELS = {
    'messe':           'Messe',
    'online-marketing':'Online-Marketing',
    'seo':             'SEO',
    'ki':              'KI-Suche',
    'kaltakquise':     'Kaltakquise',
    'empfehlung':      'Empfehlung',
    'sonstige':        'Sonstige',
  };

  function fmt(n) {
    return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }

  function showError(msg) {
    errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' + msg + '</div>';
  }

  function norm(str) { return (str || '').trim().toLowerCase(); }

  function escHtml(str) {
    return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Date filter ──────────────────────────────────────────────────────
  var filterFrom  = document.getElementById('filterFrom');
  var filterTo    = document.getElementById('filterTo');
  var filterApply = document.getElementById('filterApply');
  var filterReset = document.getElementById('filterReset');

  function applyDateFilter(costs) {
    var from = filterFrom.value;
    var to   = filterTo.value;
    if (!from && !to) return costs;
    var f = from ? from.slice(0, 7) : null;
    var t = to   ? to.slice(0, 7)   : null;
    return costs.filter(function(c) {
      // Laufende Einträge: drin, wenn irgendein erfasster Monat im Zeitraum liegt.
      if (hasMonths(c)) {
        return monthYms(c.id).some(function (k) {
          if (f && ymIdx(k) < ymIdx(f)) return false;
          if (t && ymIdx(k) > ymIdx(t)) return false;
          return true;
        });
      }
      var d = c.cost_date || '';
      if (!d) return true; // no date → always show
      if (from && d < from) return false;
      if (to   && d > to)   return false;
      return true;
    });
  }

  // Filter revenue rows (year/month granularity) by the same date range.
  // A revenue month counts if it falls within [from-month, to-month] inclusive.
  function revenueMonthInRange(year, month) {
    var from = filterFrom.value;
    var to   = filterTo.value;
    if (!from && !to) return true;
    var ym = year * 12 + (month - 1);
    if (from) {
      var fy = parseInt(from.slice(0, 4), 10), fm = parseInt(from.slice(5, 7), 10);
      if (ym < fy * 12 + (fm - 1)) return false;
    }
    if (to) {
      var ty = parseInt(to.slice(0, 4), 10), tm = parseInt(to.slice(5, 7), 10);
      if (ym > ty * 12 + (tm - 1)) return false;
    }
    return true;
  }

  function onFilterChange() {
    if (lastRenderArgs) render(lastRenderArgs[0], lastRenderArgs[1], lastRenderArgs[2]);
  }

  filterApply.addEventListener('click', onFilterChange);
  filterReset.addEventListener('click', function() {
    filterFrom.value = '';
    filterTo.value   = '';
    onFilterChange();
  });

  // ── View toggle ──────────────────────────────────────────────────────
  var currentView = 'all';
  var VIEWS = {
    'all':  { btn: document.getElementById('viewAll'),  panel: document.getElementById('viewAllPanel')  },
    'type': { btn: document.getElementById('viewType'), panel: document.getElementById('viewTypePanel') },
    'tag':  { btn: document.getElementById('viewTag'),  panel: document.getElementById('viewTagPanel')  },
  };

  function setView(v) {
    currentView = v;
    Object.keys(VIEWS).forEach(function (k) {
      var view = VIEWS[k];
      if (!view.btn || !view.panel) return;
      view.panel.classList.toggle('hidden', k !== v);
      view.btn.className = 'btn btn-sm ' + (k === v ? 'btn-primary' : 'btn-secondary');
    });
  }

  Object.keys(VIEWS).forEach(function (k) {
    if (VIEWS[k].btn) VIEWS[k].btn.addEventListener('click', function () { setView(k); });
  });

  // ── Sort ─────────────────────────────────────────────────────────────
  var lastRenderArgs = null;

  function updateSortIcons() {
    ['kosten','umsatz','roi'].forEach(function(col) {
      var el = document.getElementById('sort' + col.charAt(0).toUpperCase() + col.slice(1) + 'Icon');
      if (!el) return;
      if (sortCol === col) {
        el.textContent = sortDir === 'desc' ? '↓' : '↑';
        el.style.color = 'var(--primary)';
      } else {
        el.textContent = '↕';
        el.style.color = 'var(--text-secondary)';
      }
    });
  }

  function bindSortHeader(id, col) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', function() {
      if (sortCol === col) {
        sortDir = sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        sortCol = col;
        sortDir = 'desc';
      }
      updateSortIcons();
      if (lastRenderArgs) render(lastRenderArgs[0], lastRenderArgs[1], lastRenderArgs[2]);
    });
  }

  bindSortHeader('sortKosten', 'kosten');
  bindSortHeader('sortUmsatz', 'umsatz');
  bindSortHeader('sortRoi',    'roi');
  updateSortIcons();

  // ── Add/Edit Modal ────────────────────────────────────────────────────
  var acqRecurringCheck = document.getElementById('acqRecurringCheck');
  var acqMonthsWrap     = document.getElementById('acqMonthsWrap');
  var acqMonthsGrid     = document.getElementById('acqMonthsGrid');
  var acqMonthsSum      = document.getElementById('acqMonthsSum');
  var acqMonthsHint     = document.getElementById('acqMonthsHint');
  var acqYearSelect     = document.getElementById('acqYearSelect');
  var acqDateField      = document.getElementById('acqDateField');
  var acqLastChange     = document.getElementById('acqLastChange');

  var acqRulesWrap  = document.getElementById('acqRulesWrap');
  var acqRulesList  = document.getElementById('acqRulesList');
  var acqRulesSum   = document.getElementById('acqRulesSum');
  var acqRuleInput  = document.getElementById('acqRuleInput');
  var acqRuleAdd    = document.getElementById('acqRuleAdd');
  var acqRuleKind   = document.getElementById('acqRuleKind');

  var monthDraft      = {};  // 'YYYY-MM' → manuell eingetippter Wert
  var autoDraft       = {};  // 'YYYY-MM' → Betrag aus den Bankdaten
  var ruleDraft       = [];  // Regeln des offenen Dialogs (erst beim Speichern in die DB)
  var draftBaseAmount = 0;   // Gesamtbetrag vor der Umstellung auf monatlich

  function recalcAutoDraft() {
    autoDraft = autoMonthsFor(ruleDraft);
  }

  function renderRules() {
    if (!acqRulesList) return;
    acqRulesWrap.classList.toggle('hidden', !(acqRecurringCheck.checked && monthsAvailable && rulesAvailable));

    if (!ruleDraft.length) {
      acqRulesList.innerHTML = '<div style="font-size:12px;color:var(--text-secondary);padding:2px 0 4px">' +
        'Noch keine Quelle zugeordnet – die Monate füllst du dann von Hand.</div>';
    } else {
      acqRulesList.innerHTML = '';
      var gridYear = parseInt(acqYearSelect.value, 10);
      ruleDraft.forEach(function (rule, idx) {
        var all  = matchingTx([rule]);
        // Gezählt wird das Jahr des Eintrags – Buchungen anderer Jahre gehören
        // in den jeweiligen Jahreseintrag.
        var hits = all.filter(function (t) { return t.year === gridYear; });
        var sum  = hits.reduce(function (a, t) { return a + txNet(t); }, 0);
        var other = all.length - hits.length;

        var row = document.createElement('div');
        row.className = 'rule-row' + (hits.length ? '' : ' no-hits');
        row.innerHTML =
          '<span class="rule-pattern">' + escHtml(ruleLabel(rule)) + '</span>' +
          '<span class="rule-hits"' +
            (other ? ' title="' + other + ' weitere Buchung' + (other === 1 ? '' : 'en') + ' in anderen Jahren"' : '') +
            '>' + (hits.length
              ? hits.length + (hits.length === 1 ? ' Buchung · ' : ' Buchungen · ') + fmt(sum)
              : 'kein Treffer ' + gridYear) + '</span>';

        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'rule-del';
        del.title = 'Quelle entfernen';
        del.textContent = '✕';
        del.addEventListener('click', function () {
          ruleDraft.splice(idx, 1);
          recalcAutoDraft();
          renderRules();
          renderMonthGrid();
        });
        row.appendChild(del);
        acqRulesList.appendChild(row);
      });
    }

    var year = parseInt(acqYearSelect.value, 10);
    var yearSum = 0;
    Object.keys(autoDraft).forEach(function (ym) {
      if (parseInt(ym.slice(0, 4), 10) === year) yearSum += autoDraft[ym];
    });
    acqRulesSum.textContent = ruleDraft.length ? 'aus Konto ' + year + ': ' + fmt(yearSum) : '';
  }

  function syncRuleKindUi() {
    var isCat = acqRuleKind && acqRuleKind.value === 'category';
    acqRuleInput.setAttribute('list', isCat ? 'categoryOptions' : 'vendorOptions');
    acqRuleInput.placeholder = isCat
      ? 'Kategorie wählen, z. B. Marketing'
      : 'Lieferant wählen oder Suchbegriff, z. B. Fotografie';
  }

  function addRuleFromInput() {
    var val  = (acqRuleInput.value || '').trim();
    var kind = acqRuleKind ? acqRuleKind.value : 'contains';
    if (!val) { acqRuleInput.focus(); return; }
    var exists = ruleDraft.some(function (r) {
      return r.pattern.toLowerCase() === val.toLowerCase() && r.match_type === kind;
    });
    if (exists) { acqRuleInput.value = ''; return; }
    ruleDraft.push({ id: null, pattern: val, label: val, match_type: kind });
    acqRuleInput.value = '';
    recalcAutoDraft();
    renderRules();
    renderMonthGrid();
  }

  if (acqRuleKind)  acqRuleKind.addEventListener('change', syncRuleKindUi);
  if (acqRuleAdd)   acqRuleAdd.addEventListener('click', addRuleFromInput);
  if (acqRuleInput) acqRuleInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addRuleFromInput(); }
  });

  // Automatik gilt nur für das Jahr, für das der Eintrag geführt wird –
  // "Backlinked" bucht auch 2025, das gehört aber in den 2025er Eintrag.
  function autoOfYear(year) {
    var out = {};
    Object.keys(autoDraft).forEach(function (ym) {
      if (parseInt(ym.slice(0, 4), 10) === year) out[ym] = autoDraft[ym];
    });
    return out;
  }

  function draftSum() {
    var year = parseInt(acqYearSelect.value, 10);
    var sum = 0;
    Object.keys(monthDraft).forEach(function (k) { sum += parseFloat(monthDraft[k]) || 0; });
    var auto = autoOfYear(year);
    Object.keys(auto).forEach(function (k) { sum += auto[k]; });
    return Math.round(sum * 100) / 100;
  }

  function fillYearSelect(year) {
    var now = new Date().getFullYear(), years = [], y;
    for (y = now + 1; y >= now - 5; y--) years.push(y);
    if (years.indexOf(year) === -1) { years.push(year); years.sort(function (a, b) { return b - a; }); }
    acqYearSelect.innerHTML = years.map(function (yy) { return '<option value="' + yy + '">' + yy + '</option>'; }).join('');
    acqYearSelect.value = String(year);
  }

  function renderMonthGrid() {
    var year = parseInt(acqYearSelect.value, 10);
    var due  = dueYm();
    acqMonthsGrid.innerHTML = '';
    for (var i = 0; i < 12; i++) {
      (function (idx) {
        var ym     = year + '-' + pad2(idx + 1);
        var auto   = autoDraft[ym] || 0;
        var filled = (monthDraft[ym] != null && monthDraft[ym] !== '') || auto > 0;
        var future = ymIdx(ym) > ymIdx(due);
        var cell   = document.createElement('div');
        cell.className = 'month-cell' + (future ? ' is-future' : (filled ? '' : ' is-open'));

        var lab = document.createElement('label');
        lab.textContent = MONTHS_LABEL[idx];
        lab.setAttribute('for', 'acqMonth_' + ym);

        var inp = document.createElement('input');
        inp.type = 'number'; inp.min = '0'; inp.step = '0.01';
        inp.id = 'acqMonth_' + ym;
        inp.placeholder = auto > 0 ? '+ manuell' : '—';
        inp.title = auto > 0 ? 'Zusatzkosten, die nicht über Konto/Karte laufen' : '';
        inp.value = (monthDraft[ym] != null && monthDraft[ym] !== '') ? monthDraft[ym] : '';
        inp.addEventListener('input', function () {
          var v = this.value.trim();
          if (v === '') delete monthDraft[ym]; else monthDraft[ym] = v;
          cell.classList.toggle('is-open', v === '' && !(autoDraft[ym] > 0) && !future);
          updateMonthSum();
        });

        // Herkunft sichtbar machen: was aus den Bankdaten kommt, steht darunter.
        var note = document.createElement('div');
        note.className = 'month-auto';
        note.innerHTML = auto > 0 ? '<strong>' + fmt(auto) + '</strong> Konto' : '';
        note.title = auto > 0 ? 'Aus der Kostenanalyse übernommen' : '';

        cell.appendChild(lab);
        cell.appendChild(inp);
        cell.appendChild(note);
        acqMonthsGrid.appendChild(cell);
      })(i);
    }
    updateMonthSum();
  }

  function updateMonthSum() {
    var sum = draftSum();
    acqMonthsSum.textContent = fmt(sum);
    acqAmountInput.value = sum ? sum : '';

    var year = parseInt(acqYearSelect.value, 10);
    var due  = dueYm();
    var missing = [], filled = [];
    for (var i = 0; i < 12; i++) {
      var ym = year + '-' + pad2(i + 1);
      var has = (monthDraft[ym] != null && monthDraft[ym] !== '') || (autoDraft[ym] || 0) > 0;
      if (has) filled.push(ym);
      else if (ymIdx(ym) <= ymIdx(due)) missing.push(ym);
    }

    var html = '';
    if (draftBaseAmount > 0 && filled.length === 0) {
      html += '<div style="color:#92400e">Bisher nur als Gesamtbetrag erfasst: <strong>' + fmt(draftBaseAmount) +
              '</strong>. Sobald Monatswerte drinstehen, ersetzt deren Summe diesen Betrag.</div>';
    }
    if (missing.length) {
      html += '<div style="margin-top:4px">Noch nicht erfasst: <strong>' + missing.map(ymText).join(', ') + '</strong></div>';
    } else if (filled.length) {
      html += '<div style="margin-top:4px;color:#065f46">Alle Monate bis ' + ymText(due) + ' erfasst ✅</div>';
    }
    acqMonthsHint.innerHTML = html;
  }

  // Zeigt im Dialog, wann zuletzt Geld an diesem Eintrag bewegt wurde.
  // Umbenennungen zählen bewusst NICHT – ein geänderter Name („Bis Ende
  // August") sagt nichts darüber, ob der Betrag mitgezogen wurde.
  function renderLastChange(entry) {
    if (!acqLastChange) return;
    acqLastChange.innerHTML = '';
    acqLastChange.classList.add('hidden');
    if (!entry || !historyAvailable) return;

    acqLastChange.classList.remove('hidden');
    acqLastChange.innerHTML = '<span style="color:var(--text-secondary)">Letzte Betragsänderung wird geladen…</span>';

    var forId = entry.id;
    window.db.acquisitionCostHistory.listAmountChanges(forId)
      .then(function (rows) {
        if (editingId !== forId) return;            // Dialog inzwischen gewechselt
        if (!rows.length) { acqLastChange.classList.add('hidden'); return; }

        var last = rows[0];                          // Historie kommt absteigend
        var prev = rows[1];
        acqLastChange.innerHTML =
          '<div class="lc-head">Betrag zuletzt geändert: ' + fmtWhen(last.changed_at) + '</div>' +
          '<div style="margin-top:3px">' + historyText(last) + '</div>' +
          (prev
            ? '<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border);color:var(--text-secondary)">' +
                'Davor: ' + fmtWhen(prev.changed_at) + ' – ' + historyText(prev) +
              '</div>'
            : '') +
          (rows.length > 2
            ? '<div style="margin-top:6px"><button type="button" class="lc-link" id="acqHistLink">Alle ' + rows.length + ' Betragsänderungen</button></div>'
            : '');

        var link = document.getElementById('acqHistLink');
        if (link) link.addEventListener('click', function () { openHistoryModal(entry); });
      })
      .catch(function () { acqLastChange.classList.add('hidden'); });
  }

  function syncRecurringUi() {
    var on = acqRecurringCheck.checked && monthsAvailable;
    acqMonthsWrap.classList.toggle('hidden', !on);
    acqDateField.classList.toggle('hidden', on);
    acqAmountInput.readOnly = on;
    acqAmountInput.title    = on ? 'Wird aus den Monatswerten berechnet' : '';
    acqAmountInput.style.background = on ? 'var(--surface-hover,#f1f5f9)' : '';
    renderRules();
    if (on) renderMonthGrid();
  }

  acqRecurringCheck.addEventListener('change', syncRecurringUi);
  acqYearSelect.addEventListener('change', function () { renderRules(); renderMonthGrid(); });

  function openModal(entry) {
    editingId = entry ? entry.id : null;
    acqModalTitle.textContent = entry ? 'Eintrag bearbeiten' : 'Neuer Eintrag';
    acqSourceInput.value = entry ? (entry.source_name || '') : '';
    acqTypeSelect.value  = entry ? (entry.source_type  || 'sonstige') : 'sonstige';
    acqAmountInput.value = entry ? (entry.amount != null ? entry.amount : '') : '';
    acqDateInput.value   = entry ? (entry.cost_date || '') : '';
    acqNotesInput.value  = entry ? (entry.notes || '') : '';

    monthDraft      = {};
    ruleDraft       = [];
    draftBaseAmount = entry ? (entry.amount || 0) : 0;
    if (entry) {
      var m = monthsOf(entry.id);
      Object.keys(m).forEach(function (k) {
        // Im Eingabefeld steht nur der manuelle Anteil; der Rest kommt aus der
        // Kostenanalyse und wird daneben angezeigt.
        var man = m[k].manual != null ? m[k].manual : m[k].amount;
        if (Number(man)) monthDraft[k] = String(man);
      });
      (rulesByCost[entry.id] || []).forEach(function (r) {
        ruleDraft.push({ id: r.id, pattern: r.pattern, label: r.label, match_type: r.match_type });
      });
    }
    recalcAutoDraft();
    acqRecurringCheck.checked  = !!(entry && entry.is_recurring);
    acqRecurringCheck.disabled = !monthsAvailable;
    fillYearSelect(entry ? entryYear(entry) : new Date().getFullYear());
    syncRecurringUi();
    renderLastChange(entry);

    acqModal.classList.remove('hidden');
    acqSourceInput.focus();
  }

  function closeModal() { acqModal.classList.add('hidden'); editingId = null; }

  acqModalClose.addEventListener('click',  closeModal);
  acqModalCancel.addEventListener('click', closeModal);
  acqModal.addEventListener('click', function (e) { if (e.target === acqModal) closeModal(); });
  addEntryBtn.addEventListener('click', function () { openModal(null); });

  // Monatszeilen an den Dialog angleichen: geänderte schreiben, leer gewordene
  // löschen. Betroffen ist nur das Jahr des Eintrags – Monate anderer Jahre
  // gehören zu anderen Einträgen und bleiben unangetastet. Wird ein Eintrag auf
  // „einmalig" zurückgestellt, fliegen alle raus.
  function syncMonths(costId, draft, recurring, year) {
    var existing = monthsOf(costId), ops = [];
    if (!recurring) {
      return Object.keys(existing).length
        ? window.db.acquisitionCostMonths.removeAll(costId)
        : Promise.resolve();
    }
    Object.keys(draft).forEach(function (ym) {
      var cur = existing[ym];
      var d   = draft[ym];
      if (!cur || Number(cur.auto) !== d.auto || Number(cur.manual) !== d.manual) {
        ops.push(window.db.acquisitionCostMonths.set(costId, ym, d));
      }
    });
    Object.keys(existing).forEach(function (ym) {
      if (parseInt(ym.slice(0, 4), 10) !== year) return;
      if (!(ym in draft)) ops.push(window.db.acquisitionCostMonths.remove(costId, ym));
    });
    return Promise.all(ops);
  }

  // Regeln des Dialogs mit der DB abgleichen.
  function syncRules(costId, recurring) {
    if (!rulesAvailable) return Promise.resolve();
    var existing = rulesByCost[costId] || [];
    var keep     = recurring ? ruleDraft : [];
    var ops      = [];
    keep.forEach(function (r) {
      if (!r.id) ops.push(window.db.acquisitionCostRules.create(costId, r.pattern, r.label, r.match_type));
    });
    existing.forEach(function (r) {
      var stillThere = keep.some(function (d) { return d.id === r.id; });
      if (!stillThere) ops.push(window.db.acquisitionCostRules.remove(r.id));
    });
    return Promise.all(ops);
  }

  acqModalSave.addEventListener('click', function () {
    var source = acqSourceInput.value.trim();
    if (!source) { acqSourceInput.focus(); acqSourceInput.style.borderColor = 'var(--danger)'; return; }
    acqSourceInput.style.borderColor = '';
    var type      = acqTypeSelect.value;
    var notes     = acqNotesInput.value.trim() || null;
    var recurring = acqRecurringCheck.checked && monthsAvailable;

    // Monatswerte einsammeln – der Gesamtbetrag ist bei laufenden Kosten
    // immer deren Summe, nie ein separat getippter Wert.
    var gridYear = parseInt(acqYearSelect.value, 10);
    var draft = {};   // 'YYYY-MM' → { auto, manual }
    if (recurring) {
      var auto = autoOfYear(gridYear);
      Object.keys(auto).forEach(function (k) {
        draft[k] = { auto: auto[k], manual: 0 };
      });
      Object.keys(monthDraft).forEach(function (k) {
        var v = parseFloat(monthDraft[k]);
        if (isNaN(v) || v === 0) return;
        if (!draft[k]) draft[k] = { auto: 0, manual: 0 };
        draft[k].manual = v;
      });
      Object.keys(draft).forEach(function (k) {
        if (!draft[k].auto && !draft[k].manual) delete draft[k];
      });
    }
    var ymKeys = Object.keys(draft).sort();
    var amount = recurring
      ? Math.round(ymKeys.reduce(function (s, k) { return s + draft[k].auto + draft[k].manual; }, 0) * 100) / 100
      : (parseFloat(acqAmountInput.value) || 0);
    // cost_date bleibt die Jahres-Zuordnung für die CAC-Analyse.
    var date = recurring
      ? (ymKeys.length ? ymKeys[0] + '-01' : gridYear + '-01-01')
      : (acqDateInput.value || null);

    acqModalSave.disabled    = true;
    acqModalSave.textContent = 'Speichern…';

    var fields = {
      source_name: source, source_type: type, amount: amount, cost_date: date,
      notes: notes, updated_at: new Date().toISOString(),
    };
    if (monthsAvailable) fields.is_recurring = recurring;
    var promise = editingId
      ? window.db.acquisitionCosts.update(editingId, fields)
      : window.db.acquisitionCosts.create(source, type, amount, date, notes,
                                          monthsAvailable ? recurring : undefined);

    promise
      .then(function (saved) {
        var id = editingId || (saved && saved.id);
        if (!id) return null;
        return syncRules(id, recurring).then(function () {
          return syncMonths(id, draft, recurring, gridYear);
        });
      })
      .then(function () { closeModal(); loadData(); })
      .catch(function (e) { showError('Fehler: ' + e.message); closeModal(); })
      .finally(function () { acqModalSave.disabled = false; acqModalSave.textContent = 'Speichern'; });
  });

  // ── Delete Modal ──────────────────────────────────────────────────────
  function openDeleteModal(entry) {
    deletingId = entry.id;
    deleteEntryName.textContent = entry.source_name;
    deleteModal.classList.remove('hidden');
  }

  function closeDeleteModal() { deleteModal.classList.add('hidden'); deletingId = null; }

  deleteModalClose.addEventListener('click',   closeDeleteModal);
  deleteModalCancel.addEventListener('click',  closeDeleteModal);
  deleteModal.addEventListener('click', function (e) { if (e.target === deleteModal) closeDeleteModal(); });

  deleteModalConfirm.addEventListener('click', function () {
    deleteModalConfirm.disabled    = true;
    deleteModalConfirm.textContent = 'Löschen…';
    window.db.acquisitionCosts.delete(deletingId)
      .then(function () { closeDeleteModal(); loadData(); })
      .catch(function (e) { showError('Fehler: ' + e.message); closeDeleteModal(); })
      .finally(function () { deleteModalConfirm.disabled = false; deleteModalConfirm.textContent = 'Endgültig löschen'; });
  });

  // ── Assign Modal ──────────────────────────────────────────────────────
  function openAssignModal(cost) {
    assigningCost = cost;

    // Build saved set from current DB links
    savedLinks = {};
    selectedSet = {};
    savedTags = {};
    tagSet = {};
    allLinks.forEach(function (l) {
      if (l.acquisition_cost_id === cost.id) {
        var k = norm(l.contact_name);
        savedLinks[k]  = true;
        selectedSet[k] = true;
        savedTags[k]   = (l.tag || '');
        tagSet[k]      = (l.tag || '');
      }
    });
    refreshTagOptions();

    assignModalSource.textContent = cost.source_name;
    assignSearch.value = '';
    renderAssignList('');
    assignModal.classList.remove('hidden');
    assignSearch.focus();
  }

  function closeAssignModal() { assignModal.classList.add('hidden'); assigningCost = null; }

  function renderAssignList(filter) {
    var f = filter.trim().toLowerCase();

    // Kunden, die bereits an einer ANDEREN Quelle hängen – damit beim Umhängen
    // (z. B. Google → KI) sichtbar ist, wo der Kunde gerade zugeordnet ist.
    var costNameById = {};
    allCosts.forEach(function (c) { costNameById[c.id] = c.source_name; });
    var otherSources = {};
    allLinks.forEach(function (l) {
      if (!assigningCost || l.acquisition_cost_id === assigningCost.id) return;
      var k = norm(l.contact_name);
      if (!otherSources[k]) otherSources[k] = [];
      otherSources[k].push(costNameById[l.acquisition_cost_id] || '—');
    });

    assignClientList.innerHTML = '';
    allClients.forEach(function (contactName) {
      if (f && contactName.toLowerCase().indexOf(f) === -1) return;
      var key     = norm(contactName);
      var checked = !!selectedSet[key];
      // Zeile: Checkbox + Name als <label>, Tag-Feld daneben (nicht im Label,
      // sonst würde ein Klick ins Feld die Checkbox umschalten).
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:6px;background:var(--surface);border:1px solid var(--border)';

      var label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none;flex:1;min-width:0';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:var(--primary);flex-shrink:0';
      var nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'font-size:14px;font-weight:500';
      nameSpan.textContent = contactName;
      label.appendChild(cb);
      label.appendChild(nameSpan);
      if (otherSources[key]) {
        var hint = document.createElement('span');
        hint.style.cssText = 'font-size:11px;color:var(--text-secondary);font-weight:400;white-space:nowrap';
        hint.textContent = 'bereits: ' + otherSources[key].join(', ');
        label.appendChild(hint);
      }
      row.appendChild(label);

      var tagInput = makeTagInput(tagSet[key], 'Unterkanal');
      tagInput.style.cssText += ';width:150px;flex-shrink:0';
      tagInput.disabled = !checked;
      tagInput.addEventListener('input', function () { tagSet[key] = tagInput.value.trim(); });
      row.appendChild(tagInput);

      cb.addEventListener('change', function () {
        if (cb.checked) selectedSet[key] = true;
        else delete selectedSet[key];
        tagInput.disabled = !cb.checked;
      });

      assignClientList.appendChild(row);
    });
  }

  assignSearch.addEventListener('input', function () { renderAssignList(assignSearch.value); });
  assignModalClose.addEventListener('click',  closeAssignModal);
  assignModalCancel.addEventListener('click', closeAssignModal);
  assignModal.addEventListener('click', function (e) { if (e.target === assignModal) closeAssignModal(); });

  assignModalSave.addEventListener('click', function () {
    if (!assigningCost) return;
    var costId  = assigningCost.id;
    var updates = [];

    // Add newly checked
    Object.keys(selectedSet).forEach(function (normName) {
      var original = allClients.find(function (c) { return norm(c) === normName; }) || normName;
      if (!savedLinks[normName]) {
        updates.push(window.db.acquisitionContactLinks.create(costId, original, tagSet[normName]));
      } else if ((tagSet[normName] || '') !== (savedTags[normName] || '')) {
        updates.push(window.db.acquisitionContactLinks.setTag(costId, original, tagSet[normName]));
      }
    });

    // Remove unchecked
    Object.keys(savedLinks).forEach(function (normName) {
      if (!selectedSet[normName]) {
        var original = allClients.find(function (c) { return norm(c) === normName; }) || normName;
        updates.push(window.db.acquisitionContactLinks.delete(costId, original));
      }
    });

    if (updates.length === 0) { closeAssignModal(); return; }

    assignModalSave.disabled    = true;
    assignModalSave.textContent = 'Speichern…';
    Promise.all(updates)
      .then(function () { closeAssignModal(); loadData(); })
      .catch(function (e) { showError('Fehler: ' + e.message); closeAssignModal(); })
      .finally(function () { assignModalSave.disabled = false; assignModalSave.textContent = 'Speichern'; });
  });

  // ── Detail Modal ──────────────────────────────────────────────────────
  function openDetailModal(cost, linkedContactNames) {
    refreshTagOptions();
    detailModalTitle.textContent = cost.source_name + ' – Zugeordnete Kunden';
    detailModalBody.innerHTML = '<div style="padding:20px;color:var(--text-secondary);font-size:13px">Lade…</div>';
    detailModal.classList.remove('hidden');

    if (linkedContactNames.length === 0) {
      detailModalBody.innerHTML = '<div style="padding:24px;color:var(--text-secondary);text-align:center">Noch keine Kunden zugeordnet.</div>';
      return;
    }

    window.db.revenue.forContacts(linkedContactNames).then(function (rows) {
      // rows include id now
      // Group by contact → by monthKey → {id, amount}
      var byContact = {};
      linkedContactNames.forEach(function (n) { byContact[n] = {}; });
      rows.forEach(function (r) {
        if (!revenueMonthInRange(r.year, r.month)) return; // respect active date filter
        var name = r.contact_name;
        if (!byContact[name]) byContact[name] = {};
        var key = r.year + '-' + String(r.month).padStart(2, '0');
        // keep the row id for editing
        byContact[name][key] = { id: r.id, amount: (r.total_amount || 0), year: r.year, month: r.month };
      });

      function renderDetail() {
        var wrap = document.createElement('div');
        wrap.style.cssText = 'overflow-y:auto;max-height:520px';

        linkedContactNames.slice().sort(function (a, b) { return a.localeCompare(b, 'de'); }).forEach(function (name) {
          var months = byContact[name] || {};
          var total  = Object.values(months).reduce(function (s, v) { return s + (v.amount || 0); }, 0);
          var sortedMonths = Object.keys(months).sort();

          var section = document.createElement('div');
          section.style.cssText = 'border-bottom:1px solid var(--border);padding:14px 20px';

          var header = document.createElement('div');
          header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:' + (sortedMonths.length ? '8px' : '0');
          var nameEl = document.createElement('span');
          nameEl.style.cssText = 'font-weight:600;font-size:14px;flex:1;min-width:0';
          nameEl.textContent = name;
          header.appendChild(nameEl);

          // Unterkanal direkt hier änderbar – so lässt sich eine bestehende
          // Zuordnung nachträglich verfeinern (Google organisch vs. ChatGPT …).
          var link = allLinks.filter(function (l) {
            return l.acquisition_cost_id === cost.id && norm(l.contact_name) === norm(name);
          })[0];
          var tagInput = makeTagInput(link ? link.tag : '', 'Unterkanal');
          tagInput.style.cssText += ';width:150px;flex-shrink:0';
          tagInput.title = 'Unterkanal – z.B. Google organisch oder ChatGPT';
          tagInput.addEventListener('change', function () {
            var val = tagInput.value.trim();
            if (!link || (link.tag || '') === val) return;
            tagInput.disabled = true;
            window.db.acquisitionContactLinks.setTag(cost.id, link.contact_name, val)
              .then(function () {
                link.tag = val || null;
                tagInput.disabled = false;
                refreshTagOptions();
                if (lastRenderArgs) render(lastRenderArgs[0], lastRenderArgs[1], lastRenderArgs[2]);
              })
              .catch(function (e) {
                tagInput.disabled = false;
                tagInput.value = link.tag || '';
                showError('Unterkanal konnte nicht gespeichert werden: ' + e.message);
              });
          });
          header.appendChild(tagInput);

          var totalEl = document.createElement('span');
          totalEl.className = 'contact-total';
          totalEl.style.cssText = 'font-weight:700;font-size:14px;font-variant-numeric:tabular-nums';
          totalEl.textContent = fmt(total);
          header.appendChild(totalEl);
          section.appendChild(header);

          if (sortedMonths.length) {
            var tagsWrap = document.createElement('div');
            tagsWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px';

            sortedMonths.forEach(function (mk) {
              var entry = months[mk];
              var y = entry.year, m = entry.month;
              var label = MONTHS_LABEL[m - 1] + ' ' + y;

              var tag = document.createElement('span');
              tag.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:11px;background:var(--surface-hover,#f1f5f9);border:1px solid var(--border);border-radius:4px;padding:2px 4px 2px 7px;font-variant-numeric:tabular-nums';
              var tagText = document.createElement('span');
              tagText.style.cssText = 'cursor:pointer';
              tagText.title = 'Klicken zum Bearbeiten';
              tagText.textContent = label + ' · ' + fmt(entry.amount);
              var syncBtn = document.createElement('button');
              syncBtn.title = 'Diesen Monat neu von LexOffice laden';
              syncBtn.style.cssText = 'background:none;border:none;cursor:pointer;padding:1px 3px;font-size:10px;color:var(--text-secondary);line-height:1;border-radius:3px';
              syncBtn.textContent = '↺';
              syncBtn.addEventListener('mouseenter', function(){ syncBtn.style.color='var(--primary)'; });
              syncBtn.addEventListener('mouseleave', function(){ syncBtn.style.color='var(--text-secondary)'; });
              syncBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (!localStorage.getItem('lexofficeKey')) { alert('LexOffice API Key fehlt. Bitte in den Einstellungen hinterlegen.'); return; }
                syncBtn.textContent = '…';
                syncBtn.style.pointerEvents = 'none';
                var supaUrl = localStorage.getItem('supabaseUrl') || 'https://lgrnmiszhhahfcmctmwo.supabase.co';
                var supaKey = localStorage.getItem('supabaseKey') || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxncm5taXN6aGhhaGZjbWN0bXdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NjE2NDksImV4cCI6MjA4OTIzNzY0OX0.FDZRGMESves7XbAMs_oMLWmvnywMlVqe8p7f1kt06qk';
                var kw = (localStorage.getItem('revenueExcludeKeywords') || '').split('\n').map(function(k){return k.trim();}).filter(Boolean);
                fetch(supaUrl + '/functions/v1/sync-lexoffice', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + supaKey, 'apikey': supaKey },
                  body: JSON.stringify({ lexofficeKey: localStorage.getItem('lexofficeKey'), year: y, month: m, excludeKeywords: kw }),
                }).then(function(res){ return res.json(); }).then(function(data) {
                  if (data.error) throw new Error(data.error);
                  // Show debug: which invoices were found for this contact
                  var contactDebug = (data.debug || []).filter(function(d){ return (d.contact||'').toLowerCase() === name.toLowerCase(); });
                  if (contactDebug.length > 0) {
                    var debugLines = contactDebug.map(function(d) {
                      var line = (d.excluded ? '🚫 AUSGESCHLOSSEN' : '✅ GEZÄHLT') + ': Brutto ' + (d.gross||0) + ' → Netto ' + (d.net||0);
                      if (d.excluded) line += ' (' + (d.excluded) + ')';
                      return line;
                    }).join('\n');
                    console.log('[Sync Debug] ' + name + ' ' + label + ':\n' + debugLines);
                    if (contactDebug.length > 1 || contactDebug.some(function(d){ return !d.excluded && d.net > 4000; })) {
                      alert('Rechnungen für ' + name + ' im ' + label + ':\n\n' + debugLines + '\n\nBitte prüfe die nicht ausgeschlossene(n) Rechnung(en) in LexOffice und teile mir den Rechnungstitel mit.');
                    }
                  }
                  // Reload just this month's revenue for this contact
                  return window.db.revenue.forContacts([name]);
                }).then(function(rows) {
                  rows.forEach(function(r) {
                    if (r.year === y && r.month === m && r.contact_name === name) {
                      entry.id = r.id;
                      entry.amount = r.total_amount || 0;
                    }
                  });
                  tagText.textContent = label + ' · ' + fmt(entry.amount);
                  var newTotal = Object.values(months).reduce(function(s,v){return s+(v.amount||0);},0);
                  header.querySelector('.contact-total').textContent = fmt(newTotal);
                  syncBtn.textContent = '✓';
                  setTimeout(function(){ syncBtn.textContent = '↺'; syncBtn.style.pointerEvents = ''; }, 2000);
                  // Reload ALL revenue rows so the main table reflects any new/changed months
                  if (lastRenderArgs) {
                    window.db.revenue.allRows().then(function(freshRevenues) {
                      lastRenderArgs[1] = freshRevenues;
                      render(lastRenderArgs[0], lastRenderArgs[1], lastRenderArgs[2]);
                    }).catch(function(){
                      // Fallback: update just the known row
                      lastRenderArgs[1].forEach(function(row) {
                        if (row.contact_name === name && row.year === y && row.month === m) row.total_amount = entry.amount;
                      });
                      render(lastRenderArgs[0], lastRenderArgs[1], lastRenderArgs[2]);
                    });
                  }
                }).catch(function(e) {
                  syncBtn.textContent = '↺';
                  syncBtn.style.pointerEvents = '';
                  alert('Sync-Fehler: ' + e.message);
                });
              });
              tag.appendChild(tagText);
              tag.appendChild(syncBtn);

              tagText.addEventListener('click', function () {
                // Replace tag with inline edit
                var input = document.createElement('input');
                input.type = 'number';
                input.step = '0.01';
                input.value = entry.amount;
                input.style.cssText = 'font-size:11px;width:120px;padding:1px 6px;border:1px solid var(--primary);border-radius:4px;font-variant-numeric:tabular-nums';

                var saveSpan = document.createElement('span');
                saveSpan.textContent = '✓';
                saveSpan.title = 'Speichern';
                saveSpan.style.cssText = 'cursor:pointer;font-size:13px;color:var(--success);padding:0 4px;font-weight:700';

                var cancelSpan = document.createElement('span');
                cancelSpan.textContent = '✕';
                cancelSpan.title = 'Abbrechen';
                cancelSpan.style.cssText = 'cursor:pointer;font-size:13px;color:var(--danger);padding:0 2px;font-weight:700';

                var splitBtn = document.createElement('button');
                splitBtn.textContent = '÷ Aufteilen';
                splitBtn.title = 'Betrag auf mehrere Monate verteilen (z.B. Quartalsrechnung)';
                splitBtn.style.cssText = 'background:none;border:1px solid var(--border);cursor:pointer;padding:1px 7px;font-size:10px;color:var(--text-secondary);border-radius:3px;line-height:1.5;white-space:nowrap;font-family:inherit';

                var editWrap = document.createElement('span');
                editWrap.style.cssText = 'display:inline-flex;align-items:center;gap:3px;background:var(--surface-hover,#f1f5f9);border-radius:4px;padding:1px 4px';
                editWrap.appendChild(document.createTextNode(label + ' · '));
                editWrap.appendChild(input);
                editWrap.appendChild(saveSpan);
                editWrap.appendChild(cancelSpan);
                editWrap.appendChild(splitBtn);

                tag.replaceWith(editWrap);
                input.focus();
                input.select();

                function doSave() {
                  var newVal = parseFloat(input.value);
                  if (isNaN(newVal) || newVal < 0) { input.focus(); return; }
                  saveSpan.textContent = '…';
                  saveSpan.style.pointerEvents = 'none';
                  window.db.revenue.updateAmount(entry.id, newVal).then(function () {
                    entry.amount = newVal;
                    var newTotal = Object.values(months).reduce(function(s,v){return s+(v.amount||0);},0);
                    header.querySelector('.contact-total').textContent = fmt(newTotal);
                    tag.textContent = label + ' · ' + fmt(newVal);
                    editWrap.replaceWith(tag);
                    if (lastRenderArgs) {
                      lastRenderArgs[1].forEach(function(row) {
                        if (row.contact_name === name && row.year === y && row.month === m) {
                          row.total_amount = newVal;
                        }
                      });
                      render(lastRenderArgs[0], lastRenderArgs[1], lastRenderArgs[2]);
                    }
                  }).catch(function(e) {
                    saveSpan.textContent = '✓';
                    saveSpan.style.pointerEvents = '';
                    alert('Fehler: ' + e.message);
                  });
                }

                saveSpan.addEventListener('click', doSave);
                cancelSpan.addEventListener('click', function () { editWrap.replaceWith(tag); });
                input.addEventListener('keydown', function(e) {
                  if (e.key === 'Enter') doSave();
                  if (e.key === 'Escape') editWrap.replaceWith(tag);
                });

                splitBtn.addEventListener('click', function(e) {
                  e.stopPropagation();
                  var total = entry.amount;
                  var numIn = document.createElement('input');
                  numIn.type = 'number'; numIn.min = '2'; numIn.max = '12'; numIn.value = '3';
                  numIn.style.cssText = 'font-size:11px;width:36px;padding:1px 4px;border:1px solid var(--primary);border-radius:4px;text-align:center;font-family:inherit';
                  var okSpan = document.createElement('span');
                  okSpan.textContent = '✓ OK';
                  okSpan.style.cssText = 'cursor:pointer;font-size:11px;color:var(--success);padding:0 5px;font-weight:700;white-space:nowrap';
                  var xSpan = document.createElement('span');
                  xSpan.textContent = '✕';
                  xSpan.style.cssText = 'cursor:pointer;font-size:13px;color:var(--danger);padding:0 2px;font-weight:700';
                  editWrap.innerHTML = '';
                  editWrap.appendChild(document.createTextNode(label + ' ' + fmt(total) + ' ÷ '));
                  editWrap.appendChild(numIn);
                  editWrap.appendChild(document.createTextNode(' Monate '));
                  editWrap.appendChild(okSpan);
                  editWrap.appendChild(xSpan);
                  numIn.focus(); numIn.select();
                  xSpan.addEventListener('click', function() { editWrap.replaceWith(tag); });
                  function doSplit() {
                    var n = parseInt(numIn.value);
                    if (!n || n < 2 || n > 12) { numIn.focus(); return; }
                    okSpan.textContent = '…'; okSpan.style.pointerEvents = 'none';
                    var perMonth = parseFloat((total / n).toFixed(2));
                    var lastAmt  = parseFloat((total - perMonth * (n - 1)).toFixed(2));
                    var mList = [];
                    var iy = y, im = m;
                    for (var i = 0; i < n; i++) {
                      mList.push({ year: iy, month: im, amount: (i === n - 1 ? lastAmt : perMonth) });
                      im++; if (im > 12) { im = 1; iy++; }
                    }
                    var promises = [window.db.revenue.updateAmount(entry.id, mList[0].amount)];
                    for (var j = 1; j < n; j++) {
                      promises.push(window.db.revenue.insertRow(mList[j].year, mList[j].month, name, mList[j].amount));
                    }
                    Promise.all(promises).then(function(results) {
                      mList.forEach(function(ml, idx) {
                        var mk = ml.year + '-' + String(ml.month).padStart(2, '0');
                        months[mk] = { id: idx === 0 ? entry.id : (results[idx] && results[idx].id), amount: ml.amount, year: ml.year, month: ml.month };
                        if (lastRenderArgs) {
                          var found = false;
                          lastRenderArgs[1].forEach(function(row) {
                            if (row.contact_name === name && row.year === ml.year && row.month === ml.month) { row.total_amount = ml.amount; found = true; }
                          });
                          if (!found) lastRenderArgs[1].push({ contact_name: name, year: ml.year, month: ml.month, total_amount: ml.amount });
                        }
                      });
                      renderDetail();
                      if (lastRenderArgs) render(lastRenderArgs[0], lastRenderArgs[1], lastRenderArgs[2]);
                    }).catch(function(e2) {
                      alert('Fehler beim Aufteilen: ' + e2.message);
                      editWrap.replaceWith(tag);
                    });
                  }
                  okSpan.addEventListener('click', doSplit);
                  numIn.addEventListener('keydown', function(e2) {
                    if (e2.key === 'Enter') doSplit();
                    if (e2.key === 'Escape') editWrap.replaceWith(tag);
                  });
                });
              });

              tagsWrap.appendChild(tag);
            });
            section.appendChild(tagsWrap);

            var hint = document.createElement('div');
            hint.style.cssText = 'margin-top:5px;font-size:10px;color:var(--text-secondary)';
            hint.textContent = '✏️ Auf einen Monatswert klicken zum Korrigieren';
            section.appendChild(hint);
          } else {
            var empty = document.createElement('span');
            empty.style.cssText = 'font-size:12px;color:var(--text-secondary)';
            empty.textContent = (filterFrom.value || filterTo.value)
              ? 'Kein Umsatz im gewählten Zeitraum'
              : 'Kein Umsatz in importierten Monaten';
            section.appendChild(empty);
          }

          wrap.appendChild(section);
        });
        detailModalBody.innerHTML = '';
        detailModalBody.appendChild(wrap);
      }

      renderDetail();
    }).catch(function (e) {
      detailModalBody.innerHTML = '<div style="padding:20px;color:var(--danger)">Fehler: ' + escHtml(e.message) + '</div>';
    });
  }

  function closeDetailModal() { detailModal.classList.add('hidden'); }

  detailModalClose.addEventListener('click', closeDetailModal);
  detailModal.addEventListener('click', function (e) { if (e.target === detailModal) closeDetailModal(); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeModal(); closeDeleteModal(); closeAssignModal(); closeDetailModal();
      if (!unassignedModal.classList.contains('hidden')) closeUnassignedModal(); }
  });

  // ── Nicht zugeordnete Kunden ─────────────────────────────────────────
  // Kunden mit echtem Umsatz, die in KEINEM acquisition_contact_links-Eintrag
  // stehen. Ausgeschlossen werden Kontakte, die auch sonst nicht als
  // Agenturumsatz zählen: contact_overrides status='excluded' oder
  // 'cat:Software' sowie automatisch erkannte Software-/PPC-Tool-Kunden
  // (gleiche Logik wie in neukunden.js).
  var PPC_CATEGORY = 'Software';

  // Altbestand ausblenden: Kunden, deren erste Rechnung vor diesem Monat liegt,
  // wurden vor der Akquisitions-Erfassung gewonnen und sind hier nur Rauschen.
  var UNASSIGNED_FROM_YM    = 2024 * 12 + 5;   // Juni 2024
  var UNASSIGNED_FROM_LABEL = 'Juni 2024';

  var unassignedBanner    = document.getElementById('unassignedBanner');
  var unassignedModal     = document.getElementById('unassignedModal');
  var unassignedBody      = document.getElementById('unassignedBody');
  var unassignedSearch    = document.getElementById('unassignedSearch');
  var unassignedHint      = document.getElementById('unassignedHint');
  var unassignedModalClose= document.getElementById('unassignedModalClose');
  var unassignedModalDone = document.getElementById('unassignedModalDone');

  function buildExclusions(revenues) {
    excludedSet = {};
    allOverrides.forEach(function (o) {
      if (o.status === 'excluded') excludedSet[norm(o.contact_name)] = 1;
      else if (o.status && o.status.indexOf('cat:') === 0 && o.status.slice(4) === PPC_CATEGORY) excludedSet[norm(o.contact_name)] = 1;
    });
    var auto = window.detectSoftwareContacts ? window.detectSoftwareContacts(revenues) : {};
    Object.keys(auto).forEach(function (k) { excludedSet[k] = 1; });
  }

  function ymLabel(v) { return MONTHS_LABEL[(v % 12)] + ' ' + Math.floor(v / 12); }

  // → [{ name, firstYm, lastYm, totalRev }] sortiert nach Erstrechnung (neueste zuerst)
  function computeUnassigned(revenues, links) {
    var linked = {};
    links.forEach(function (l) { linked[norm(l.contact_name)] = 1; });

    var byContact = {};   // originalName → { firstYm, lastYm, totalRev }
    revenues.forEach(function (r) {
      var name = r.contact_name;
      if (!name) return;
      var amt = Number(r.total_amount) || 0;
      if (!(amt > 0)) return;
      var key = norm(name);
      if (excludedSet[key] || linked[key]) return;
      var v = r.year * 12 + (r.month - 1);
      var e = byContact[name];
      if (!e) { byContact[name] = { name: name, firstYm: v, lastYm: v, totalRev: amt }; return; }
      if (v < e.firstYm) e.firstYm = v;
      if (v > e.lastYm)  e.lastYm  = v;
      e.totalRev += amt;
    });

    return Object.keys(byContact).map(function (k) { return byContact[k]; })
      .filter(function (u) { return u.firstYm >= UNASSIGNED_FROM_YM; })
      .sort(function (a, b) { return b.firstYm - a.firstYm || a.name.localeCompare(b.name, 'de'); });
  }

  function renderUnassigned(revenues, links) {
    unassignedAll = computeUnassigned(revenues, links);
    // Zeitraumfilter gilt hier für die ERSTRECHNUNG – der Kunde wurde in
    // diesem Zeitraum gewonnen, also gehört er zu einer Quelle daraus.
    var rangeActive = !!(filterFrom.value || filterTo.value);
    unassigned = rangeActive
      ? unassignedAll.filter(function (u) { return revenueMonthInRange(Math.floor(u.firstYm / 12), (u.firstYm % 12) + 1); })
      : unassignedAll.slice();

    if (unassigned.length === 0) {
      var hiddenNote = (rangeActive && unassignedAll.length)
        ? '<div class="alert alert-info" style="display:flex;align-items:center;gap:12px;justify-content:space-between;margin:0">' +
            '<div>✅ Im gewählten Zeitraum ist jeder Kunde einer Quelle zugeordnet. ' +
            '<span style="opacity:.8">Außerhalb des Zeitraums fehlen noch ' + unassignedAll.length + '.</span></div>' +
            '<button class="btn btn-secondary btn-sm" id="unassignedOpenBtn" style="flex-shrink:0">Trotzdem anzeigen</button>' +
          '</div>'
        : '';
      unassignedBanner.innerHTML = hiddenNote;
      unassignedBanner.classList.toggle('hidden', !hiddenNote);
    } else {
      var rev = 0;
      unassigned.forEach(function (u) { rev += u.totalRev; });
      unassignedBanner.innerHTML =
        '<div class="alert alert-warn" style="display:flex;align-items:center;gap:12px;justify-content:space-between;margin:0">' +
          '<div>⚠️ <strong>' + unassigned.length + (unassigned.length === 1 ? ' Kunde' : ' Kunden') + '</strong> mit Umsatz ' +
            (unassigned.length === 1 ? 'ist' : 'sind') + ' noch keiner Akquisitionsquelle zugeordnet' +
            ' <span style="opacity:.8">(Erstrechnung ' + (rangeActive ? 'im gewählten Zeitraum' : 'ab ' + UNASSIGNED_FROM_LABEL) + ')</span>' +
            ' – ' + fmt(rev) + ' Umsatz ohne Kanal.</div>' +
          '<button class="btn btn-secondary btn-sm" id="unassignedOpenBtn" style="flex-shrink:0">Jetzt zuordnen</button>' +
        '</div>';
      unassignedBanner.classList.remove('hidden');
    }

    var openBtn = document.getElementById('unassignedOpenBtn');
    if (openBtn) openBtn.addEventListener('click', function () {
      openUnassignedModal(unassigned.length ? unassigned : unassignedAll);
    });
  }

  var unassignedRows = [];

  function openUnassignedModal(rows) {
    unassignedRows   = rows.slice();
    unassignedDirty  = false;
    refreshTagOptions();
    unassignedSearch.value = '';
    unassignedHint.textContent = unassignedRows.length +
      ' Kunden mit Umsatz haben keine Quelle (Erstrechnung ab ' + UNASSIGNED_FROM_LABEL + ' – ältere Bestandskunden bleiben außen vor).' +
      ' Ordne sie einem Eintrag zu – die Zuordnung wird sofort gespeichert.';
    renderUnassignedList('');
    unassignedModal.classList.remove('hidden');
    unassignedSearch.focus();
  }

  function closeUnassignedModal() {
    unassignedModal.classList.add('hidden');
    if (unassignedDirty) { unassignedDirty = false; loadData(); }
  }

  function renderUnassignedList(filter) {
    var f = (filter || '').trim().toLowerCase();
    var sourceOptions = allCosts.slice()
      .sort(function (a, b) { return (a.source_name || '').localeCompare(b.source_name || '', 'de'); })
      .map(function (c) { return '<option value="' + c.id + '">' + escHtml(c.source_name) + '</option>'; })
      .join('');

    unassignedBody.innerHTML = '';
    var shown = 0;
    unassignedRows.forEach(function (u) {
      if (f && u.name.toLowerCase().indexOf(f) === -1) return;
      shown++;
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td style="font-weight:500">' + escHtml(u.name) +
          '<br><span style="font-size:11px;color:var(--text-secondary);font-weight:400">zuletzt ' + ymLabel(u.lastYm) + '</span>' +
        '</td>' +
        '<td>' + ymLabel(u.firstYm) + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt(u.totalRev) + '</td>' +
        '<td><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
          '<select class="src-select" style="flex:1;min-width:0;padding:5px 8px;border:1px solid var(--border);border-radius:var(--radius);font-size:13px;background:var(--surface);color:var(--text)">' +
            '<option value="">– Quelle wählen –</option>' + sourceOptions +
          '</select>' +
          '<button class="btn btn-primary btn-sm assign-one" style="flex-shrink:0">Zuordnen</button>' +
          '<span class="tag-slot" style="flex-basis:100%"></span>' +
        '</div></td>';

      var sel = tr.querySelector('.src-select');
      var btn = tr.querySelector('.assign-one');
      var tagInput = makeTagInput('', 'Unterkanal (optional)');
      tagInput.style.cssText += ';width:100%;box-sizing:border-box';
      tr.querySelector('.tag-slot').appendChild(tagInput);
      btn.addEventListener('click', function () {
        var costId = sel.value;
        if (!costId) { sel.focus(); return; }
        btn.disabled = true;
        btn.textContent = '…';
        window.db.acquisitionContactLinks.create(costId, u.name, tagInput.value.trim())
          .then(function () {
            unassignedDirty = true;
            unassignedRows = unassignedRows.filter(function (r) { return r.name !== u.name; });
            unassigned     = unassigned.filter(function (r) { return r.name !== u.name; });
            unassignedAll  = unassignedAll.filter(function (r) { return r.name !== u.name; });
            unassignedHint.textContent = unassignedRows.length +
              ' Kunden mit Umsatz haben keine Quelle (Erstrechnung ab ' + UNASSIGNED_FROM_LABEL + ' – ältere Bestandskunden bleiben außen vor).' +
              ' Ordne sie einem Eintrag zu – die Zuordnung wird sofort gespeichert.';
            tr.remove();
            if (!unassignedBody.children.length) {
              unassignedBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-secondary);padding:20px">Alles zugeordnet ✅</td></tr>';
            }
          })
          .catch(function (e) {
            btn.disabled = false;
            btn.textContent = 'Zuordnen';
            showError('Zuordnung fehlgeschlagen: ' + e.message);
          });
      });

      unassignedBody.appendChild(tr);
    });

    if (shown === 0) {
      unassignedBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-secondary);padding:20px">' +
        (unassignedRows.length ? 'Kein Treffer.' : 'Alles zugeordnet ✅') + '</td></tr>';
    }
  }

  unassignedSearch.addEventListener('input', function () { renderUnassignedList(unassignedSearch.value); });
  unassignedModalClose.addEventListener('click', closeUnassignedModal);
  unassignedModalDone.addEventListener('click',  closeUnassignedModal);
  unassignedModal.addEventListener('click', function (e) { if (e.target === unassignedModal) closeUnassignedModal(); });

  // ── Vorschlag aus den Bankdaten ───────────────────────────────────────
  // Bewusst kein automatisches Schreiben: die Seite rechnet nur aus, was sich
  // gegenüber den erfassten Monaten geändert hat, und zeigt es an. Übernommen
  // wird auf Knopfdruck oder beim Speichern im Dialog.
  function autoDiffFor(cost) {
    var rules = rulesByCost[cost.id] || [];
    if (!cost.is_recurring || !rules.length) return null;

    var year     = entryYear(cost);
    var auto     = autoMonthsFor(rules);
    var existing = monthsOf(cost.id);
    var changes  = [];   // [{ ym, from, to }]
    var seen     = {};

    Object.keys(auto).forEach(function (ym) {
      if (parseInt(ym.slice(0, 4), 10) !== year) return;   // gehört zu einem anderen Jahreseintrag
      seen[ym] = true;
      var cur = existing[ym];
      var had = cur ? cur.auto : 0;
      if (Math.abs(had - auto[ym]) > 0.004) changes.push({ ym: ym, from: had, to: auto[ym] });
    });

    // Buchung nachträglich ausgeschlossen oder Regel entfernt → Auto-Anteil weg
    Object.keys(existing).forEach(function (ym) {
      if (parseInt(ym.slice(0, 4), 10) !== year || seen[ym]) return;
      if (existing[ym].auto) changes.push({ ym: ym, from: existing[ym].auto, to: 0 });
    });

    if (!changes.length) return null;

    var newTotal = 0;
    Object.keys(existing).forEach(function (ym) {
      if (parseInt(ym.slice(0, 4), 10) === year) newTotal += existing[ym].manual;
    });
    Object.keys(auto).forEach(function (ym) {
      if (parseInt(ym.slice(0, 4), 10) === year) newTotal += auto[ym];
    });
    newTotal = Math.round(newTotal * 100) / 100;

    return { cost: cost, changes: changes, newTotal: newTotal, delta: Math.round((newTotal - (Number(cost.amount) || 0)) * 100) / 100 };
  }

  function applyAutoFor(cost) {
    var diff = autoDiffFor(cost);
    if (!diff) return Promise.resolve();
    var existing = monthsOf(cost.id);
    var ops = diff.changes.map(function (c) {
      var manual = existing[c.ym] ? existing[c.ym].manual : 0;
      if (!c.to && !manual) return window.db.acquisitionCostMonths.remove(cost.id, c.ym);
      return window.db.acquisitionCostMonths.set(cost.id, c.ym, { auto: c.to, manual: manual });
    });
    return Promise.all(ops).then(function () {
      return window.db.acquisitionCosts.update(cost.id, {
        amount: diff.newTotal, updated_at: new Date().toISOString(),
      });
    });
  }

  // ── Load data ─────────────────────────────────────────────────────────
  function loadData() {
    errorEl.innerHTML = '';
    loadingEl.classList.remove('hidden');
    contentEl.classList.add('hidden');
    emptyState.classList.add('hidden');

    Promise.all([
      window.db.acquisitionCosts.list(),
      window.db.revenue.allRows(),
      window.db.acquisitionContactLinks.listAll(),
      (window.db.contactOverrides ? window.db.contactOverrides.listAll() : Promise.resolve([])).catch(function () { return []; }),
      // null = Tabelle fehlt noch (Migration nicht gelaufen) – die Seite läuft
      // dann ohne Monatserfassung weiter statt zu brechen.
      (window.db.acquisitionCostMonths ? window.db.acquisitionCostMonths.listAll() : Promise.resolve(null)).catch(function () { return null; }),
      (window.db.acquisitionCostHistory ? window.db.acquisitionCostHistory.available() : Promise.resolve(null))
        .then(function () { return true; }).catch(function () { return false; }),
      (window.db.acquisitionCostRules ? window.db.acquisitionCostRules.listAll() : Promise.resolve(null)).catch(function () { return null; }),
      // Buchungen aus der Kostenanalyse – Quelle der automatischen Monatswerte.
      (window.db.cost && window.db.cost.transactions ? window.db.cost.transactions.all() : Promise.resolve([])).catch(function () { return []; }),
    ])
    .then(function (results) {
      var costs    = results[0];
      var revenues = results[1];
      var links    = results[2];
      allOverrides = results[3] || [];

      historyAvailable = results[5] === true;

      var monthRows   = results[4];
      monthsAvailable = monthRows !== null;
      monthsByCost    = {};
      (monthRows || []).forEach(function (r) {
        if (!monthsByCost[r.acquisition_cost_id]) monthsByCost[r.acquisition_cost_id] = {};
        monthsByCost[r.acquisition_cost_id][r.ym] = {
          id: r.id,
          amount: Number(r.amount) || 0,
          auto:   Number(r.auto_amount) || 0,
          manual: r.manual_amount != null ? Number(r.manual_amount) : (Number(r.amount) || 0),
        };
      });

      var ruleRows   = results[6];
      rulesAvailable = ruleRows !== null;
      rulesByCost    = {};
      (ruleRows || []).forEach(function (r) {
        if (!rulesByCost[r.acquisition_cost_id]) rulesByCost[r.acquisition_cost_id] = [];
        rulesByCost[r.acquisition_cost_id].push(r);
      });

      allTx = results[7] || [];
      buildCategoryList();
      buildVendorList();
      buildExclusions(revenues);

      loadingEl.classList.add('hidden');

      var contactSet = {};
      revenues.forEach(function (r) { if (r.contact_name) contactSet[r.contact_name] = true; });
      allClients = Object.keys(contactSet).sort(function (a, b) { return a.localeCompare(b, 'de'); });

      if (costs.length === 0) { emptyState.classList.remove('hidden'); return; }

      contentEl.classList.remove('hidden');
      render(costs, revenues, links);
    })
    .catch(function (e) {
      loadingEl.classList.add('hidden');
      showError(e.message === 'NOT_CONFIGURED'
        ? 'Keine Supabase-Verbindung. Bitte <a href="settings.html">Einstellungen</a> prüfen.'
        : e.message);
    });
  }

  // ── Änderungsverlauf ─────────────────────────────────────────────────
  var historyModal      = document.getElementById('historyModal');
  var historyModalTitle = document.getElementById('historyModalTitle');
  var historyModalBody  = document.getElementById('historyModalBody');
  var historyModalClose = document.getElementById('historyModalClose');
  var historyAvailable  = true;   // false, solange die Migration nicht gelaufen ist

  function closeHistoryModal() { historyModal.classList.add('hidden'); }
  historyModalClose.addEventListener('click', closeHistoryModal);
  historyModal.addEventListener('click', function (e) { if (e.target === historyModal) closeHistoryModal(); });

  function fmtWhen(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ', ' +
           d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  function deltaHtml(oldA, newA) {
    if (oldA == null || newA == null) return '';
    var diff = Number(newA) - Number(oldA);
    if (!diff) return '';
    var cls = diff > 0 ? 'hist-up' : 'hist-down';
    return ' <span class="' + cls + '">(' + (diff > 0 ? '+' : '−') + fmt(Math.abs(diff)) + ')</span>';
  }

  // Angezeigt wird ausschließlich die Bewegung des Betrags.
  function historyText(h) {
    var oldA = h.old_amount == null ? null : Number(h.old_amount);
    var newA = h.new_amount == null ? null : Number(h.new_amount);

    if (h.field === 'baseline') {
      return '<strong>' + fmt(newA || 0) + '</strong> – Stand beim Einschalten des Verlaufs' +
             '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px">' +
             'Keine echte Änderung: nur der Betrag, der zu diesem Zeitpunkt in der Zeile stand.</div>';
    }
    if (h.field === 'created') {
      return 'Angelegt mit <strong>' + fmt(newA || 0) + '</strong>';
    }
    return (oldA == null ? '—' : fmt(oldA)) + ' → <strong>' + fmt(newA || 0) + '</strong>' + deltaHtml(oldA, newA);
  }

  function renderHistory(rows) {
    if (!rows.length) {
      historyModalBody.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-secondary)">' +
        'Noch keine Betragsänderung aufgezeichnet.</div>';
      return;
    }
    historyModalBody.innerHTML = rows.map(function (h) {
      return '<div class="hist-row">' +
        '<div class="hist-when">' + fmtWhen(h.changed_at) + '</div>' +
        '<div class="hist-what">' + historyText(h) + '</div>' +
      '</div>';
    }).join('');
  }

  function openHistoryModal(cost) {
    historyModalTitle.textContent = 'Betragsänderungen – ' + cost.source_name;
    historyModalBody.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-secondary)">Wird geladen…</div>';
    historyModal.classList.remove('hidden');
    window.db.acquisitionCostHistory.listAmountChanges(cost.id)
      .then(renderHistory)
      .catch(function (e) {
        historyModalBody.innerHTML = '<div style="padding:24px;color:var(--text-secondary)">' +
          'Verlauf nicht verfügbar: ' + escHtml(e.message) + '</div>';
      });
  }

  // Spalte „Erfasst bis": bei laufenden Kosten der letzte erfasste Monat samt
  // Status, bei einmaligen schlicht das Datum. Der Tooltip zeigt, wann der
  // Eintrag zuletzt angefasst wurde.
  function trackingCell(cost) {
    // Zwei verschiedene Datumsangaben, die leicht verwechselt werden:
    // cost_date = Datum, das im Eintrag steht; updated_at = wann die Zeile
    // zuletzt angefasst wurde. Der Tooltip benennt beides.
    var upd   = cost.updated_at ? new Date(cost.updated_at) : null;
    var title = (cost.is_recurring ? 'Letzter erfasster Monat' : 'Datum des Eintrags') +
                (upd ? '\nZeile zuletzt geändert: ' + fmtWhen(cost.updated_at) : '');

    // Uhr-Symbol öffnet den Änderungsverlauf dieses Eintrags.
    var histBtn = historyAvailable
      ? ' <button class="hist-btn" title="Änderungsverlauf anzeigen">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' +
        '</button>'
      : '';

    var st = recurringStatus(cost);
    if (!st) {
      var d = cost.cost_date ? cost.cost_date.split('-').reverse().join('.') : '—';
      return '<td title="' + escHtml(title) + '"><span style="font-size:12px;color:var(--text-secondary)">' + d + '</span>' + histBtn + '</td>';
    }

    var badge = '';
    if      (st.state === 'open') badge = '<span class="badge-open">' + st.missing + ' Mon. offen</span>';
    else if (st.state === 'none') badge = '<span class="badge-none">nichts erfasst</span>';
    else if (st.state === 'ok')   badge = '<span class="badge-ok">aktuell</span>';

    return '<td title="' + escHtml(title) + '">' +
      '<div style="display:flex;flex-direction:column;gap:3px;align-items:flex-start">' +
        '<span style="font-size:13px;font-weight:600">' + (st.last ? ymText(st.last) : '—') + histBtn + '</span>' +
        badge +
      '</div></td>';
  }

  // Erinnerung für laufende Kanäle: Welche Quelle hinkt hinterher?
  function renderStaleBanner(costs) {
    var banner = document.getElementById('staleBanner');
    if (!banner) return;
    banner.innerHTML = '';
    banner.classList.add('hidden');

    var pending = [];
    if (!monthsAvailable)  pending.push({ what: 'Monatserfassung', file: 'supabase/acquisition-cost-months-schema.sql' });
    if (!historyAvailable) pending.push({ what: 'Änderungsverlauf', file: 'supabase/acquisition-cost-history-schema.sql' });
    if (!rulesAvailable)   pending.push({ what: 'Kostenquellen',     file: 'supabase/acquisition-cost-rules-schema.sql' });
    if (pending.length) {
      banner.innerHTML = '<div class="alert alert-warn" style="margin:0;display:block">' +
        '<div style="font-weight:600;margin-bottom:4px">⚠️ ' +
          pending.map(function (p) { return p.what; }).join(' und ') +
          ' noch nicht aktiv – im Supabase-SQL-Editor ausführen:</div>' +
        pending.map(function (p) { return '<div><code>' + p.file + '</code></div>'; }).join('') +
      '</div>';
      banner.classList.remove('hidden');
      if (!monthsAvailable) return;   // ohne Monatstabelle gibt es nichts zu mahnen
    }

    var open = costs.filter(function (c) {
      var st = recurringStatus(c);
      return st && (st.state === 'open' || st.state === 'none');
    });
    if (!open.length) return;

    var box = document.createElement('div');
    box.className = 'alert alert-warn';
    // .alert ist flex – hier sollen Kopfzeile und Quellen untereinander stehen.
    box.style.cssText = 'margin:0;display:block';

    var head = document.createElement('div');
    head.style.cssText = 'font-weight:600;margin-bottom:6px';
    head.textContent = '⚠️ Laufende Kosten nicht aktuell – erfasst sein sollte alles bis einschließlich ' + ymText(dueYm()) + '.';
    box.appendChild(head);

    open.sort(function (a, b) { return (a.source_name || '').localeCompare(b.source_name || '', 'de'); })
      .forEach(function (cost) {
        var st  = recurringStatus(cost);
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:4px 0;border-top:1px solid rgba(146,64,14,.15)';

        var txt = document.createElement('span');
        txt.style.cssText = 'flex:1;min-width:0';
        txt.textContent = cost.source_name + ' – ' +
          (st.last
            ? 'zuletzt ' + ymText(st.last) + ' (' + st.missing + ' Monat' + (st.missing === 1 ? '' : 'e') + ' offen)'
            : 'noch kein Monat erfasst');

        var btn = document.createElement('button');
        btn.className = 'btn btn-secondary btn-sm';
        btn.style.flexShrink = '0';
        btn.textContent = 'Nachtragen';
        btn.addEventListener('click', function () { openModal(cost); });

        row.appendChild(txt);
        row.appendChild(btn);
        box.appendChild(row);
      });

    banner.appendChild(box);
    banner.classList.remove('hidden');
  }

  // Was die Bankdaten gegenüber den erfassten Monaten hergeben – als Vorschlag.
  function renderAutoBanner(costs) {
    var banner = document.getElementById('autoBanner');
    if (!banner) return;
    banner.innerHTML = '';
    banner.classList.add('hidden');
    if (!monthsAvailable || !rulesAvailable) return;

    var diffs = costs.map(autoDiffFor).filter(Boolean);
    if (!diffs.length) return;

    var box = document.createElement('div');
    box.className = 'alert alert-info';
    box.style.cssText = 'margin:0;display:block';

    var head = document.createElement('div');
    head.style.cssText = 'font-weight:600;margin-bottom:6px';
    head.textContent = 'Neue Buchungen aus der Kostenanalyse – noch nicht übernommen';
    box.appendChild(head);

    diffs.forEach(function (d) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:4px 0;border-top:1px solid rgba(55,48,163,.15)';

      // Bei vielen Monaten nur die Spanne nennen – die Einzelwerte stehen im Dialog.
      var sorted = d.changes.slice().sort(function (a, b) { return a.ym.localeCompare(b.ym); });
      var months = sorted.length > 3
        ? ymText(sorted[0].ym) + ' – ' + ymText(sorted[sorted.length - 1].ym) + ' (' + sorted.length + ' Monate)'
        : sorted.map(function (c) { return ymText(c.ym) + ': ' + (c.to ? fmt(c.to) : 'entfällt'); }).join(' · ');

      var txt = document.createElement('span');
      txt.style.cssText = 'flex:1;min-width:0';
      txt.innerHTML = '<strong>' + escHtml(d.cost.source_name) + '</strong> – ' + escHtml(months) +
        '<br><span style="opacity:.85">Betrag danach: ' + fmt(d.newTotal) +
        ' (' + (d.delta >= 0 ? '+' : '−') + fmt(Math.abs(d.delta)) + ')</span>';

      var view = document.createElement('button');
      view.className = 'btn btn-ghost btn-sm';
      view.style.flexShrink = '0';
      view.textContent = 'Ansehen';
      view.addEventListener('click', function () { openModal(d.cost); });

      var take = document.createElement('button');
      take.className = 'btn btn-secondary btn-sm';
      take.style.flexShrink = '0';
      take.textContent = 'Übernehmen';
      take.addEventListener('click', function () {
        take.disabled = true; take.textContent = '…';
        applyAutoFor(d.cost)
          .then(function () { loadData(); })
          .catch(function (e) { showError('Übernahme fehlgeschlagen: ' + e.message); take.disabled = false; take.textContent = 'Übernehmen'; });
      });

      row.appendChild(txt); row.appendChild(view); row.appendChild(take);
      box.appendChild(row);
    });

    if (diffs.length > 1) {
      var allRow = document.createElement('div');
      allRow.style.cssText = 'display:flex;justify-content:flex-end;padding-top:8px';
      var all = document.createElement('button');
      all.className = 'btn btn-primary btn-sm';
      all.textContent = 'Alle ' + diffs.length + ' übernehmen';
      all.addEventListener('click', function () {
        all.disabled = true; all.textContent = '…';
        diffs.reduce(function (p, d) { return p.then(function () { return applyAutoFor(d.cost); }); }, Promise.resolve())
          .then(function () { loadData(); })
          .catch(function (e) { showError('Übernahme fehlgeschlagen: ' + e.message); all.disabled = false; });
      });
      allRow.appendChild(all);
      box.appendChild(allRow);
    }

    banner.appendChild(box);
    banner.classList.remove('hidden');
  }

  function render(costs, revenues, links) {
    lastRenderArgs = [costs, revenues, links];
    allLinks = links;

    // Revenue column label reflects whether a date range is active
    var rangeActive = !!(filterFrom.value || filterTo.value);
    var umsatzLabel = rangeActive ? 'Umsatz (Zeitraum)' : 'Umsatz (LTD)';
    var lblA = document.getElementById('umsatzColLabel');
    var lblB = document.getElementById('umsatzColLabelType');
    if (lblA) lblA.textContent = umsatzLabel;
    if (lblB) lblB.textContent = umsatzLabel;

    var revByContact = {};
    revenues.forEach(function (row) {
      if (!revenueMonthInRange(row.year, row.month)) return;
      var key = norm(row.contact_name || '');
      revByContact[key] = (revByContact[key] || 0) + (row.total_amount || 0);
    });

    // links per cost: costId → original contact_name strings
    var linksByCostOriginal = {};
    var linksByCostNorm     = {};
    links.forEach(function (l) {
      var cid = l.acquisition_cost_id;
      if (!linksByCostOriginal[cid]) { linksByCostOriginal[cid] = []; linksByCostNorm[cid] = []; }
      linksByCostOriginal[cid].push(l.contact_name);
      linksByCostNorm[cid].push(norm(l.contact_name));
    });

    function costRevenue(costId) {
      var contacts = linksByCostNorm[costId] || [];
      var total = 0;
      contacts.forEach(function (c) { total += revByContact[c] || 0; });
      return total;
    }

    var totalCosts  = 0;
    var totalRevAcq = 0;
    applyDateFilter(costs).forEach(function (cost) {
      totalCosts  += costAmt(cost);
      totalRevAcq += costRevenue(cost.id);
    });

    document.getElementById('kpiCosts').textContent   = fmt(totalCosts);
    document.getElementById('kpiRevenue').textContent = fmt(totalRevAcq);
    var roiEl = document.getElementById('kpiRoi');
    if (totalCosts > 0) {
      var mult = totalRevAcq / totalCosts;
      roiEl.textContent = mult.toFixed(1) + '× ROI';
      roiEl.className   = 'kpi-value ' + (mult >= 1 ? 'roi-pos' : 'roi-neg');
    } else {
      roiEl.textContent = '—';
      roiEl.className   = 'kpi-value';
    }

    // Filter + Sort
    var sorted = applyDateFilter(costs);
    if (sortCol) {
      sorted.sort(function(a, b) {
        var av, bv;
        var aAmt = costAmt(a), bAmt = costAmt(b);
        if (sortCol === 'kosten') {
          av = aAmt;
          bv = bAmt;
        } else if (sortCol === 'umsatz') {
          av = costRevenue(a.id);
          bv = costRevenue(b.id);
        } else { // roi
          av = (aAmt > 0) ? costRevenue(a.id) / aAmt : -Infinity;
          bv = (bAmt > 0) ? costRevenue(b.id) / bAmt : -Infinity;
        }
        return sortDir === 'desc' ? bv - av : av - bv;
      });
    }

    acqBody.innerHTML = '';
    sorted.forEach(function (cost) {
      var linkedOriginal = linksByCostOriginal[cost.id] || [];
      var count  = linkedOriginal.length;
      var ltdRev = costRevenue(cost.id);

      var amt = costAmt(cost);

      var roiHtml;
      if (amt > 0) {
        var mult = ltdRev / amt;
        var cls  = mult >= 1 ? 'roi-pos' : 'roi-neg';
        roiHtml  = '<span class="' + cls + '">' + mult.toFixed(1) + '× ROI</span>';
      } else {
        roiHtml = ltdRev > 0
          ? '<span style="color:var(--text-secondary)">' + fmt(ltdRev) + '</span>'
          : '<span style="color:var(--text-secondary)">—</span>';
      }

      var typeLabel = TYPE_LABELS[cost.source_type] || cost.source_type || '—';
      var countHtml = count > 0
        ? '<button class="btn btn-ghost btn-sm detail-btn" style="padding:2px 8px;font-size:13px;font-weight:600">' + count + '</button>'
        : '<span style="color:var(--text-secondary)">0</span>';

      // Sichtbar machen, dass die Zahlen aus den Bankdaten kommen.
      var srcRules = rulesByCost[cost.id] || [];
      var autoChip = srcRules.length
        ? '<span class="auto-chip" title="' + escHtml('Automatisch aus der Kostenanalyse (netto):\n' +
            srcRules.map(function (r) { return '• ' + r.pattern; }).join('\n')) + '">⟳ Konto</span>'
        : '';

      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td style="font-weight:500">' + escHtml(cost.source_name) + autoChip +
          (cost.notes ? '<br><span style="font-size:11px;color:var(--text-secondary);font-weight:400">' + escHtml(cost.notes) + '</span>' : '') +
        '</td>' +
        '<td><span style="font-size:12px;background:var(--surface-hover,#f1f5f9);padding:2px 8px;border-radius:4px;border:1px solid var(--border)">' + typeLabel + '</span></td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt(amt) + '</td>' +
        trackingCell(cost) +
        '<td class="right">' + countHtml + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt(ltdRev) + '</td>' +
        '<td>' + roiHtml + '</td>' +
        '<td class="center"><div style="display:flex;gap:6px;justify-content:center">' +
          '<button class="btn btn-ghost btn-sm assign-btn" title="Kunden zuordnen">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' +
            ' Kunden</button>' +
          '<button class="btn btn-ghost btn-sm edit-btn">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
            ' Bearbeiten</button>' +
          '<button class="btn btn-danger btn-sm delete-btn">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>' +
            ' Löschen</button>' +
        '</div></td>';

      var histEl = tr.querySelector('.hist-btn');
      if (histEl) histEl.addEventListener('click', function () { openHistoryModal(cost); });
      if (count > 0) tr.querySelector('.detail-btn').addEventListener('click', function () { openDetailModal(cost, linkedOriginal); });
      tr.querySelector('.assign-btn').addEventListener('click',  function () { openAssignModal(cost); });
      tr.querySelector('.edit-btn').addEventListener('click',    function () { openModal(cost); });
      tr.querySelector('.delete-btn').addEventListener('click',  function () { openDeleteModal(cost); });
      acqBody.appendChild(tr);
    });

    allCosts = costs;
    renderAutoBanner(costs);
    renderStaleBanner(costs);
    renderUnassigned(revenues, links);
    renderTagView(applyDateFilter(costs), links, revByContact);

    renderTypeView(applyDateFilter(costs), linksByCostNorm, linksByCostOriginal, revByContact);
  }

  // Auswertung nach Unterkanal: alle Zuordnungen (Kunde × Quelle) nach ihrem
  // Tag gruppiert. So lässt sich ein gemeinsamer Kostenblock aufschlüsseln,
  // ohne die Kosten selbst zu trennen – deshalb steht hier bewusst kein ROI.
  function renderTagView(costs, links, revByContact) {
    var tagBody = document.getElementById('tagBody');
    if (!tagBody) return;

    var lblC = document.getElementById('umsatzColLabelTag');
    if (lblC) lblC.textContent = (filterFrom.value || filterTo.value) ? 'Umsatz (Zeitraum)' : 'Umsatz (LTD)';

    var costById = {};
    costs.forEach(function (c) { costById[c.id] = c; });

    var NO_TAG = '__none__';
    var byTag = {};
    links.forEach(function (l) {
      var cost = costById[l.acquisition_cost_id];
      if (!cost) return;                       // Quelle liegt außerhalb des Zeitraums
      var t = (l.tag || '').trim() || NO_TAG;
      if (!byTag[t]) byTag[t] = { revenue: 0, clients: [], sources: {} };
      byTag[t].revenue += (revByContact[norm(l.contact_name)] || 0);
      byTag[t].clients.push({ name: l.contact_name, source: cost.source_name,
                              revenue: revByContact[norm(l.contact_name)] || 0 });
      byTag[t].sources[cost.source_name] = true;
    });

    var tags = Object.keys(byTag).sort(function (a, b) {
      if (a === NO_TAG) return 1;
      if (b === NO_TAG) return -1;
      return byTag[b].revenue - byTag[a].revenue;
    });

    tagBody.innerHTML = '';
    if (!tags.length) {
      tagBody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-secondary);padding:24px">' +
        'Noch keine Zuordnungen im gewählten Zeitraum.</td></tr>';
      return;
    }

    tags.forEach(function (t) {
      var d       = byTag[t];
      var count   = d.clients.length;
      var avg     = count ? d.revenue / count : 0;
      var sources = Object.keys(d.sources).sort(function (a, b) { return a.localeCompare(b, 'de'); });
      var isNone  = t === NO_TAG;

      var tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.innerHTML =
        '<td style="font-weight:' + (isNone ? '400' : '600') + ';color:' + (isNone ? 'var(--text-secondary)' : 'var(--text)') + '">' +
          '<span class="tag-caret" style="display:inline-block;width:12px;color:var(--text-secondary)">▸</span> ' +
          (isNone ? 'Ohne Unterkanal' : escHtml(t)) +
        '</td>' +
        '<td class="right">' + count + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt(d.revenue) + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums;color:var(--text-secondary)">' + fmt(avg) + '</td>' +
        '<td style="font-size:12px;color:var(--text-secondary)">' + escHtml(sources.join(', ')) + '</td>';

      var detail = document.createElement('tr');
      detail.className = 'hidden';
      var cell = document.createElement('td');
      cell.colSpan = 5;
      cell.style.cssText = 'background:var(--bg);padding:10px 20px';
      cell.innerHTML = d.clients.slice()
        .sort(function (a, b) { return b.revenue - a.revenue; })
        .map(function (c) {
          return '<div style="display:flex;justify-content:space-between;gap:12px;padding:3px 0;font-size:13px">' +
            '<span>' + escHtml(c.name) + ' <span style="color:var(--text-secondary);font-size:11px">· ' + escHtml(c.source) + '</span></span>' +
            '<span style="font-variant-numeric:tabular-nums">' + fmt(c.revenue) + '</span>' +
          '</div>';
        }).join('');
      detail.appendChild(cell);

      tr.addEventListener('click', function () {
        var open = !detail.classList.toggle('hidden');
        tr.querySelector('.tag-caret').textContent = open ? '▾' : '▸';
      });

      tagBody.appendChild(tr);
      tagBody.appendChild(detail);
    });
  }

  function renderTypeView(costs, linksByCostNorm, linksByCostOriginal, revByContact) {
    var typeCards = document.getElementById('typeCards');
    var typeBody  = document.getElementById('typeBody');

    // Aggregate by type
    var byType = {};
    costs.forEach(function(cost) {
      var t = cost.source_type || 'sonstige';
      if (!byType[t]) byType[t] = { costs: 0, revenue: 0, clients: 0, count: 0, entries: [] };
      byType[t].costs  += costAmt(cost);
      byType[t].count  += 1;
      var linked = linksByCostNorm[cost.id] || [];
      var linkedOrig = linksByCostOriginal[cost.id] || [];
      byType[t].clients += linked.length;
      var entryRevenue = 0;
      linked.forEach(function(c) { entryRevenue += revByContact[c] || 0; });
      byType[t].revenue += entryRevenue;
      byType[t].entries.push({ cost: cost, linkedNames: linkedOrig, revenue: entryRevenue });
    });

    // Sort by revenue desc
    var types = Object.keys(byType).sort(function(a, b) {
      return byType[b].revenue - byType[a].revenue;
    });

    // Cards
    var TYPE_COLORS = {
      'messe': '#6366f1', 'online-marketing': '#0ea5e9', 'seo': '#10b981',
      'ki': '#8b5cf6', 'kaltakquise': '#f59e0b', 'empfehlung': '#ec4899', 'sonstige': '#94a3b8',
    };

    typeCards.innerHTML = '';
    types.forEach(function(t) {
      var d     = byType[t];
      var label = TYPE_LABELS[t] || t;
      var color = TYPE_COLORS[t] || '#94a3b8';
      var roi   = d.costs > 0 ? (d.revenue / d.costs).toFixed(1) + '× ROI' : (d.revenue > 0 ? fmt(d.revenue) : '—');
      var roiCls = d.costs > 0 && d.revenue >= d.costs ? 'roi-pos' : (d.costs > 0 ? 'roi-neg' : '');

      var card = document.createElement('div');
      card.className = 'kpi-card';
      card.style.borderTop = '3px solid ' + color;

      // Sort entries by costs desc
      var sortedEntries = d.entries.slice().sort(function(a, b) { return costAmt(b.cost) - costAmt(a.cost); });

      // Build activities HTML
      var activitiesHtml = '<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px;display:flex;flex-direction:column;gap:6px">';
      sortedEntries.forEach(function(entry) {
        var c = entry.cost;
        var cAmt = costAmt(c);
        var entryRoi = cAmt > 0 ? (entry.revenue / cAmt).toFixed(1) + '× ROI' : '—';
        var entryRoiCls = cAmt > 0 && entry.revenue >= cAmt ? 'roi-pos' : (cAmt > 0 ? 'roi-neg' : '');
        var clientsHtml = '';
        if (entry.linkedNames.length > 0) {
          clientsHtml = '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:3px">';
          entry.linkedNames.slice().sort(function(a,b){return a.localeCompare(b,'de');}).forEach(function(n) {
            clientsHtml += '<span style="font-size:11px;background:' + color + '22;border:1px solid ' + color + '44;border-radius:3px;padding:1px 6px;color:var(--text)">' + escHtml(n) + '</span>';
          });
          clientsHtml += '</div>';
        }
        activitiesHtml +=
          '<div style="background:var(--surface-hover,#f8fafc);border:1px solid var(--border);border-radius:6px;padding:8px 10px">' +
            '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:6px">' +
              '<span style="font-size:13px;font-weight:600;flex:1;min-width:0">' + escHtml(c.source_name) + '</span>' +
              '<span style="font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--text-secondary)">' + fmt(cAmt) + '</span>' +
              (cAmt > 0 ? '<span style="font-size:12px;font-weight:600;white-space:nowrap" class="' + entryRoiCls + '">' + entryRoi + '</span>' : '') +
            '</div>' +
            (entry.linkedNames.length > 0 ? clientsHtml : '<div style="margin-top:3px;font-size:11px;color:var(--text-secondary)">Keine Kunden zugeordnet</div>') +
          '</div>';
      });
      activitiesHtml += '</div>';

      card.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
          '<span style="font-size:13px;font-weight:700;color:' + color + '">' + escHtml(label) + '</span>' +
          '<div style="display:flex;align-items:center;gap:8px">' +
            '<span style="font-size:11px;color:var(--text-secondary)">' + d.count + ' Aktivität' + (d.count !== 1 ? 'en' : '') + '</span>' +
            '<button class="type-toggle-btn" style="background:none;border:1px solid var(--border);border-radius:4px;cursor:pointer;padding:2px 7px;font-size:12px;color:var(--text-secondary);display:flex;align-items:center;gap:3px">Details <span class="toggle-icon">▼</span></button>' +
          '</div>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
          '<div><div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.04em">Kosten</div><div style="font-size:16px;font-weight:700">' + fmt(d.costs) + '</div></div>' +
          '<div><div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.04em">Umsatz</div><div style="font-size:16px;font-weight:700">' + fmt(d.revenue) + '</div></div>' +
          '<div><div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.04em">Kunden</div><div style="font-size:16px;font-weight:700">' + d.clients + '</div></div>' +
          '<div><div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.04em">ROI</div><div style="font-size:16px;font-weight:700" class="' + roiCls + '">' + roi + '</div></div>' +
        '</div>' +
        '<div class="type-activities hidden">' + activitiesHtml + '</div>';

      // Toggle expand/collapse
      var toggleBtn = card.querySelector('.type-toggle-btn');
      var activitiesEl = card.querySelector('.type-activities');
      var toggleIcon = card.querySelector('.toggle-icon');
      toggleBtn.addEventListener('click', function() {
        var isHidden = activitiesEl.classList.contains('hidden');
        if (isHidden) {
          activitiesEl.classList.remove('hidden');
          toggleIcon.textContent = '▲';
          toggleBtn.style.color = color;
        } else {
          activitiesEl.classList.add('hidden');
          toggleIcon.textContent = '▼';
          toggleBtn.style.color = 'var(--text-secondary)';
        }
      });

      typeCards.appendChild(card);
    });

    // Table
    typeBody.innerHTML = '';
    types.forEach(function(t) {
      var d     = byType[t];
      var label = TYPE_LABELS[t] || t;
      var color = TYPE_COLORS[t] || '#94a3b8';
      var roiHtml, roiSort = 0;
      if (d.costs > 0) {
        var mult = d.revenue / d.costs;
        roiSort  = mult;
        var cls  = mult >= 1 ? 'roi-pos' : 'roi-neg';
        roiHtml  = '<span class="' + cls + '">' + mult.toFixed(1) + '× ROI</span>';
      } else {
        roiHtml = d.revenue > 0 ? fmt(d.revenue) : '<span style="color:var(--text-secondary)">—</span>';
      }
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + color + ';margin-right:8px;vertical-align:middle"></span><strong>' + escHtml(label) + '</strong></td>' +
        '<td class="right">' + d.count + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt(d.costs) + '</td>' +
        '<td class="right">' + d.clients + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt(d.revenue) + '</td>' +
        '<td>' + roiHtml + '</td>';
      typeBody.appendChild(tr);
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  loadData();
})();
