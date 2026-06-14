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

  var MONTHS_LABEL = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];

  var TYPE_LABELS = {
    'messe':           'Messe',
    'online-marketing':'Online-Marketing',
    'seo':             'SEO',
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
    return costs.filter(function(c) {
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
  var viewAllBtn   = document.getElementById('viewAll');
  var viewTypeBtn  = document.getElementById('viewType');
  var viewAllPanel = document.getElementById('viewAllPanel');
  var viewTypePanel= document.getElementById('viewTypePanel');

  function setView(v) {
    currentView = v;
    if (v === 'all') {
      viewAllPanel.classList.remove('hidden');
      viewTypePanel.classList.add('hidden');
      viewAllBtn.className  = 'btn btn-primary btn-sm';
      viewTypeBtn.className = 'btn btn-secondary btn-sm';
    } else {
      viewAllPanel.classList.add('hidden');
      viewTypePanel.classList.remove('hidden');
      viewAllBtn.className  = 'btn btn-secondary btn-sm';
      viewTypeBtn.className = 'btn btn-primary btn-sm';
    }
  }

  viewAllBtn.addEventListener('click',  function() { setView('all'); });
  viewTypeBtn.addEventListener('click', function() { setView('type'); });

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
  function openModal(entry) {
    editingId = entry ? entry.id : null;
    acqModalTitle.textContent = entry ? 'Eintrag bearbeiten' : 'Neuer Eintrag';
    acqSourceInput.value = entry ? (entry.source_name || '') : '';
    acqTypeSelect.value  = entry ? (entry.source_type  || 'sonstige') : 'sonstige';
    acqAmountInput.value = entry ? (entry.amount != null ? entry.amount : '') : '';
    acqDateInput.value   = entry ? (entry.cost_date || '') : '';
    acqNotesInput.value  = entry ? (entry.notes || '') : '';
    acqModal.classList.remove('hidden');
    acqSourceInput.focus();
  }

  function closeModal() { acqModal.classList.add('hidden'); editingId = null; }

  acqModalClose.addEventListener('click',  closeModal);
  acqModalCancel.addEventListener('click', closeModal);
  acqModal.addEventListener('click', function (e) { if (e.target === acqModal) closeModal(); });
  addEntryBtn.addEventListener('click', function () { openModal(null); });

  acqModalSave.addEventListener('click', function () {
    var source = acqSourceInput.value.trim();
    if (!source) { acqSourceInput.focus(); acqSourceInput.style.borderColor = 'var(--danger)'; return; }
    acqSourceInput.style.borderColor = '';
    var type   = acqTypeSelect.value;
    var amount = parseFloat(acqAmountInput.value) || 0;
    var date   = acqDateInput.value || null;
    var notes  = acqNotesInput.value.trim() || null;
    acqModalSave.disabled    = true;
    acqModalSave.textContent = 'Speichern…';
    var promise = editingId
      ? window.db.acquisitionCosts.update(editingId, { source_name: source, source_type: type, amount: amount, cost_date: date, notes: notes, updated_at: new Date().toISOString() })
      : window.db.acquisitionCosts.create(source, type, amount, date, notes);
    promise.then(function () { closeModal(); loadData(); })
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
    allLinks.forEach(function (l) {
      if (l.acquisition_cost_id === cost.id) {
        savedLinks[norm(l.contact_name)]   = true;
        selectedSet[norm(l.contact_name)]  = true;
      }
    });

    assignModalSource.textContent = cost.source_name;
    assignSearch.value = '';
    renderAssignList('');
    assignModal.classList.remove('hidden');
    assignSearch.focus();
  }

  function closeAssignModal() { assignModal.classList.add('hidden'); assigningCost = null; }

  function renderAssignList(filter) {
    var f = filter.trim().toLowerCase();
    assignClientList.innerHTML = '';
    allClients.forEach(function (contactName) {
      if (f && contactName.toLowerCase().indexOf(f) === -1) return;
      var key     = norm(contactName);
      var checked = !!selectedSet[key];
      var row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;cursor:pointer;background:var(--surface);border:1px solid var(--border);user-select:none';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:var(--primary);flex-shrink:0';
      cb.addEventListener('change', function () {
        if (cb.checked) selectedSet[key] = true;
        else delete selectedSet[key];
      });
      var label = document.createElement('span');
      label.style.cssText = 'font-size:14px;font-weight:500';
      label.textContent = contactName;
      row.appendChild(cb);
      row.appendChild(label);
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
      if (!savedLinks[normName]) {
        // Find original casing
        var original = allClients.find(function (c) { return norm(c) === normName; }) || normName;
        updates.push(window.db.acquisitionContactLinks.create(costId, original));
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
          header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:' + (sortedMonths.length ? '8px' : '0');
          header.innerHTML =
            '<span style="font-weight:600;font-size:14px">' + escHtml(name) + '</span>' +
            '<span class="contact-total" style="font-weight:700;font-size:14px;font-variant-numeric:tabular-nums">' + fmt(total) + '</span>';
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
    if (e.key === 'Escape') { closeModal(); closeDeleteModal(); closeAssignModal(); closeDetailModal(); }
  });

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
    ])
    .then(function (results) {
      var costs    = results[0];
      var revenues = results[1];
      var links    = results[2];

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
      totalCosts  += (cost.amount || 0);
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
        if (sortCol === 'kosten') {
          av = a.amount || 0;
          bv = b.amount || 0;
        } else if (sortCol === 'umsatz') {
          av = costRevenue(a.id);
          bv = costRevenue(b.id);
        } else { // roi
          av = (a.amount > 0) ? costRevenue(a.id) / a.amount : -Infinity;
          bv = (b.amount > 0) ? costRevenue(b.id) / b.amount : -Infinity;
        }
        return sortDir === 'desc' ? bv - av : av - bv;
      });
    }

    acqBody.innerHTML = '';
    sorted.forEach(function (cost) {
      var linkedOriginal = linksByCostOriginal[cost.id] || [];
      var count  = linkedOriginal.length;
      var ltdRev = costRevenue(cost.id);

      var roiHtml;
      if (cost.amount > 0) {
        var mult = ltdRev / cost.amount;
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

      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td style="font-weight:500">' + escHtml(cost.source_name) +
          (cost.notes ? '<br><span style="font-size:11px;color:var(--text-secondary);font-weight:400">' + escHtml(cost.notes) + '</span>' : '') +
        '</td>' +
        '<td><span style="font-size:12px;background:var(--surface-hover,#f1f5f9);padding:2px 8px;border-radius:4px;border:1px solid var(--border)">' + typeLabel + '</span></td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt(cost.amount || 0) + '</td>' +
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

      if (count > 0) tr.querySelector('.detail-btn').addEventListener('click', function () { openDetailModal(cost, linkedOriginal); });
      tr.querySelector('.assign-btn').addEventListener('click',  function () { openAssignModal(cost); });
      tr.querySelector('.edit-btn').addEventListener('click',    function () { openModal(cost); });
      tr.querySelector('.delete-btn').addEventListener('click',  function () { openDeleteModal(cost); });
      acqBody.appendChild(tr);
    });

    renderTypeView(applyDateFilter(costs), linksByCostNorm, linksByCostOriginal, revByContact);
  }

  function renderTypeView(costs, linksByCostNorm, linksByCostOriginal, revByContact) {
    var typeCards = document.getElementById('typeCards');
    var typeBody  = document.getElementById('typeBody');

    // Aggregate by type
    var byType = {};
    costs.forEach(function(cost) {
      var t = cost.source_type || 'sonstige';
      if (!byType[t]) byType[t] = { costs: 0, revenue: 0, clients: 0, count: 0, entries: [] };
      byType[t].costs  += (cost.amount || 0);
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
      'kaltakquise': '#f59e0b', 'empfehlung': '#ec4899', 'sonstige': '#94a3b8',
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
      var sortedEntries = d.entries.slice().sort(function(a, b) { return (b.cost.amount || 0) - (a.cost.amount || 0); });

      // Build activities HTML
      var activitiesHtml = '<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px;display:flex;flex-direction:column;gap:6px">';
      sortedEntries.forEach(function(entry) {
        var c = entry.cost;
        var entryRoi = c.amount > 0 ? (entry.revenue / c.amount).toFixed(1) + '× ROI' : '—';
        var entryRoiCls = c.amount > 0 && entry.revenue >= c.amount ? 'roi-pos' : (c.amount > 0 ? 'roi-neg' : '');
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
              '<span style="font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--text-secondary)">' + fmt(c.amount || 0) + '</span>' +
              (c.amount > 0 ? '<span style="font-size:12px;font-weight:600;white-space:nowrap" class="' + entryRoiCls + '">' + entryRoi + '</span>' : '') +
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
