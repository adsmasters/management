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

  emailInput.focus();
})();
