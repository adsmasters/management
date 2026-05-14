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

  // ── Auto-Match ────────────────────────────────────────────────────────
  var autoMatchBtn    = document.getElementById('autoMatchBtn');
  var autoMatchModal  = document.getElementById('autoMatchModal');
  var autoMatchClose  = document.getElementById('autoMatchClose');
  var autoMatchCancel = document.getElementById('autoMatchCancel');
  var autoMatchApply  = document.getElementById('autoMatchApply');
  var autoMatchDesc   = document.getElementById('autoMatchDesc');
  var autoMatchList   = document.getElementById('autoMatchList');

  function normForMatch(s) {
    return (s || '')
      .toLowerCase()
      .replace(/\b(gmbh\s*&\s*co\.?\s*kg|gmbh|ug|ag|gbr|ohg|kg|se|e\.k\.|e\.v\.|ltd|llc|inc)\b/g, '')
      .replace(/[^a-z0-9äöüß]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function matchScore(lexName, clientName) {
    var a = normForMatch(lexName);
    var b = normForMatch(clientName);
    if (!a || !b) return 0;
    if (a === b) return 1.0;
    if (a.includes(b) || b.includes(a)) return 0.92;
    // Word-overlap (Jaccard over words longer than 2 chars)
    var wa = a.split(' ').filter(function (w) { return w.length > 2; });
    var wb = b.split(' ').filter(function (w) { return w.length > 2; });
    if (!wa.length || !wb.length) return 0;
    var setB = new Set(wb);
    var inter = wa.filter(function (w) { return setB.has(w); }).length;
    var union  = new Set(wa.concat(wb)).size;
    return union > 0 ? inter / union : 0;
  }

  function openAutoMatch() {
    // LexOffice names already mapped
    var mappedLex = new Set(allMappings.map(function (m) { return norm(m.lexoffice_name); }));
    // Also consider client.lexoffice_name / client.name as auto-mapped
    allClients.forEach(function (c) {
      if (c.lexoffice_name) mappedLex.add(norm(c.lexoffice_name));
    });

    var unmatchedLex = allLexNames.filter(function (n) { return !mappedLex.has(norm(n)); });

    if (!unmatchedLex.length) {
      autoMatchDesc.textContent = 'Alle LexOffice-Namen sind bereits zugeordnet.';
      autoMatchList.innerHTML   = '';
      autoMatchApply.style.display = 'none';
      autoMatchModal.classList.remove('hidden');
      return;
    }

    // Find best client match for each unmatched LexOffice name
    var suggestions = [];
    unmatchedLex.forEach(function (lexName) {
      var best = null, bestScore = 0;
      allClients.forEach(function (client) {
        var s = matchScore(lexName, client.name);
        if (s > bestScore) { bestScore = s; best = client; }
      });
      if (best && bestScore >= 0.45) {
        suggestions.push({ lexName: lexName, client: best, score: bestScore });
      }
    });

    suggestions.sort(function (a, b) { return b.score - a.score; });

    autoMatchApply.style.display = '';
    autoMatchDesc.textContent = suggestions.length
      ? suggestions.length + ' mögliche Zuordnung(en) gefunden – markierte übernehmen:'
      : 'Keine automatischen Zuordnungen gefunden (zu unterschiedliche Namen).';

    autoMatchList.innerHTML = '';
    suggestions.forEach(function (s, i) {
      var pct = Math.round(s.score * 100);
      var checked = s.score >= 0.7;
      var row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;cursor:pointer;';
      row.innerHTML =
        '<input type="checkbox" data-idx="' + i + '" ' + (checked ? 'checked' : '') + ' style="width:16px;height:16px;flex-shrink:0">' +
        '<span style="flex:1;font-size:13px"><strong>' + escHtml(s.lexName) + '</strong> → ' + escHtml(s.client.name) + '</span>' +
        '<span style="font-size:11px;padding:2px 8px;border-radius:12px;font-weight:600;background:' +
          (pct >= 80 ? 'var(--success-bg);color:#065f46' : pct >= 60 ? '#fef9c3;color:#854d0e' : 'var(--bg-hover);color:var(--text-secondary)') +
          '">' + pct + '% Match</span>';
      autoMatchList.appendChild(row);
    });

    // Store suggestions for apply step
    autoMatchModal._suggestions = suggestions;
    autoMatchModal.classList.remove('hidden');
  }

  function closeAutoMatch() { autoMatchModal.classList.add('hidden'); }

  autoMatchBtn.addEventListener('click', openAutoMatch);
  autoMatchClose.addEventListener('click', closeAutoMatch);
  autoMatchCancel.addEventListener('click', closeAutoMatch);
  autoMatchModal.addEventListener('click', function (e) {
    if (e.target === autoMatchModal) closeAutoMatch();
  });

  autoMatchApply.addEventListener('click', function () {
    var suggestions = autoMatchModal._suggestions || [];
    var checked = Array.from(autoMatchList.querySelectorAll('input[type=checkbox]:checked'));
    var toCreate = checked.map(function (cb) {
      return suggestions[parseInt(cb.getAttribute('data-idx'))];
    }).filter(Boolean);

    if (!toCreate.length) { closeAutoMatch(); return; }

    autoMatchApply.disabled = true;
    autoMatchApply.textContent = 'Speichern…';

    Promise.all(toCreate.map(function (s) {
      return window.db.mappings.add(s.client.id, s.lexName);
    })).then(function () {
      closeAutoMatch();
      load();
    }).catch(function (e) {
      showError('Fehler beim Speichern: ' + e.message);
      autoMatchApply.disabled = false;
      autoMatchApply.textContent = 'Markierte übernehmen';
    });
  });

  if (!window.isConfigured()) {
    setupHint.classList.remove('hidden');
  } else {
    load();
  }
})();
