(function () {
  'use strict';

  var ALLOWED_EMAIL = 'hallo@tobias-dziuba.de';

  window.auth = {
    _session: null,

    // Login-Zwang entfernt: Das Tool ist ohne Anmeldung nutzbar.
    // (Die Daten waren über den öffentlichen anon-Key ohnehin ungeschützt.)
    init: function () {
      try {
        if (window.isConfigured()) {
          window.getSb().auth.getSession().then(function (r) {
            var session = r.data && r.data.session;
            if (session) { window.auth._session = session; }
            window.auth._setupNav(session);
          }).catch(function () { window.auth._setupNav(null); });
          return;
        }
      } catch (e) { /* ignore */ }
      window.auth._setupNav(null);
    },

    signOut: function () {
      window.getSb().auth.signOut().finally(function () {
        location.reload();
      });
    },

    getSession:  function () { return window.auth._session; },
    isAdmin:     function () {
      var s = window.auth._session;
      return !!(s && s.user && s.user.user_metadata && s.user.user_metadata.role === 'admin');
    },

    _setupNav: function (session) {
      var user    = (session && session.user) || null;
      var email   = (user && user.email) || '';
      var isAdmin = !!(user && user.user_metadata && user.user_metadata.role === 'admin');
      var hi      = document.querySelector('.header-inner');
      if (!hi) return;
      var div = document.createElement('div');
      div.className = 'nav-user';
      div.innerHTML =
        (isAdmin ? '<span class="badge badge-ok" style="font-size:10px;padding:2px 7px">Admin</span>' : '') +
        (email ? '<span class="nav-user-email">' + email + '</span>' : '');
      hi.appendChild(div);
    },
  };

  // Auto-init on every page
  window.auth.init();
})();
