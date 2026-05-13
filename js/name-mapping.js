(function () {
  'use strict';

  var loadingEl  = document.getElementById('loading');
  var contentEl  = document.getElementById('content');
  var errorEl    = document.getElementById('error');
  var setupHint  = document.getElementById('setupHint');
  var unmappedEl = document.getElementById('unmappedNames');
  var tableBody  = document.getElementById('mappingBody');

  var allClients       = [];
  var allMappings      = [];
  var allLexNames      = [];
  var mappingsByClient = {}; // clientId → [{ id, lexoffice_name }]

  function showError(msg) {
    errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' + msg + '</div>';
  }

  function norm(s) { return (s || '').trim().toLowerCase(); }
  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

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

      var tagsHtml = mappings.map(function (m) {
        return '<span class="mapping-tag">' +
          escHtml(m.lexoffice_name) +
          '<button class="tag-remove" data-id="' + m.id + '" title="Entfernen">×</button>' +
          '</span>';
      }).join('');

      tr.innerHTML =
        '<td style="font-weight:600;vertical-align:top;padding-top:12px;width:220px">' + escHtml(client.name) + '</td>' +
        '<td>' +
          '<div class="tags-wrap">' + tagsHtml + '</div>' +
          '<div class="add-wrap" style="position:relative;display:inline-block;margin-top:6px">' +
            '<button class="btn btn-ghost btn-sm show-add-btn" style="font-size:12px">+ Zuordnen</button>' +
            '<div class="add-dropdown-panel hidden">' +
              '<input type="text" class="add-filter-input" placeholder="Suchen oder Namen eingeben…">' +
              '<div class="add-name-list"></div>' +
            '</div>' +
          '</div>' +
        '</td>';

      // Remove tag
      tr.querySelectorAll('.tag-remove').forEach(function (btn) {
        btn.addEventListener('click', function () {
          btn.disabled = true;
          window.db.mappings.remove(btn.getAttribute('data-id'))
            .then(load)
            .catch(function (e) { showError(e.message); btn.disabled = false; });
        });
      });

      var showBtn  = tr.querySelector('.show-add-btn');
      var panel    = tr.querySelector('.add-dropdown-panel');
      var filter   = tr.querySelector('.add-filter-input');
      var nameList = tr.querySelector('.add-name-list');

      function buildList(query) {
        var mapped = new Set(mappings.map(function (m) { return norm(m.lexoffice_name); }));
        var q = norm(query);
        var available = allLexNames.filter(function (n) {
          return !mapped.has(norm(n)) && (!q || norm(n).includes(q));
        });

        var html = '';
        available.forEach(function (n) {
          html += '<div class="add-name-item" data-name="' + escHtml(n) + '">' + escHtml(n) + '</div>';
        });

        // Option to add typed value if not already in list
        var typed = (query || '').trim();
        if (typed && !available.some(function (n) { return norm(n) === norm(typed); }) && !mapped.has(norm(typed))) {
          html += '<div class="add-name-item add-name-custom" data-name="' + escHtml(typed) + '">+ „' + escHtml(typed) + '" hinzufügen</div>';
        }

        if (!html) {
          html = '<div style="padding:10px 12px;font-size:12px;color:var(--text-muted)">Keine Einträge gefunden</div>';
        }

        nameList.innerHTML = html;

        nameList.querySelectorAll('.add-name-item').forEach(function (item) {
          item.addEventListener('click', function () {
            var name = item.getAttribute('data-name');
            item.style.opacity = '0.5';
            window.db.mappings.add(client.id, name)
              .then(load)
              .catch(function (e) {
                if (e.message && e.message.includes('unique')) {
                  showError('„' + name + '" ist bereits zugeordnet.');
                } else {
                  showError(e.message);
                }
                item.style.opacity = '';
              });
          });
        });
      }

      showBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        // Close all other panels first
        document.querySelectorAll('.add-dropdown-panel').forEach(function (p) {
          if (p !== panel) p.classList.add('hidden');
        });
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden')) {
          filter.value = '';
          buildList('');
          filter.focus();
        }
      });

      filter.addEventListener('input', function () { buildList(filter.value); });
      filter.addEventListener('keydown', function (e) { if (e.key === 'Escape') panel.classList.add('hidden'); });
      panel.addEventListener('click', function (e) { e.stopPropagation(); });

      tableBody.appendChild(tr);
    });

    // Close dropdowns on outside click
    document.addEventListener('click', function () {
      document.querySelectorAll('.add-dropdown-panel').forEach(function (p) {
        p.classList.add('hidden');
      });
    });
  }

  function renderUnmapped() {
    var mappedNorms = new Set(allMappings.map(function (m) { return norm(m.lexoffice_name); }));
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

  if (!window.isConfigured()) {
    setupHint.classList.remove('hidden');
  } else {
    load();
  }
})();
