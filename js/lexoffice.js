(function () {
  'use strict';

  var BASE = 'https://api.lexoffice.io/v1';

  function getKey() {
    var k = localStorage.getItem('lexofficeKey');
    if (!k) throw new Error('LEXOFFICE_NOT_CONFIGURED');
    return k;
  }

  function lfetch(path) {
    return fetch(BASE + path, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + getKey(),
        'Accept': 'application/json',
      },
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error('LexOffice ' + res.status + ': ' + t); });
      return res.json();
    });
  }

  function norm(str) { return (str || '').trim().toLowerCase(); }

  window.lexoffice = {

    isConfigured: function () {
      return !!localStorage.getItem('lexofficeKey');
    },

    testConnection: function () {
      return lfetch('/voucherlist?voucherType=invoice&voucherStatus=open,paid&page=0&size=1');
    },

    // Returns { normContactName → totalBrutto } for a given month
    fetchMonth: function (year, month) {
      var from = new Date(Date.UTC(year, month - 1, 1)).toISOString().substring(0, 10);
      var to   = new Date(Date.UTC(year, month,     0)).toISOString().substring(0, 10);

      function fetchPage(page) {
        return lfetch('/voucherlist?voucherType=invoice&voucherStatus=open,paid'
          + '&voucherDateFrom=' + from + '&voucherDateTo=' + to
          + '&size=250&page=' + page);
      }

      return fetchPage(0).then(function (data) {
        var all    = data.content || [];
        var pages  = data.totalPages || 1;
        var more   = [];
        for (var p = 1; p < pages; p++) more.push(fetchPage(p));
        return Promise.all(more).then(function (results) {
          results.forEach(function (r) { all = all.concat(r.content || []); });
          var map = {};
          all.forEach(function (v) {
            var name = norm(v.contactName);
            if (!name) return;
            map[name] = (map[name] || 0) + (v.totalAmount || 0);
          });
          return map;
        });
      });
    },
  };
})();
