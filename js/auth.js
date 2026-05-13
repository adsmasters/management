(function () {
  'use strict';

  window.auth = {
    _session: null,

    init: function () {
      // settings.html always accessible (initial setup)
      if (location.pathname.includes('login.html'))    return;
      if (location.pathname.includes('settings.html')) return;
      if (!window.isConfigured()) return;

      window.getSb().auth.getSession().then(function (result) {
        var session = result.data && result.data.session;
        if (!session) { location.href = 'login.html'; return; }
        window.auth._session = session;
        window.auth._setupNav(session);
      }).catch(function () {
        location.href = 'login.html';
      });
    },

    signOut: function () {
      window.getSb().auth.signOut().finally(function () {
        location.href = 'login.html';
      });
    },

    getSession:  function () { return window.auth._session; },
    isAdmin:     function () {
      var s = window.auth._session;
      return !!(s && s.user && s.user.user_metadata && s.user.user_metadata.role === 'admin');
    },

    _setupNav: function (session) {
      var email   = (session.user && session.user.email) || '';
      var isAdmin = !!(session.user && session.user.user_metadata && session.user.user_metadata.role === 'admin');
      var hi      = document.querySelector('.header-inner');
      if (!hi) return;
      var div = document.createElement('div');
      div.className = 'nav-user';
      div.innerHTML =
        (isAdmin ? '<span class="badge badge-ok" style="font-size:10px;padding:2px 7px">Admin</span>' : '') +
        '<span class="nav-user-email">' + email + '</span>' +
        '<button id="logoutBtn" class="btn btn-ghost btn-sm">Abmelden</button>';
      hi.appendChild(div);
      document.getElementById('logoutBtn').addEventListener('click', function () {
        window.auth.signOut();
      });
    },
  };

  // Auto-init on every page
  window.auth.init();
})();
