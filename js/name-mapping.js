(function () {
  'use strict';

  var loadingEl  = document.getElementById('loading');
  var contentEl  = document.getElementById('content');
  var errorEl    = document.getElementById('error');
  var setupHint  = document.getElementById('setupHint');
  var unmappedEl = document.getElementById('unmappedNames');
  var tableBody  = document.getElementById('mappingBody');

  var allClients      = [];
  var allMappings     = [];
  var allLexNames     = [];
  var mappingsByClient = {}; // clientId → [{ id, lexoffice_name }]

  function showError(msg) {
    errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' + msg + '</div>';
  }

  function norm(s) { return (s || '').trim().toLowerCase(); }

  function load() {
    loadingEl.classList.remove('hidden');
    contentEl.classList.add('hidden');
    errorEl.innerHTML = '';

    Promise.all([
      window.db.clients.list(),
      window.db.mappings.list(),
      window.db.revenue.allContactNames(),
    ])
    .then(function (results) {
      allClients  = results[0];
      allMappings = results[1];
      allLexNames = results[2];

      mappingsByClient = {};
      allMappings.forEach(function (m) {
        if (!mappingsByClient[m.client_id]) mappingsByClient[m.client_id] = [];
        mappingsByClient[m.client_id].push(m);
      });

      loadingEl.classList.add('hidden');
      contentEl.classList.remove('hidden');
      render();
    })
    .catch(function (e) {
      loadingEl.classList.add('hidden');
      showError(e.message);
    });
  }

  function render() {
    renderTable();
    renderUnmapped();
  }

  function renderTable() {
    tableBody.innerHTML = '';
    allClients.forEach(function (client) {
      var mappings = mappingsByClient[client.id] || [];
      var tr = document.createElement('tr');

      // Tags HTML
      var tagsHtml = mappings.map(function (m) {
        return '<span class="mapping-tag">' +
          escHtml(m.lexoffice_name) +
          '<button class="tag-remove" data-id="' + m.id + '" title="Entfernen">×</button>' +
          '</span>';
      }).join('');

      // Inline add form (hidden by default)
      var addId = 'add-' + client.id;
      var datalistId = 'dl-' + client.id;
      var availableNames = allLexNames.filter(function (n) {
        return !mappings.some(function (m) { return norm(m.lexoffice_name) === norm(n); });
      });
      var datalistOptions = availableNames.map(function (n) {
        return '<option value="' + escHtml(n) + '">';
      }).join('');

      tr.innerHTML =
        '<td style="font-weight:600;vertical-align:top;padding-top:12px">' + escHtml(client.name) + '</td>' +
        '<td>' +
          '<div class="tags-wrap" id="tags-' + client.id + '">' + tagsHtml + '</div>' +
          '<div class="add-form hidden" id="' + addId + '">' +
            '<input type="text" class="add-input" list="' + datalistId + '" placeholder="LexOffice-Name eingeben…" autocomplete="off">' +
            '<datalist id="' + datalistId + '">' + datalistOptions + '</datalist>' +
            '<button class="btn btn-primary btn-sm confirm-add" data-client-id="' + client.id + '">Hinzufügen</button>' +
            '<button class="btn btn-secondary btn-sm cancel-add" data-add-id="' + addId + '">Abbrechen</button>' +
          '</div>' +
          '<button class="btn btn-ghost btn-sm show-add" data-add-id="' + addId + '" style="margin-top:6px;font-size:12px">+ Zuordnen</button>' +
        '</td>';

      // Remove tag events
      tr.querySelectorAll('.tag-remove').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var mappingId = btn.getAttribute('data-id');
          btn.disabled = true;
          window.db.mappings.remove(mappingId)
            .then(function () { load(); })
            .catch(function (e) { showError(e.message); btn.disabled = false; });
        });
      });

      // Show add form
      tr.querySelector('.show-add').addEventListener('click', function () {
        var form = document.getElementById(addId);
        form.classList.remove('hidden');
        form.querySelector('.add-input').focus();
        this.classList.add('hidden');
      });

      // Cancel add
      tr.querySelector('.cancel-add').addEventListener('click', function () {
        var form = document.getElementById(addId);
        form.classList.add('hidden');
        form.querySelector('.add-input').value = '';
        tr.querySelector('.show-add').classList.remove('hidden');
      });

      // Confirm add
      tr.querySelector('.confirm-add').addEventListener('click', function () {
        var clientId = this.getAttribute('data-client-id');
        var input    = tr.querySelector('.add-input');
        var name     = input.value.trim();
        if (!name) { input.focus(); return; }
        this.disabled = true;
        window.db.mappings.add(clientId, name)
          .then(function () { load(); })
          .catch(function (e) {
            if (e.message && e.message.includes('unique')) {
              showError('„' + name + '" ist bereits zugeordnet.');
            } else {
              showError(e.message);
            }
            tr.querySelector('.confirm-add').disabled = false;
          });
      });

      // Enter key in input
      tr.querySelector('.add-input').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') tr.querySelector('.confirm-add').click();
        if (e.key === 'Escape') tr.querySelector('.cancel-add').click();
      });

      tableBody.appendChild(tr);
    });
  }

  function renderUnmapped() {
    var mappedNorms = new Set(allMappings.map(function (m) { return norm(m.lexoffice_name); }));
    // Also consider lexoffice_name on the client itself and client name
    allClients.forEach(function (c) {
      if (c.lexoffice_name) mappedNorms.add(norm(c.lexoffice_name));
      mappedNorms.add(norm(c.name));
    });

    var unmapped = allLexNames.filter(function (n) { return !mappedNorms.has(norm(n)); });

    if (unmapped.length === 0) {
      unmappedEl.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Alle LexOffice-Namen sind zugeordnet.</p>';
      return;
    }

    unmappedEl.innerHTML = unmapped.map(function (n) {
      return '<span class="unmapped-tag">' + escHtml(n) + '</span>';
    }).join('');
  }

  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Boot
  if (!window.isConfigured()) {
    setupHint.classList.remove('hidden');
  } else {
    load();
  }
})();
