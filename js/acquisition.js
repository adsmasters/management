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

  var editingId   = null;
  var deletingId  = null;
  var assigningCost  = null;
  var assigningLinks = []; // norm(contact_name) of current links
  var allClients     = []; // sorted contact_name strings from revenue
  var allLinks       = []; // all acquisition_contact_links rows

  var assignModal       = document.getElementById('assignModal');
  var assignModalSource = document.getElementById('assignModalSource');
  var assignSearch      = document.getElementById('assignSearch');
  var assignClientList  = document.getElementById('assignClientList');
  var assignModalClose  = document.getElementById('assignModalClose');
  var assignModalCancel = document.getElementById('assignModalCancel');
  var assignModalSave   = document.getElementById('assignModalSave');

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

  // ── Modal open/close ──────────────────────────────────────────────────
  function openModal(entry) {
    editingId           = entry ? entry.id : null;
    acqModalTitle.textContent = entry ? 'Eintrag bearbeiten' : 'Neuer Eintrag';
    acqSourceInput.value = entry ? (entry.source_name || '') : '';
    acqTypeSelect.value  = entry ? (entry.source_type  || 'sonstige') : 'sonstige';
    acqAmountInput.value = entry ? (entry.amount != null ? entry.amount : '') : '';
    acqDateInput.value   = entry ? (entry.cost_date || '') : '';
    acqNotesInput.value  = entry ? (entry.notes || '') : '';
    acqModal.classList.remove('hidden');
    acqSourceInput.focus();
  }

  function closeModal() {
    acqModal.classList.add('hidden');
    editingId = null;
  }

  acqModalClose.addEventListener('click',  closeModal);
  acqModalCancel.addEventListener('click', closeModal);
  acqModal.addEventListener('click', function (e) { if (e.target === acqModal) closeModal(); });
  addEntryBtn.addEventListener('click', function () { openModal(null); });

  acqModalSave.addEventListener('click', function () {
    var source = acqSourceInput.value.trim();
    if (!source) {
      acqSourceInput.focus();
      acqSourceInput.style.borderColor = 'var(--danger)';
      return;
    }
    acqSourceInput.style.borderColor = '';

    var type   = acqTypeSelect.value;
    var amount = parseFloat(acqAmountInput.value) || 0;
    var date   = acqDateInput.value || null;
    var notes  = acqNotesInput.value.trim() || null;

    acqModalSave.disabled    = true;
    acqModalSave.textContent = 'Speichern…';

    var promise;
    if (editingId) {
      promise = window.db.acquisitionCosts.update(editingId, {
        source_name: source, source_type: type,
        amount: amount, cost_date: date, notes: notes,
        updated_at: new Date().toISOString(),
      });
    } else {
      promise = window.db.acquisitionCosts.create(source, type, amount, date, notes);
    }

    promise.then(function () {
      closeModal();
      loadData();
    }).catch(function (e) {
      showError('Fehler: ' + e.message);
      closeModal();
    }).finally(function () {
      acqModalSave.disabled    = false;
      acqModalSave.textContent = 'Speichern';
    });
  });

  // ── Delete modal ──────────────────────────────────────────────────────
  function openDeleteModal(entry) {
    deletingId = entry.id;
    deleteEntryName.textContent = entry.source_name;
    deleteModal.classList.remove('hidden');
  }

  function closeDeleteModal() {
    deleteModal.classList.add('hidden');
    deletingId = null;
  }

  deleteModalClose.addEventListener('click',   closeDeleteModal);
  deleteModalCancel.addEventListener('click',  closeDeleteModal);
  deleteModal.addEventListener('click', function (e) { if (e.target === deleteModal) closeDeleteModal(); });

  deleteModalConfirm.addEventListener('click', function () {
    deleteModalConfirm.disabled    = true;
    deleteModalConfirm.textContent = 'Löschen…';
    window.db.acquisitionCosts.delete(deletingId)
      .then(function () { closeDeleteModal(); loadData(); })
      .catch(function (e) { showError('Fehler: ' + e.message); closeDeleteModal(); })
      .finally(function () {
        deleteModalConfirm.disabled    = false;
        deleteModalConfirm.textContent = 'Endgültig löschen';
      });
  });

  // ── Assign clients modal ──────────────────────────────────────────────
  function openAssignModal(cost) {
    assigningCost = cost;
    assigningLinks = allLinks
      .filter(function (l) { return l.acquisition_cost_id === cost.id; })
      .map(function (l) { return norm(l.contact_name); });
    assignModalSource.textContent = cost.source_name;
    assignSearch.value = '';
    renderAssignList('');
    assignModal.classList.remove('hidden');
    assignSearch.focus();
  }

  function closeAssignModal() {
    assignModal.classList.add('hidden');
    assigningCost = null;
  }

  function renderAssignList(filter) {
    var f = filter.trim().toLowerCase();
    assignClientList.innerHTML = '';
    allClients.forEach(function (contactName) {
      if (f && contactName.toLowerCase().indexOf(f) === -1) return;
      var checked = assigningLinks.indexOf(norm(contactName)) !== -1;
      var row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;cursor:pointer;background:var(--surface);border:1px solid var(--border);user-select:none';
      row.innerHTML =
        '<input type="checkbox" data-name="' + escHtml(contactName) + '" ' + (checked ? 'checked' : '') + ' style="width:16px;height:16px;cursor:pointer;accent-color:var(--primary)">' +
        '<span style="font-size:14px;font-weight:500">' + escHtml(contactName) + '</span>';
      assignClientList.appendChild(row);
    });
  }

  assignSearch.addEventListener('input', function () {
    renderAssignList(assignSearch.value);
  });

  assignModalClose.addEventListener('click',  closeAssignModal);
  assignModalCancel.addEventListener('click', closeAssignModal);
  assignModal.addEventListener('click', function (e) { if (e.target === assignModal) closeAssignModal(); });

  assignModalSave.addEventListener('click', function () {
    if (!assigningCost) return;
    var costId     = assigningCost.id;
    var checkboxes = assignClientList.querySelectorAll('input[type=checkbox]');
    var updates    = [];

    checkboxes.forEach(function (cb) {
      var contactName   = cb.getAttribute('data-name');
      var isChecked     = cb.checked;
      var alreadyLinked = assigningLinks.indexOf(norm(contactName)) !== -1;

      if (isChecked && !alreadyLinked) {
        updates.push(window.db.acquisitionContactLinks.create(costId, contactName));
      } else if (!isChecked && alreadyLinked) {
        updates.push(window.db.acquisitionContactLinks.delete(costId, contactName));
      }
    });

    assignModalSave.disabled    = true;
    assignModalSave.textContent = 'Speichern…';

    Promise.all(updates)
      .then(function () { closeAssignModal(); loadData(); })
      .catch(function (e) { showError('Fehler: ' + e.message); closeAssignModal(); })
      .finally(function () {
        assignModalSave.disabled    = false;
        assignModalSave.textContent = 'Speichern';
      });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeModal(); closeDeleteModal(); closeAssignModal(); }
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

      // Build sorted unique contact names from revenue
      var contactSet = {};
      revenues.forEach(function (r) {
        if (r.contact_name) contactSet[r.contact_name] = true;
      });
      allClients = Object.keys(contactSet).sort(function (a, b) {
        return a.localeCompare(b, 'de');
      });

      if (costs.length === 0) {
        emptyState.classList.remove('hidden');
        return;
      }

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
    allLinks = links;

    // revenue per lexoffice contact_name (normalized)
    var revByContact = {};
    revenues.forEach(function (row) {
      var key = norm(row.contact_name || '');
      revByContact[key] = (revByContact[key] || 0) + (row.total_amount || 0);
    });

    // links per cost id: costId → [norm(contact_name), ...]
    var linksByCost = {};
    links.forEach(function (l) {
      if (!linksByCost[l.acquisition_cost_id]) linksByCost[l.acquisition_cost_id] = [];
      linksByCost[l.acquisition_cost_id].push(norm(l.contact_name));
    });

    function costRevenue(costId) {
      var contacts = linksByCost[costId] || [];
      var total = 0;
      contacts.forEach(function (c) { total += revByContact[c] || 0; });
      return total;
    }

    // KPIs
    var totalCosts  = 0;
    var totalRevAcq = 0;
    costs.forEach(function (cost) {
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

    // Table rows
    acqBody.innerHTML = '';
    costs.forEach(function (cost) {
      var linked = linksByCost[cost.id] || [];
      var ltdRev = costRevenue(cost.id);

      var roiHtml;
      if (cost.amount > 0) {
        var mult = ltdRev / cost.amount;
        var cls  = mult >= 1 ? 'roi-pos' : 'roi-neg';
        roiHtml  = '<span class="' + cls + '">' + mult.toFixed(1) + '× ROI</span>';
      } else {
        roiHtml = '<span style="color:var(--text-secondary)">—</span>';
      }

      var typeLabel = TYPE_LABELS[cost.source_type] || cost.source_type || '—';

      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td style="font-weight:500">' + escHtml(cost.source_name) +
          (cost.notes ? '<br><span style="font-size:11px;color:var(--text-secondary);font-weight:400">' + escHtml(cost.notes) + '</span>' : '') +
        '</td>' +
        '<td><span style="font-size:12px;background:var(--surface-hover,#f1f5f9);padding:2px 8px;border-radius:4px;border:1px solid var(--border)">' + typeLabel + '</span></td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' + fmt(cost.amount || 0) + '</td>' +
        '<td class="right">' + linked.length + '</td>' +
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

      tr.querySelector('.assign-btn').addEventListener('click',  function () { openAssignModal(cost); });
      tr.querySelector('.edit-btn').addEventListener('click',    function () { openModal(cost); });
      tr.querySelector('.delete-btn').addEventListener('click',  function () { openDeleteModal(cost); });
      acqBody.appendChild(tr);
    });
  }

  function escHtml(str) {
    return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  loadData();
})();
