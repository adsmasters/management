(function () {
  'use strict';

  var msg      = document.getElementById('msg');
  var status   = document.getElementById('status');
  var formArea = document.getElementById('formArea');
  var pw1      = document.getElementById('pw1');
  var pw2      = document.getElementById('pw2');
  var saveBtn  = document.getElementById('saveBtn');

  function showError(text) {
    msg.textContent = text;
    msg.classList.remove('hidden');
  }

  function setStatus(text) { status.textContent = text; }

  var sb;
  try {
    sb = window.getSb();
  } catch (e) {
    setStatus('');
    showError('Supabase konnte nicht geladen werden.');
    return;
  }

  var hasRecovery = false;

  // supabase-js parst den Recovery-Token aus der URL automatisch und feuert
  // dieses Event. Erst dann darf das Passwort gesetzt werden.
  sb.auth.onAuthStateChange(function (event, session) {
    if (event === 'PASSWORD_RECOVERY' || (session && !hasRecovery)) {
      hasRecovery = true;
      formArea.classList.remove('hidden');
      setStatus('Bitte neues Passwort vergeben.');
      pw1.focus();
    }
  });

  // Fallback: Falls die Session bereits aktiv ist (Token schon verarbeitet).
  sb.auth.getSession().then(function (r) {
    var session = r.data && r.data.session;
    if (session && !hasRecovery) {
      hasRecovery = true;
      formArea.classList.remove('hidden');
      setStatus('Bitte neues Passwort vergeben.');
      pw1.focus();
    } else if (!session) {
      // Etwas länger warten, falls der Token noch verarbeitet wird.
      setTimeout(function () {
        if (!hasRecovery) {
          setStatus('');
          showError('Kein gültiger Reset-Link. Bitte fordere einen neuen an.');
        }
      }, 2500);
    }
  });

  function save() {
    var p1 = pw1.value;
    var p2 = pw2.value;
    msg.classList.add('hidden');

    if (!p1 || p1.length < 8) { showError('Passwort muss mindestens 8 Zeichen haben.'); return; }
    if (p1 !== p2)            { showError('Die Passwörter stimmen nicht überein.'); return; }

    saveBtn.disabled    = true;
    saveBtn.textContent = 'Speichern …';

    sb.auth.updateUser({ password: p1 })
      .then(function (result) {
        if (result.error) throw result.error;
        formArea.classList.add('hidden');
        msg.classList.add('hidden');
        setStatus('Passwort gespeichert. Du wirst eingeloggt …');
        setTimeout(function () { location.href = 'index.html'; }, 1200);
      })
      .catch(function (err) {
        showError('Fehler: ' + (err && err.message ? err.message : 'Konnte nicht gespeichert werden.'));
        saveBtn.disabled    = false;
        saveBtn.textContent = 'Passwort speichern';
      });
  }

  saveBtn.addEventListener('click', save);
  pw2.addEventListener('keydown', function (e) { if (e.key === 'Enter') save(); });
  pw1.addEventListener('keydown', function (e) { if (e.key === 'Enter') pw2.focus(); });
})();
