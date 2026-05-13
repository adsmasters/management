(function () {
  'use strict';

  var tbody          = document.getElementById('clientsBody');
  var tableWrap      = document.getElementById('tableWrap');
  var loadingEl      = document.getElementById('loading');
  var errorEl        = document.getElementById('error');
  var setupHint      = document.getElementById('setupHint');
  var emptyState     = document.getElementById('emptyState');
  var addClientBtn   = document.getElementById('addClientBtn');

  var clientModal        = document.getElementById('clientModal');
  var clientModalTitle   = document.getElementById('clientModalTitle');
  var clientNameInput    = document.getElementById('clientNameInput');
  var clientAmInput      = document.getElementById('clientAmInput');
  var clientAdvInput     = document.getElementById('clientAdvInput');
  var clientAmEmpSelect  = document.getElementById('clientAmEmpSelect');
  var clientAdvEmpSelect = document.getElementById('clientAdvEmpSelect');
  var clientStartInput   = document.getElementById('clientStartInput');
  var clientEndInput     = document.getElementById('clientEndInput');
  var clientIsProject    = document.getElementById('clientIsProject');
  var projectEndField    = document.getElementById('projectEndField');

  // Show/hide project end field based on checkbox
  clientIsProject.addEventListener('change', function () {
    projectEndField.style.display = clientIsProject.checked ? '' : 'none';
    if (!clientIsProject.checked) clientEndInput.value = '';
  });
  var clientLexofficeName = document.getElementById('clientLexofficeName');
  var clientModalClose   = document.getElementById('clientModalClose');
  var clientModalCancel  = document.getElementById('clientModalCancel');
  var clientModalSave    = document.getElementById('clientModalSave');

  var deleteModal        = document.getElementById('deleteModal');
  var deleteClientName   = document.getElementById('deleteClientName');
  var deleteModalClose   = document.getElementById('deleteModalClose');
  var deleteModalCancel  = document.getElementById('deleteModalCancel');
  var deleteModalConfirm = document.getElementById('deleteModalConfirm');

  var editingClientId  = null;
  var deletingClientId = null;
  var allEmployees     = [];
  var selectedIds      = new Set();

  // ── Bulk action bar ───────────────────────────────────────────────────
  var bulkBar = document.createElement('div');
  bulkBar.id        = 'bulkBar';
  bulkBar.className = 'bulk-bar hidden';
  bulkBar.innerHTML =
    '<span id="bulkCount"></span>' +
    '<button id="bulkDeleteBtn" class="btn btn-danger btn-sm">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>' +
      ' Ausgewählte löschen' +
    '</button>' +
    '<button id="bulkCancelBtn" class="btn btn-ghost btn-sm">Abbrechen</button>';
  document.querySelector('.page-header').after(bulkBar);

  var bulkCount     = document.getElementById('bulkCount');
  var bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
  var bulkCancelBtn = document.getElementById('bulkCancelBtn');

  function updateBulkBar() {
    if (selectedIds.size > 0) {
      bulkCount.textContent = selectedIds.size + ' ausgewählt';
      bulkBar.classList.remove('hidden');
    } else {
      bulkBar.classList.add('hidden');
    }
  }

  function clearSelection() {
    selectedIds.clear();
    tbody.querySelectorAll('.row-check').forEach(function (cb) { cb.checked = false; });
    var selectAll = document.getElementById('selectAll');
    if (selectAll) selectAll.checked = false;
    updateBulkBar();
  }

  bulkCancelBtn.addEventListener('click', clearSelection);

  bulkDeleteBtn.addEventListener('click', function () {
    if (!selectedIds.size) return;
    deleteClientName.textContent = selectedIds.size + ' Kunden';
    deletingClientId = null; // signals bulk mode
    deleteModal.classList.remove('hidden');
  });

  // ── Load employees for dropdowns ──────────────────────────────────────
  function loadEmployees() {
    return window.db.employees.listActive().then(function (emps) {
      allEmployees = emps;
      populateEmpDropdowns();
    });
  }

  function populateEmpDropdowns() {
    [clientAmEmpSelect, clientAdvEmpSelect].forEach(function (sel) {
      while (sel.options.length > 1) sel.remove(1);
      allEmployees.forEach(function (e) {
        var o = document.createElement('option');
        o.value       = e.id;
        o.textContent = e.name + ' (' + window.getRoleShort(e.role) + ')';
        sel.appendChild(o);
      });
    });
  }

  // ── Client modal ──────────────────────────────────────────────────────
  function openClientModal(client) {
    editingClientId = client ? client.id : null;
    clientModalTitle.textContent = client ? 'Kunde bearbeiten' : 'Neuer Kunde';
    clientNameInput.value = client ? client.name       : '';
    clientAmInput.value   = client && client.am_budget  != null ? client.am_budget  : '';
    clientAdvInput.value  = client && client.adv_budget != null ? client.adv_budget : '';
    clientAmEmpSelect.value  = (client && client.am_employee_id)  || '';
    clientAdvEmpSelect.value = (client && client.adv_employee_id) || '';
    clientStartInput.value   = (client && client.contract_start)
      ? client.contract_start.substring(0, 7) : '';
    clientIsProject.checked  = !!(client && client.is_project);
    clientEndInput.value     = (client && client.project_end)
      ? client.project_end.substring(0, 7) : '';
    clientLexofficeName.value = (client && client.lexoffice_name) || '';
    projectEndField.style.display = clientIsProject.checked ? '' : 'none';
    clientModal.classList.remove('hidden');
    clientNameInput.focus();
  }
  function closeClientModal() { clientModal.classList.add('hidden'); editingClientId = null; }
  clientModalClose.addEventListener('click',  closeClientModal);
  clientModalCancel.addEventListener('click', closeClientModal);
  clientModal.addEventListener('click', function (e) { if (e.target === clientModal) closeClientModal(); });
  clientNameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') clientModalSave.click(); });

  clientModalSave.addEventListener('click', function () {
    var name = clientNameInput.value.trim();
    if (!name) { clientNameInput.focus(); clientNameInput.style.borderColor = 'var(--danger)'; return; }
    clientNameInput.style.borderColor = '';

    var am     = parseFloat(clientAmInput.value)  || null;
    var adv    = parseFloat(clientAdvInput.value) || null;
    var amEmp  = clientAmEmpSelect.value  || null;
    var advEmp = clientAdvEmpSelect.value || null;
    // Store as "YYYY-MM-01" date string (Postgres date column)
    var contractStart  = clientStartInput.value ? clientStartInput.value + '-01' : null;
    var isProject      = clientIsProject.checked;
    var projectEnd     = (isProject && clientEndInput.value) ? clientEndInput.value + '-01' : null;
    var lexofficeName  = clientLexofficeName.value.trim() || null;

    clientModalSave.disabled    = true;
    clientModalSave.textContent = 'Speichern…';

    var fields = { name: name, am_budget: am, adv_budget: adv,
                   am_employee_id: amEmp, adv_employee_id: advEmp,
                   contract_start: contractStart,
                   is_project: isProject, project_end: projectEnd,
                   lexoffice_name: lexofficeName };
    var promise = editingClientId
      ? window.db.clients.update(editingClientId, fields)
      : window.db.clients.create(name, am, adv, amEmp, advEmp, contractStart, isProject, projectEnd, lexofficeName);

    promise.then(function () {
      closeClientModal();
      loadClients();
    }).catch(function (e) {
      errorEl.innerHTML = '<div class="alert alert-danger">⚠️ Fehler: ' + e.message + '</div>';
      closeClientModal();
    }).finally(function () {
      clientModalSave.disabled    = false;
      clientModalSave.textContent = 'Speichern';
    });
  });

  // ── Delete modal ──────────────────────────────────────────────────────
  function openDeleteModal(client) {
    deletingClientId = client.id;
    deleteClientName.textContent = client.name;
    deleteModal.classList.remove('hidden');
  }
  function closeDeleteModal() { deleteModal.classList.add('hidden'); deletingClientId = null; }
  deleteModalClose.addEventListener('click',  closeDeleteModal);
  deleteModalCancel.addEventListener('click', closeDeleteModal);
  deleteModal.addEventListener('click', function (e) { if (e.target === deleteModal) closeDeleteModal(); });

  deleteModalConfirm.addEventListener('click', function () {
    deleteModalConfirm.disabled    = true;
    deleteModalConfirm.textContent = 'Löschen…';

    // Bulk or single
    var ids = deletingClientId ? [deletingClientId] : Array.from(selectedIds);
    Promise.all(ids.map(function (id) { return window.db.clients.delete(id); }))
      .then(function () { closeDeleteModal(); clearSelection(); loadClients(); })
      .catch(function (e) {
        errorEl.innerHTML = '<div class="alert alert-danger">⚠️ Fehler: ' + e.message + '</div>';
        closeDeleteModal();
      })
      .finally(function () {
        deleteModalConfirm.disabled    = false;
        deleteModalConfirm.textContent = 'Endgültig löschen';
      });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeClientModal(); closeDeleteModal(); }
  });

  // ── Load & render ─────────────────────────────────────────────────────
  function loadClients() {
    loadingEl.innerHTML = '<div class="loading-bar"><div class="spinner"></div>Kunden werden geladen…</div>';
    loadingEl.classList.remove('hidden');
    tableWrap.classList.add('hidden');
    emptyState.classList.add('hidden');
    clearSelection();

    window.db.clients.list()
      .then(function (clients) {
        loadingEl.classList.add('hidden');
        if (clients.length === 0) { emptyState.classList.remove('hidden'); return; }
        tableWrap.classList.remove('hidden');
        renderTable(clients);
      })
      .catch(function (e) {
        loadingEl.classList.add('hidden');
        errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' +
          (e.message === 'NOT_CONFIGURED'
            ? 'Keine Supabase-Verbindung. Bitte <a href="settings.html">Einstellungen</a> prüfen.'
            : 'Fehler: ' + e.message) + '</div>';
      });
  }

  function empBadge(emp) {
    if (!emp) return '<span class="text-muted">—</span>';
    return '<span style="font-size:13px;font-weight:500">' + emp.name + '</span>';
  }

  function typeBadge(c) {
    if (!c.is_project) return '<span class="type-badge type-retainer">Retainer</span>';
    var label = 'Projekt';
    if (c.contract_start || c.project_end) {
      var parts = [];
      if (c.contract_start) parts.push(fmtMonthShort(c.contract_start));
      if (c.project_end)    parts.push(fmtMonthShort(c.project_end));
      if (parts.length) label += '<br><span style="font-size:10px;font-weight:400">' + parts.join(' – ') + '</span>';
    }
    return '<span class="type-badge type-project">' + label + '</span>';
  }

  function fmtMonthShort(dateStr) {
    if (!dateStr) return '';
    var d = new Date(dateStr);
    return window.MONTHS_DE[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCFullYear();
  }

  function renderTable(clients) {
    tbody.innerHTML = '';

    // Select-all checkbox
    var selectAll = document.getElementById('selectAll');
    if (selectAll) {
      selectAll.checked = false;
      selectAll.onchange = function () {
        tbody.querySelectorAll('.row-check').forEach(function (cb) {
          cb.checked = selectAll.checked;
          if (selectAll.checked) selectedIds.add(cb.dataset.id);
          else selectedIds.delete(cb.dataset.id);
        });
        updateBulkBar();
      };
    }

    clients.forEach(function (c) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td style="padding-right:4px">' +
          '<input type="checkbox" class="row-check" data-id="' + c.id + '"' +
            ' style="accent-color:var(--primary);width:15px;height:15px;cursor:pointer">' +
        '</td>' +
        '<td><a class="client-link" href="detail.html?id=' + encodeURIComponent(c.id) + '&name=' + encodeURIComponent(c.name) + '" style="font-weight:500">' + c.name + '</a></td>' +
        '<td>' + typeBadge(c) + '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' +
          (c.am_budget  != null ? '<strong>' + window.fmtHours(c.am_budget)  + '</strong> <span style="font-size:12px;color:var(--text-muted)">/ Monat</span>' : '<span class="text-muted">—</span>') +
        '</td>' +
        '<td class="right" style="font-variant-numeric:tabular-nums">' +
          (c.adv_budget != null ? '<strong>' + window.fmtHours(c.adv_budget) + '</strong> <span style="font-size:12px;color:var(--text-muted)">/ Monat</span>' : '<span class="text-muted">—</span>') +
        '</td>' +
        '<td>' + empBadge(c.am_emp)  + '</td>' +
        '<td>' + empBadge(c.adv_emp) + '</td>' +
        '<td class="center"><div style="display:flex;gap:6px;justify-content:center">' +
          '<button class="btn btn-ghost btn-sm edit-btn">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
            ' Bearbeiten</button>' +
          '<button class="btn btn-danger btn-sm delete-btn">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>' +
            ' Löschen</button>' +
        '</div></td>';

      tr.querySelector('.row-check').addEventListener('change', function () {
        if (this.checked) selectedIds.add(this.dataset.id);
        else              selectedIds.delete(this.dataset.id);
        if (selectAll) selectAll.checked = selectedIds.size === clients.length;
        updateBulkBar();
      });
      tr.querySelector('.edit-btn').addEventListener('click',   function () { openClientModal(c); });
      tr.querySelector('.delete-btn').addEventListener('click', function () { openDeleteModal(c); });
      tbody.appendChild(tr);
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  if (!window.isConfigured()) {
    setupHint.classList.remove('hidden');
  } else {
    loadEmployees().then(function () { loadClients(); });
  }
  addClientBtn.addEventListener('click', function () { openClientModal(null); });
})();
