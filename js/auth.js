(function () {
  'use strict';

  window.auth = {
    _session: null,

    init: function () { return; },

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
