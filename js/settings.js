(function () {
  'use strict';

  var urlInput   = document.getElementById('supabaseUrl');
  var keyInput   = document.getElementById('supabaseKey');
  var saveBtn    = document.getElementById('saveBtn');
  var saveStatus = document.getElementById('saveStatus');
  var connStatus = document.getElementById('connStatus');
  var copyBtn    = document.getElementById('copySQL');
  var sqlBlock   = document.getElementById('sqlBlock');

  // Pre-fill saved values
  urlInput.value = localStorage.getItem('supabaseUrl') || '';
  keyInput.value = localStorage.getItem('supabaseKey') || '';

  if (window.isConfigured()) {
    connStatus.innerHTML = '<span class="badge badge-ok">✓ Verbunden</span>';
  }

  function setStatus(msg, type) {
    saveStatus.textContent = msg;
    saveStatus.style.color =
      type === 'success' ? 'var(--success)' :
      type === 'error'   ? 'var(--danger)'  :
      type === 'warn'    ? 'var(--warning)' : 'var(--text-secondary)';
  }

  saveBtn.addEventListener('click', function () {
    var url = urlInput.value.trim();
    var key = keyInput.value.trim();

    if (!url || !key) {
      setStatus('Bitte URL und Key eingeben.', 'error');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Teste Verbindung…';
    setStatus('', '');

    window.configure(url, key);

    window.db.clients.list()
      .then(function () {
        setStatus('Verbindung erfolgreich ✓', 'success');
        connStatus.innerHTML = '<span class="badge badge-ok">✓ Verbunden</span>';
      })
      .catch(function (e) {
        var msg = e.message || '';
        if (msg.includes('relation') || msg.includes('does not exist')) {
          setStatus('Verbindung OK, aber Tabellen fehlen – bitte SQL-Script ausführen.', 'warn');
          connStatus.innerHTML = '<span class="badge badge-warn">⚠ Tabellen fehlen</span>';
        } else {
          setStatus('Fehler: ' + msg, 'error');
          connStatus.innerHTML = '<span class="badge badge-over">✗ Fehler</span>';
        }
      })
      .finally(function () {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Verbindung speichern & testen';
      });
  });

  // ── Clockify section ─────────────────────────────────────────────────
  var clockifyKeyInput    = document.getElementById('clockifyKey');
  var clockifySaveBtn     = document.getElementById('clockifySaveBtn');
  var clockifySaveStatus  = document.getElementById('clockifySaveStatus');
  var clockifyStatusEl    = document.getElementById('clockifyStatus');

  clockifyKeyInput.value = localStorage.getItem('clockifyKey') || '';

  if (window.clockify.isConfigured()) {
    var wName = localStorage.getItem('clockifyWorkspaceName') || 'Verbunden';
    clockifyStatusEl.innerHTML = '<span class="badge badge-ok">✓ ' + wName + '</span>';
  }

  function setClockifyStatus(msg, type) {
    clockifySaveStatus.textContent = msg;
    clockifySaveStatus.style.color =
      type === 'success' ? 'var(--success)' :
      type === 'error'   ? 'var(--danger)'  : 'var(--text-secondary)';
  }

  clockifySaveBtn.addEventListener('click', function () {
    var key = clockifyKeyInput.value.trim();
    if (!key) { setClockifyStatus('Bitte API Key eingeben.', 'error'); return; }
    localStorage.setItem('clockifyKey', key);
    clockifySaveBtn.disabled = true;
    clockifySaveBtn.textContent = 'Teste Verbindung…';
    setClockifyStatus('', '');
    window.clockify.testConnection()
      .then(function (result) {
        var ws = result.matched;
        if (ws) {
          setClockifyStatus('Verbunden mit Workspace „' + ws.name + '" ✓', 'success');
          clockifyStatusEl.innerHTML = '<span class="badge badge-ok">✓ ' + ws.name + '</span>';
        } else {
          setClockifyStatus('Verbunden, aber kein Workspace „Adsmasters" gefunden.', 'error');
        }
      })
      .catch(function (e) {
        setClockifyStatus('Fehler: ' + e.message, 'error');
        clockifyStatusEl.innerHTML = '<span class="badge badge-over">✗ Fehler</span>';
      })
      .finally(function () {
        clockifySaveBtn.disabled = false;
        clockifySaveBtn.textContent = 'Verbindung speichern & testen';
      });
  });

  // ── LexOffice section ────────────────────────────────────────────────
  var lexofficeKeyInput   = document.getElementById('lexofficeKey');
  var lexofficeSaveBtn    = document.getElementById('lexofficeSaveBtn');
  var lexofficeSaveStatus = document.getElementById('lexofficeSaveStatus');
  var lexofficeStatusEl   = document.getElementById('lexofficeStatus');

  lexofficeKeyInput.value = localStorage.getItem('lexofficeKey') || '';

  if (window.lexoffice.isConfigured()) {
    lexofficeStatusEl.innerHTML = '<span class="badge badge-ok">✓ Verbunden</span>';
  }

  function setLexofficeStatus(msg, type) {
    lexofficeSaveStatus.textContent = msg;
    lexofficeSaveStatus.style.color =
      type === 'success' ? 'var(--success)' :
      type === 'error'   ? 'var(--danger)'  : 'var(--text-secondary)';
  }

  lexofficeSaveBtn.addEventListener('click', function () {
    var key = lexofficeKeyInput.value.trim();
    if (!key) { setLexofficeStatus('Bitte API Key eingeben.', 'error'); return; }
    localStorage.setItem('lexofficeKey', key);
    lexofficeSaveBtn.disabled = true;
    lexofficeSaveBtn.textContent = 'Teste Verbindung…';
    setLexofficeStatus('', '');
    window.lexoffice.testConnection()
      .then(function () {
        setLexofficeStatus('Verbindung erfolgreich ✓', 'success');
        lexofficeStatusEl.innerHTML = '<span class="badge badge-ok">✓ Verbunden</span>';
      })
      .catch(function (e) {
        setLexofficeStatus('Fehler: ' + e.message, 'error');
        lexofficeStatusEl.innerHTML = '<span class="badge badge-over">✗ Fehler</span>';
      })
      .finally(function () {
        lexofficeSaveBtn.disabled = false;
        lexofficeSaveBtn.textContent = 'Verbindung speichern & testen';
      });
  });

  copyBtn.addEventListener('click', function () {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(sqlBlock.textContent.trim())
        .then(function () {
          copyBtn.textContent = 'Kopiert ✓';
          setTimeout(function () { copyBtn.textContent = 'Kopieren'; }, 2000);
        })
        .catch(function () { copyBtn.textContent = 'Manuell kopieren'; });
    } else {
      copyBtn.textContent = 'Manuell kopieren';
    }
  });
})();
