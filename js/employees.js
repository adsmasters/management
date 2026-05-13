(function () {
  'use strict';

  const tbody          = document.getElementById('employeesBody');
  const tableWrap      = document.getElementById('tableWrap');
  const loadingEl      = document.getElementById('loading');
  const errorEl        = document.getElementById('error');
  const setupHint      = document.getElementById('setupHint');
  const emptyState     = document.getElementById('emptyState');
  const addBtn         = document.getElementById('addBtn');

  const empModal       = document.getElementById('empModal');
  const empModalTitle  = document.getElementById('empModalTitle');
  const empName        = document.getElementById('empName');
  const empRole        = document.getElementById('empRole');
  const empEmail       = document.getElementById('empEmail');
  const empCost        = document.getElementById('empCost');
  const empActive      = document.getElementById('empActive');
  const roleHint       = document.getElementById('roleHint');
  const empModalClose  = document.getElementById('empModalClose');
  const empModalCancel = document.getElementById('empModalCancel');
  const empModalSave   = document.getElementById('empModalSave');

  const deleteModal        = document.getElementById('deleteModal');
  const deleteEmpName      = document.getElementById('deleteEmpName');
  const deleteModalClose   = document.getElementById('deleteModalClose');
  const deleteModalCancel  = document.getElementById('deleteModalCancel');
  const deleteModalConfirm = document.getElementById('deleteModalConfirm');

  const ROLE_HINTS = {
    account_manager: 'Stunden werden 1:1 zu Account Management gezählt.',
    advertising:     'Stunden werden zu Advertising gezählt.',
    freelancer:      'Stunden werden durch 3 geteilt und zu Account Management gezählt.',
    other:           'Stunden werden nicht in die Auswertung einbezogen.',
  };

  let editingId  = null;
  let deletingId = null;

  // ── Role hint updater ─────────────────────────────────────────────────
  empRole.addEventListener('change', () => {
    roleHint.textContent = ROLE_HINTS[empRole.value] || '';
  });

  // ── Open / close emp modal ────────────────────────────────────────────
  function openEmpModal(emp = null) {
    editingId = emp?.id ?? null;
    empModalTitle.textContent = emp ? 'Mitarbeiter bearbeiten' : 'Neuer Mitarbeiter';
    empName.value    = emp?.name   ?? '';
    empRole.value    = emp?.role   ?? 'account_manager';
    empEmail.value   = emp?.email  ?? '';
    empCost.value    = emp?.monthly_cost > 0 ? emp.monthly_cost : '';
    empActive.checked = emp ? !!emp.active : true;
    document.getElementById('activeField').classList.toggle('hidden', !emp);
    roleHint.textContent = ROLE_HINTS[empRole.value] || '';
    empModal.classList.remove('hidden');
    empName.focus();
  }
  function closeEmpModal() { empModal.classList.add('hidden'); editingId = null; }
  empModalClose.addEventListener('click',  closeEmpModal);
  empModalCancel.addEventListener('click', closeEmpModal);
  empModal.addEventListener('click', e => { if (e.target === empModal) closeEmpModal(); });
  empName.addEventListener('keydown', e => { if (e.key === 'Enter') empModalSave.click(); });

  empModalSave.addEventListener('click', () => {
    const name = empName.value.trim();
    if (!name) { empName.focus(); empName.style.borderColor = 'var(--danger)'; return; }
    empName.style.borderColor = '';

    const role        = empRole.value;
    const email       = empEmail.value.trim() || null;
    const monthlyCost = parseFloat(empCost.value) || 0;
    const active      = empActive.checked;

    empModalSave.disabled = true;
    empModalSave.textContent = 'Speichern…';

    const promise = editingId
      ? window.db.employees.update(editingId, { name, role, email, active, monthly_cost: monthlyCost })
      : window.db.employees.create(name, role, email, monthlyCost);

    promise
      .then(() => { closeEmpModal(); loadEmployees(); })
      .catch(e  => { showError('Fehler: ' + e.message); closeEmpModal(); })
      .finally(() => { empModalSave.disabled = false; empModalSave.textContent = 'Speichern'; });
  });

  // ── Delete modal ──────────────────────────────────────────────────────
  function openDeleteModal(emp) {
    deletingId = emp.id;
    deleteEmpName.textContent = emp.name;
    deleteModal.classList.remove('hidden');
  }
  function closeDeleteModal() { deleteModal.classList.add('hidden'); deletingId = null; }
  deleteModalClose.addEventListener('click',  closeDeleteModal);
  deleteModalCancel.addEventListener('click', closeDeleteModal);
  deleteModal.addEventListener('click', e => { if (e.target === deleteModal) closeDeleteModal(); });

  deleteModalConfirm.addEventListener('click', () => {
    if (!deletingId) return;
    deleteModalConfirm.disabled = true;
    deleteModalConfirm.textContent = 'Löschen…';
    window.db.employees.delete(deletingId)
      .then(() => { closeDeleteModal(); loadEmployees(); })
      .catch(e  => { showError('Fehler: ' + e.message); closeDeleteModal(); })
      .finally(() => { deleteModalConfirm.disabled = false; deleteModalConfirm.textContent = 'Endgültig löschen'; });
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeEmpModal(); closeDeleteModal(); }
  });

  // ── Load & render ─────────────────────────────────────────────────────
  function showError(msg) {
    errorEl.innerHTML = `<div class="alert alert-danger">⚠️ ${msg}</div>`;
  }

  function loadEmployees() {
    loadingEl.innerHTML = '<div class="loading-bar"><div class="spinner"></div>Mitarbeiter werden geladen…</div>';
    loadingEl.classList.remove('hidden');
    tableWrap.classList.add('hidden');
    emptyState.classList.add('hidden');

    window.db.employees.list()
      .then(emps => {
        loadingEl.classList.add('hidden');
        if (!emps.length) { emptyState.classList.remove('hidden'); return; }
        tableWrap.classList.remove('hidden');
        renderTable(emps);
      })
      .catch(e => {
        loadingEl.classList.add('hidden');
        showError(e.message === 'NOT_CONFIGURED'
          ? 'Keine Supabase-Verbindung. Bitte <a href="settings.html">Einstellungen</a> prüfen.'
          : 'Fehler: ' + e.message);
      });
  }

  function renderTable(emps) {
    tbody.innerHTML = '';
    emps.forEach(emp => {
      const roleCls   = window.getRoleCls(emp.role);
      const roleLabel = window.getRoleLabel(emp.role);

      const tr = document.createElement('tr');
      if (!emp.active) tr.style.opacity = '0.5';

      const costFmt = emp.monthly_cost > 0
        ? emp.monthly_cost.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' €'
        : '<span style="color:var(--text-muted)">—</span>';

      tr.innerHTML = `
        <td style="font-weight:500">${emp.name}</td>
        <td><span class="role-badge ${roleCls}">${roleLabel}</span></td>
        <td style="color:var(--text-secondary)">${emp.email || '<span class="text-muted">—</span>'}</td>
        <td class="right" style="font-variant-numeric:tabular-nums">${costFmt}</td>
        <td class="center">
          <span style="font-size:16px">${emp.active ? '✓' : '–'}</span>
        </td>
        <td class="center">
          <div style="display:flex;gap:6px;justify-content:center">
            <button class="btn btn-ghost btn-sm edit-btn">
              ${window.svgPencil()} Bearbeiten
            </button>
            <button class="btn btn-danger btn-sm delete-btn">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
              Löschen
            </button>
          </div>
        </td>
      `;

      tr.querySelector('.edit-btn').addEventListener('click',   () => openEmpModal(emp));
      tr.querySelector('.delete-btn').addEventListener('click', () => openDeleteModal(emp));
      tbody.appendChild(tr);
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  if (!window.isConfigured()) {
    setupHint.classList.remove('hidden');
  } else {
    loadEmployees();
  }
  addBtn.addEventListener('click', () => openEmpModal());
})();
