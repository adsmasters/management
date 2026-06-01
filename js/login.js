(function () {
  'use strict';

  var emailInput = document.getElementById('loginEmail');
  var pwInput    = document.getElementById('loginPassword');
  var loginBtn   = document.getElementById('loginBtn');
  var errorEl    = document.getElementById('loginError');

  // Already logged in? Redirect immediately
  if (window.isConfigured()) {
    window.getSb().auth.getSession().then(function (r) {
      if (r.data && r.data.session) location.href = 'index.html';
    });
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  }

  function doLogin() {
    var email = emailInput.value.trim();
    var pw    = pwInput.value;
    if (!email || !pw) { showError('Bitte E-Mail und Passwort eingeben.'); return; }

    loginBtn.disabled    = true;
    loginBtn.textContent = 'Anmelden…';
    errorEl.classList.add('hidden');

    window.getSb().auth.signInWithPassword({ email: email, password: pw })
      .then(function (result) {
        if (result.error) throw result.error;
        location.href = 'index.html';
      })
      .catch(function () {
        showError('E-Mail oder Passwort falsch.');
        loginBtn.disabled    = false;
        loginBtn.textContent = 'Anmelden';
        pwInput.select();
      });
  }

  loginBtn.addEventListener('click', doLogin);
  pwInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  emailInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') pwInput.focus(); });

  // Passwort vergessen → Reset-Link gezielt auf die set-password-Seite leiten
  // (NICHT über die globale Supabase Site-URL, die auf reviewguards.de zeigt).
  var forgotLink = document.getElementById('forgotLink');
  if (forgotLink) {
    forgotLink.addEventListener('click', function (e) {
      e.preventDefault();
      var email = emailInput.value.trim();
      if (!email) { showError('Bitte zuerst deine E-Mail eingeben.'); emailInput.focus(); return; }
      var redirectTo = location.origin + location.pathname.replace(/login\.html$/, '') + 'set-password.html';
      errorEl.classList.add('hidden');
      window.getSb().auth.resetPasswordForEmail(email, { redirectTo: redirectTo })
        .then(function (result) {
          if (result.error) throw result.error;
          errorEl.textContent = 'Reset-Link gesendet an ' + email + '. Bitte prüfe dein Postfach.';
          errorEl.classList.remove('alert-danger');
          errorEl.classList.add('alert-success');
          errorEl.classList.remove('hidden');
        })
        .catch(function () { showError('Reset-Link konnte nicht gesendet werden.'); });
    });
  }

  emailInput.focus();
})();
