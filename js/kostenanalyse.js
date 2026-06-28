/* ===========================================================================
 * kostenanalyse.js – UI-Controller für die Kostenanalyse-Seite.
 * Nutzt window.db.cost (Supabase) und window.CostEngine (Parsing/Logik).
 * =========================================================================== */
(function () {
  'use strict';

  var E = window.CostEngine;
  var MONTHS = window.MONTHS_DE;

  var state = {
    categoryRules: [], vatRules: [], excludeRules: [],
    settings: {},            // category → include_in_profit
    transactions: [],
    imports: [],
    revenueByMonth: {},      // 'YYYY-MM' → Umsatz (Lexoffice, Ausschlüsse berücksichtigt)
  };

  // ── Hilfen ─────────────────────────────────────────────────────────────────
  var eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  function fmt(n) { return eur.format(Number(n) || 0); }
  function pct(n) { return (Number(n) || 0).toFixed(1).replace('.', ',') + ' %'; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function monthLabel(y, m) { return MONTHS[m - 1] + ' ' + y; }

  function hashStr(str) {                 // djb2 – stabiler Datei-Fingerprint
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return 'h' + (h >>> 0).toString(36) + '_' + str.length;
  }
  function readFile(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = rej;
      r.readAsText(file, 'utf-8');
    });
  }
  function detectSource(text) {
    var head = (text || '').slice(0, 300).toLowerCase();
    if (head.indexOf('auftragskonto') !== -1 || head.indexOf('buchungstag') !== -1) return 'kreissparkasse';
    if (head.indexOf('beschreibung') !== -1 && head.indexOf('betrag') !== -1) return 'amex';
    return null;
  }
  function rulesObj() {
    return { categoryRules: state.categoryRules, vatRules: state.vatRules, excludeRules: state.excludeRules };
  }
  function isExcludedRevenue(name) {
    var kws = (localStorage.getItem('revenueExcludeKeywords') || '')
      .split('\n').map(function (k) { return k.trim().toLowerCase(); }).filter(Boolean);
    var n = (name || '').toLowerCase();
    return kws.some(function (k) { return n.indexOf(k) !== -1; });
  }

  function showError(msg) {
    el('loading').style.display = 'none';
    var e = el('error'); e.style.display = ''; e.textContent = 'Fehler: ' + msg;
  }

  // ── Laden ──────────────────────────────────────────────────────────────────
  function loadAll() {
    return Promise.all([
      window.db.cost.categoryRules.list(),
      window.db.cost.vatRules.list(),
      window.db.cost.excludeRules.list(),
      window.db.cost.categorySettings.list(),
      window.db.cost.transactions.all(),
      window.db.cost.imports.list(),
    ]).then(function (r) {
      state.categoryRules = r[0] || [];
      state.vatRules      = r[1] || [];
      state.excludeRules  = r[2] || [];
      state.settings = {};
      (r[3] || []).forEach(function (s) { state.settings[s.category] = s.include_in_profit; });
      state.transactions = r[4] || [];
      state.imports      = r[5] || [];
      return loadRevenue();
    });
  }

  // Umsatz (Lexoffice) für alle Monate mit Kostenbuchungen.
  function loadRevenue() {
    var months = {};
    state.transactions.forEach(function (t) { months[t.year + '-' + pad2(t.month)] = { y: t.year, m: t.month }; });
    var keys = Object.keys(months);
    return Promise.all(keys.map(function (k) {
      return window.db.revenue.forMonth(months[k].y, months[k].m).catch(function () { return []; });
    })).then(function (results) {
      state.revenueByMonth = {};
      keys.forEach(function (k, i) {
        var sum = 0;
        (results[i] || []).forEach(function (row) {
          if (isExcludedRevenue(row.contact_name)) return;
          sum += Number(row.total_amount) || 0;
        });
        state.revenueByMonth[k] = sum;
      });
    });
  }

  // ── Übersicht ──────────────────────────────────────────────────────────────
  function renderOverview() {
    var byMonth = E.summarize(state.transactions, state.settings);
    var keys = Object.keys(byMonth).concat(Object.keys(state.revenueByMonth))
      .filter(function (v, i, a) { return a.indexOf(v) === i; }).sort();

    var totRev = 0, totCost = 0, totMemo = 0;
    var rowsHtml = '';
    keys.forEach(function (k) {
      var b = byMonth[k] || { costNet: 0, memoNet: 0, byCategory: {}, uncategorizedCount: 0, year: +k.slice(0, 4), month: +k.slice(5) };
      var rev = state.revenueByMonth[k] || 0;
      var cost = b.costNet, profit = rev - cost, margin = rev ? profit / rev * 100 : 0;
      totRev += rev; totCost += cost; totMemo += b.memoNet;
      var cats = Object.keys(b.byCategory).sort(function (a, c) { return b.byCategory[c] - b.byCategory[a]; });
      var detail = cats.map(function (c) {
        var off = state.settings[c] === false;
        return '<tr class="cat-detail" data-detail="' + k + '" style="display:none"><td>' + esc(c) +
          (off ? ' <span class="pill">Memo</span>' : '') +
          '</td><td colspan="3"></td><td class="num">' + fmt(b.byCategory[c]) + '</td></tr>';
      }).join('');
      var warn = b.uncategorizedCount ? ' <span class="pill" style="background:var(--danger-bg);color:#991b1b">' + b.uncategorizedCount + ' unkat.</span>' : '';
      rowsHtml +=
        '<tr class="month-row" data-k="' + k + '">' +
          '<td>' + esc(monthLabel(b.year, b.month)) + warn + '</td>' +
          '<td class="num revenue">' + fmt(rev) + '</td>' +
          '<td class="num cost">' + fmt(cost) + '</td>' +
          '<td class="num ' + (profit >= 0 ? 'pos' : 'neg') + '">' + fmt(profit) + '</td>' +
          '<td class="num ' + (profit >= 0 ? 'pos' : 'neg') + '">' + (rev ? pct(margin) : '—') + '</td>' +
        '</tr>' + detail;
    });

    el('overviewTable').innerHTML =
      '<thead><tr><th>Monat</th><th>Umsatz</th><th>Kosten (netto)</th><th>Gewinn v. St.</th><th>Marge</th></tr></thead>' +
      '<tbody>' + (rowsHtml || '<tr><td colspan="5" class="muted">Noch keine Kostenbuchungen importiert.</td></tr>') + '</tbody>';

    var totProfit = totRev - totCost;
    el('kpis').innerHTML =
      kpi('Umsatz', fmt(totRev), '') +
      kpi('Kosten (netto)', fmt(totCost), '') +
      kpi('Gewinn vor Steuern', fmt(totProfit), totProfit >= 0 ? 'pos' : 'neg') +
      kpi('Marge', totRev ? pct(totProfit / totRev * 100) : '—', totProfit >= 0 ? 'pos' : 'neg') +
      kpi('Steuern/USt (Memo)', fmt(totMemo), '');

    Array.prototype.forEach.call(document.querySelectorAll('#overviewTable tr.month-row'), function (tr) {
      tr.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.cat-detail[data-detail="' + tr.dataset.k + '"]'), function (d) {
          d.style.display = d.style.display === 'none' ? '' : 'none';
        });
      });
    });
  }
  function kpi(label, value, cls) {
    return '<div class="kpi-card"><div class="kpi-label">' + label + '</div><div class="kpi-value ' + (cls || '') + '">' + value + '</div></div>';
  }

  // ── Import ─────────────────────────────────────────────────────────────────
  function renderImports() {
    var rows = state.imports.map(function (im) {
      return '<tr><td>' + esc(im.period_label || '–') + '</td><td>' + esc(im.source) + '</td>' +
        '<td>' + esc(im.filename || '') + '</td><td class="num">' + im.row_count + '</td>' +
        '<td class="num muted">' + im.skipped_count + '</td>' +
        '<td class="right"><button class="btn btn-ghost btn-sm" data-del-import="' + im.id + '">löschen</button></td></tr>';
    }).join('');
    el('importsTable').innerHTML =
      '<thead><tr><th>Zeitraum</th><th>Quelle</th><th>Datei</th><th>Neu</th><th>Duplikate</th><th></th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="6" class="muted">Noch nichts importiert.</td></tr>') + '</tbody>';
    Array.prototype.forEach.call(document.querySelectorAll('[data-del-import]'), function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Diesen Import samt zugehörigen Buchungen löschen?')) return;
        window.db.cost.imports.delete(b.dataset.delImport).then(reloadAndRender).catch(function (e) { alert(e.message); });
      });
    });
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    var override = el('importSource').value;
    var preview = el('importPreview');
    preview.innerHTML = '<div class="muted">Verarbeite …</div>';

    var summaries = [];
    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        return readFile(file).then(function (text) {
          var source = override === 'auto' ? detectSource(text) : override;
          if (!source) { summaries.push('⚠️ ' + esc(file.name) + ': Quelle nicht erkannt – bitte oben manuell wählen.'); return; }
          var parsed = E.parseCsv(text, source);
          if (!parsed.length) { summaries.push('⚠️ ' + esc(file.name) + ': keine Buchungen gefunden.'); return; }
          var enriched = E.assignDedupHashes(E.enrichAll(parsed, rulesObj()));
          var fileHash = hashStr(text);
          var dates = enriched.map(function (t) { return t.tx_date; }).sort();
          var period = monthFromIso(dates[0]) + ' – ' + monthFromIso(dates[dates.length - 1]);
          var rows = enriched.map(function (t) {
            return { tx_date: t.tx_date, year: t.year, month: t.month, source: t.source,
              description: t.description, payee: t.payee, purpose: t.purpose, booking_text: t.booking_text,
              amount_gross: t.amount_gross, category: t.category, vat_rate: t.vat_rate,
              vat_amount: t.vat_amount, amount_net: t.amount_net, excluded: t.excluded,
              exclude_reason: t.exclude_reason, dedup_hash: t.dedup_hash };
          });
          return window.db.cost.imports.findByHash(fileHash).then(function (dupes) {
            var warnDup = (dupes && dupes.length) ? ' (Datei war schon mal importiert – Duplikate werden übersprungen)' : '';
            return window.db.cost.imports.create(source, file.name, fileHash, 0, 0, period).then(function (imp) {
              rows.forEach(function (r) { r.import_id = imp.id; });
              return window.db.cost.transactions.insertMany(rows).then(function (inserted) {
                var ins = (inserted || []).length, skip = rows.length - ins;
                return window.db.cost.imports.update(imp.id, { row_count: ins, skipped_count: skip }).then(function () {
                  summaries.push('✅ ' + esc(file.name) + ' (' + source + '): ' + ins + ' neu, ' + skip + ' Duplikate' + warnDup);
                });
              });
            });
          });
        });
      });
    });

    chain.then(reloadData).then(function () {
      preview.innerHTML = '<div class="alert alert-success">' + summaries.join('<br>') + '</div>';
      renderImports(); renderOverview(); renderMissing(); renderCategories();
      el('csvFile').value = '';
    }).catch(function (e) { preview.innerHTML = '<div class="alert alert-danger">Fehler: ' + esc(e.message) + '</div>'; });
  }
  function monthFromIso(iso) { var p = (iso || '').split('-'); return p.length === 3 ? MONTHS[+p[1] - 1] + ' ' + p[0] : iso; }

  // ── Unkategorisiert ────────────────────────────────────────────────────────
  function renderMissing() {
    var groups = {};
    state.transactions.forEach(function (t) {
      if (t.category != null || t.excluded) return;
      var key = E.norm(t.payee || t.description).slice(0, 50);
      (groups[key] = groups[key] || { sample: t, sum: 0, count: 0 });
      groups[key].sum += Number(t.amount_net != null ? t.amount_net : t.amount_gross) || 0;
      groups[key].count++;
    });
    var keys = Object.keys(groups).sort(function (a, b) { return groups[b].sum - groups[a].sum; });
    el('missingCount').textContent = keys.length;

    var rows = keys.map(function (k, i) {
      var g = groups[k];
      var suggest = esc((g.sample.payee || g.sample.description || '').split('|')[0].trim().slice(0, 40));
      return '<tr><td>' + esc(g.sample.description.slice(0, 70)) + '</td>' +
        '<td class="num">' + g.count + '</td><td class="num cost">' + fmt(g.sum) + '</td>' +
        '<td class="right"><input id="mp' + i + '" class="miss-pat" data-i="' + i + '" value="' + suggest + '" size="18" style="padding:5px 7px;border:1px solid var(--border);border-radius:6px">' +
        ' → <input id="mc' + i + '" class="miss-cat" data-i="' + i + '" placeholder="Kategorie" size="16" list="catList" style="padding:5px 7px;border:1px solid var(--border);border-radius:6px">' +
        ' <button class="btn btn-primary btn-sm" data-assign="' + i + '">anlegen</button></td></tr>';
    }).join('');
    el('missingTable').innerHTML =
      '<thead><tr><th>Beispiel-Buchung</th><th>Anzahl</th><th>Summe</th><th class="right">Regel anlegen (enthält → Kategorie)</th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="4" class="muted">Alles kategorisiert 🎉</td></tr>') + '</tbody>';

    Array.prototype.forEach.call(document.querySelectorAll('[data-assign]'), function (b) {
      b.addEventListener('click', function () {
        var i = b.dataset.assign;
        var pattern = el('mp' + i).value.trim(), category = el('mc' + i).value.trim();
        if (!pattern || !category) { alert('Bitte Text und Kategorie angeben.'); return; }
        b.disabled = true;
        window.db.cost.categoryRules.add('contains', pattern, category)
          .then(function () { return reapplyRules(); })
          .then(reloadAndRender)
          .catch(function (e) { alert(e.message); b.disabled = false; });
      });
    });
  }

  // ── Regeln ─────────────────────────────────────────────────────────────────
  function renderRules() {
    // Kategorie-Regeln
    el('catRulesTable').innerHTML = ruleTable(state.categoryRules, function (r) {
      return '<td>' + esc(r.match_type) + '</td><td>' + esc(r.pattern) + '</td><td>' + esc(r.category) + '</td>';
    }, 'cat', ['Typ', 'Text', 'Kategorie']);
    // MwSt
    el('vatRulesTable').innerHTML = ruleTable(state.vatRules, function (r) {
      return '<td>' + esc(r.match_type) + '</td><td>' + esc(r.pattern) + '</td><td class="num">' + (Number(r.vat_rate) * 100).toFixed(0) + ' %</td>';
    }, 'vat', ['Typ', 'Lieferant', 'MwSt']);
    // Ausschluss
    el('excRulesTable').innerHTML = ruleTable(state.excludeRules, function (r) {
      return '<td>' + esc(r.match_type) + '</td><td>' + esc(r.pattern) + (r.builtin ? ' <span class="pill">System</span>' : '') +
        '</td><td>' + esc(r.reason || '') + '</td>';
    }, 'exc', ['Typ', 'Text', 'Grund']);

    // datalist Kategorien
    var cats = {};
    state.categoryRules.forEach(function (r) { cats[r.category] = 1; });
    Object.keys(state.settings).forEach(function (c) { cats[c] = 1; });
    el('catList').innerHTML = Object.keys(cats).sort().map(function (c) { return '<option value="' + esc(c) + '">'; }).join('');

    bindDelete('cat', window.db.cost.categoryRules);
    bindDelete('vat', window.db.cost.vatRules);
    bindDelete('exc', window.db.cost.excludeRules);
  }
  function ruleTable(rules, cells, ns, headers) {
    var body = rules.map(function (r) {
      return '<tr>' + cells(r) + '<td class="right">' +
        (r.builtin ? '<span class="muted">–</span>' : '<button class="btn btn-ghost btn-sm" data-del-' + ns + '="' + r.id + '">löschen</button>') +
        '</td></tr>';
    }).join('');
    return '<thead><tr><th>' + headers.join('</th><th>') + '</th><th></th></tr></thead><tbody>' +
      (body || '<tr><td colspan="' + (headers.length + 1) + '" class="muted">Keine Regeln.</td></tr>') + '</tbody>';
  }
  function bindDelete(ns, api) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-del-' + ns + ']'), function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Regel löschen? (greift erst nach „Regeln neu anwenden")')) return;
        api.delete(b.dataset['del' + ns.charAt(0).toUpperCase() + ns.slice(1)]).then(reloadAndRender).catch(function (e) { alert(e.message); });
      });
    });
  }

  // ── Kategorien (Schalter) ──────────────────────────────────────────────────
  function renderCategories() {
    var cats = {};
    state.transactions.forEach(function (t) { if (t.category) cats[t.category] = (cats[t.category] || 0); });
    state.categoryRules.forEach(function (r) { cats[r.category] = cats[r.category] || 0; });
    Object.keys(state.settings).forEach(function (c) { cats[c] = cats[c] || 0; });
    // Netto-Summe je Kategorie (nicht ausgeschlossen)
    state.transactions.forEach(function (t) {
      if (t.excluded || !t.category) return;
      cats[t.category] = (cats[t.category] || 0) + (Number(t.amount_net) || 0);
    });
    var names = Object.keys(cats).sort();
    el('categoriesList').innerHTML = names.length ? names.map(function (c) {
      var on = state.settings[c] !== false;
      return '<div class="toggle-row"><div><strong>' + esc(c) + '</strong> <span class="muted">' + fmt(cats[c]) + '</span></div>' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
        '<input type="checkbox" data-cat="' + esc(c) + '"' + (on ? ' checked' : '') + '> ' +
        '<span class="' + (on ? '' : 'muted') + '">' + (on ? 'zählt als Kosten' : 'nur Memo') + '</span></label></div>';
    }).join('') : '<div class="muted">Noch keine Kategorien.</div>';

    Array.prototype.forEach.call(document.querySelectorAll('[data-cat]'), function (cb) {
      cb.addEventListener('change', function () {
        window.db.cost.categorySettings.set(cb.dataset.cat, cb.checked).then(function () {
          state.settings[cb.dataset.cat] = cb.checked;
          renderOverview(); renderCategories();
        }).catch(function (e) { alert(e.message); });
      });
    });
  }

  // ── Regeln neu anwenden ────────────────────────────────────────────────────
  function reapplyRules() {
    var rules = rulesObj();
    var updates = state.transactions.map(function (t) {
      var en = E.enrich(t, rules);
      return Object.assign({}, t, {
        category: en.category, vat_rate: en.vat_rate, vat_amount: en.vat_amount,
        amount_net: en.amount_net, excluded: en.excluded, exclude_reason: en.exclude_reason,
        updated_at: new Date().toISOString(),
      });
    });
    if (!updates.length) return Promise.resolve();
    // In Blöcken upserten (Supabase-Limit schonen)
    var chunks = [];
    for (var i = 0; i < updates.length; i += 200) chunks.push(updates.slice(i, i + 200));
    return chunks.reduce(function (p, c) {
      return p.then(function () { return window.db.cost.transactions.bulkUpsert(c); });
    }, Promise.resolve());
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────
  function reloadData() { return loadAll(); }
  function reloadAndRender() { return loadAll().then(renderAll); }
  function renderAll() { renderOverview(); renderImports(); renderMissing(); renderRules(); renderCategories(); }

  function switchTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.ka-tab'), function (t) {
      t.classList.toggle('active', t.dataset.tab === name); });
    Array.prototype.forEach.call(document.querySelectorAll('.ka-panel'), function (p) {
      p.classList.toggle('active', p.dataset.panel === name); });
  }

  function bindStatic() {
    Array.prototype.forEach.call(document.querySelectorAll('.ka-tab'), function (t) {
      t.addEventListener('click', function () { switchTab(t.dataset.tab); });
    });
    el('csvFile').addEventListener('change', function (e) { handleFiles(e.target.files); });
    var dz = el('dropzone');
    ['dragover', 'dragenter'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.style.borderColor = 'var(--primary,#2563eb)'; }); });
    ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.style.borderColor = 'var(--border)'; }); });
    dz.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files); });

    el('reapplyBtn').addEventListener('click', function () {
      el('reapplyBtn').disabled = true; el('reapplyBtn').textContent = '↻ wird angewendet …';
      reapplyRules().then(reloadAndRender).then(function () {
        el('reapplyBtn').disabled = false; el('reapplyBtn').textContent = '↻ Regeln neu anwenden';
      }).catch(function (e) { alert(e.message); el('reapplyBtn').disabled = false; el('reapplyBtn').textContent = '↻ Regeln neu anwenden'; });
    });

    // Sammel-Anlegen: alle Zeilen mit ausgefüllter Kategorie auf einmal
    el('missingBulkBtn').addEventListener('click', function () {
      var toAdd = [], seen = {};
      Array.prototype.forEach.call(document.querySelectorAll('#missingTable .miss-cat'), function (cInp) {
        var i = cInp.dataset.i;
        var pInp = document.getElementById('mp' + i);
        var pattern = pInp ? pInp.value.trim() : '';
        var category = cInp.value.trim();
        if (!pattern || !category) return;
        var key = pattern.toLowerCase() + '|' + category;
        if (seen[key]) return; seen[key] = 1;
        toAdd.push({ match_type: 'contains', pattern: pattern, category: category });
      });
      if (!toAdd.length) { alert('Trage zuerst bei mindestens einer Zeile eine Kategorie ein.'); return; }
      if (!confirm(toAdd.length + ' Regel(n) anlegen und auf alle Buchungen anwenden?')) return;
      var btn = el('missingBulkBtn'); btn.disabled = true; btn.textContent = '… wird angelegt';
      window.db.cost.categoryRules.addMany(toAdd)
        .then(function () { return reapplyRules(); })
        .then(reloadAndRender)
        .then(function () { switchTab('missing'); btn.disabled = false; btn.textContent = '✓ Alle ausgefüllten anlegen'; })
        .catch(function (e) { alert(e.message); btn.disabled = false; btn.textContent = '✓ Alle ausgefüllten anlegen'; });
    });

    // Kategorie in alle noch leeren Felder übernehmen (nur lokal, kein Speichern)
    el('missingFillBtn').addEventListener('click', function () {
      var val = el('missingFillAll').value.trim();
      if (!val) { alert('Bitte oben eine Kategorie eingeben.'); return; }
      var n = 0;
      Array.prototype.forEach.call(document.querySelectorAll('#missingTable .miss-cat'), function (c) {
        if (!c.value.trim()) { c.value = val; n++; }
      });
      el('missingBulkHint').textContent = n + ' Felder gefüllt – jetzt „Alle ausgefüllten anlegen".';
    });

    el('catRuleAdd').addEventListener('click', function () {
      var p = el('catRulePattern').value.trim(), c = el('catRuleCategory').value.trim();
      if (!p || !c) return alert('Text und Kategorie angeben.');
      window.db.cost.categoryRules.add(el('catRuleType').value, p, c).then(function () {
        el('catRulePattern').value = ''; el('catRuleCategory').value = ''; return reloadAndRender();
      }).catch(function (e) { alert(e.message); });
    });
    el('vatRuleAdd').addEventListener('click', function () {
      var p = el('vatRulePattern').value.trim(), rate = parseFloat((el('vatRuleRate').value || '').replace(',', '.'));
      if (!p || !isFinite(rate)) return alert('Lieferant und MwSt-Satz angeben.');
      window.db.cost.vatRules.add(el('vatRuleType').value, p, rate / 100).then(function () {
        el('vatRulePattern').value = ''; el('vatRuleRate').value = ''; return reloadAndRender();
      }).catch(function (e) { alert(e.message); });
    });
    el('excRuleAdd').addEventListener('click', function () {
      var p = el('excRulePattern').value.trim(), reason = el('excRuleReason').value.trim();
      if (!p) return alert('Text angeben.');
      window.db.cost.excludeRules.add(el('excRuleType').value, p, reason).then(function () {
        el('excRulePattern').value = ''; el('excRuleReason').value = ''; return reloadAndRender();
      }).catch(function (e) { alert(e.message); });
    });
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  function init() {
    bindStatic();
    loadAll().then(function () {
      el('loading').style.display = 'none';
      el('app').style.display = '';
      renderAll();
    }).catch(function (e) { showError(e.message); });
  }

  // Auth lädt asynchron; wir starten direkt (RLS erlaubt Lesen). Kurzer Delay,
  // damit Supabase-Client/db bereit sind.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
