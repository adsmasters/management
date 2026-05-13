(function () {
  'use strict';

  var BASE    = 'https://api.clockify.me/api/v1';
  var REPORTS = 'https://reports.api.clockify.me/v1';

  function getKey() {
    var k = localStorage.getItem('clockifyKey');
    if (!k) throw new Error('CLOCKIFY_NOT_CONFIGURED');
    return k;
  }

  function getWorkspaceId() {
    var w = localStorage.getItem('clockifyWorkspaceId');
    if (!w) throw new Error('CLOCKIFY_NO_WORKSPACE');
    return w;
  }

  function cfetch(url, opts) {
    opts = opts || {};
    var headers = { 'X-Api-Key': getKey(), 'Content-Type': 'application/json' };
    return fetch(url, {
      method:  opts.method  || 'GET',
      headers: headers,
      body:    opts.body    || undefined,
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error('Clockify ' + res.status + ': ' + t); });
      return res.json();
    });
  }

  // ── ISO-8601 duration → hours (e.g. "PT1H30M" → 1.5) ─────────────────
  function isoToHours(iso) {
    if (!iso) return 0;
    var m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return 0;
    return (parseInt(m[1] || 0)) + (parseInt(m[2] || 0) / 60) + (parseInt(m[3] || 0) / 3600);
  }

  // ── Normalise name for matching ────────────────────────────────────────
  function norm(str) { return (str || '').trim().toLowerCase(); }

  window.clockify = {

    isConfigured: function () {
      return !!localStorage.getItem('clockifyKey') && !!localStorage.getItem('clockifyWorkspaceId');
    },

    // Test API key + auto-detect Adsmasters workspace
    testConnection: function () {
      return cfetch(BASE + '/workspaces').then(function (workspaces) {
        var ws = workspaces.find(function (w) { return norm(w.name).includes('adsmasters'); })
               || workspaces[0];
        if (ws) {
          localStorage.setItem('clockifyWorkspaceId',   ws.id);
          localStorage.setItem('clockifyWorkspaceName', ws.name);
        }
        return { workspaces: workspaces, matched: ws };
      });
    },

    // Fetch summary report for a month → { projectName → { userName → hours } }
    fetchMonth: function (year, month) {
      var wId   = getWorkspaceId();
      var start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0)).toISOString();
      var end   = new Date(Date.UTC(year, month,     0, 23, 59, 59, 999)).toISOString();

      return cfetch(REPORTS + '/workspaces/' + wId + '/reports/summary', {
        method: 'POST',
        body: JSON.stringify({
          dateRangeStart: start,
          dateRangeEnd:   end,
          summaryFilter:  { groups: ['CLIENT', 'USER'] },
        }),
      }).then(function (data) {
        // Build map: { normClientName → { normUserName → hours } }
        // Clockify sums all projects under a client automatically
        var map = {};
        (data.groupOne || []).forEach(function (client) {
          var cKey = norm(client.name);
          if (!cKey || cKey === 'no client' || cKey === 'kein kunde') return; // skip unassigned
          map[cKey] = {};
          (client.children || []).forEach(function (user) {
            // duration is in seconds in summary report
            map[cKey][norm(user.name)] = (user.duration || 0) / 3600;
          });
        });
        return map;
      });
    },

    // Fetch total hours per user for a month (all projects, regardless of client)
    fetchMonthByUser: function (year, month) {
      var wId   = getWorkspaceId();
      var start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0)).toISOString();
      var end   = new Date(Date.UTC(year, month,     0, 23, 59, 59, 999)).toISOString();

      return cfetch(REPORTS + '/workspaces/' + wId + '/reports/summary', {
        method: 'POST',
        body: JSON.stringify({
          dateRangeStart: start,
          dateRangeEnd:   end,
          summaryFilter:  { groups: ['USER'] },
        }),
      }).then(function (data) {
        // { normUserName → totalHours (all projects/clients combined) }
        var map = {};
        (data.groupOne || []).forEach(function (user) {
          map[norm(user.name)] = (user.duration || 0) / 3600;
        });
        return map;
      });
    },

    // Fetch intern hours per user (project name contains 'intern', any client)
    fetchMonthInternByUser: function (year, month) {
      var wId   = getWorkspaceId();
      var start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0)).toISOString();
      var end   = new Date(Date.UTC(year, month,     0, 23, 59, 59, 999)).toISOString();

      return cfetch(REPORTS + '/workspaces/' + wId + '/reports/summary', {
        method: 'POST',
        body: JSON.stringify({
          dateRangeStart: start,
          dateRangeEnd:   end,
          summaryFilter:  { groups: ['CLIENT', 'PROJECT', 'USER'] },
        }),
      }).then(function (data) {
        var map = {};
        (data.groupOne || []).forEach(function (client) {
          (client.children || []).forEach(function (project) {
            if (norm(project.name).indexOf('intern') === -1) return;
            (project.children || []).forEach(function (user) {
              var uKey = norm(user.name);
              map[uKey] = (map[uKey] || 0) + (user.duration || 0) / 3600;
            });
          });
        });
        return map;
      });
    },

    // All projects in workspace
    getProjects: function () {
      var wId = getWorkspaceId();
      return cfetch(BASE + '/workspaces/' + wId + '/projects?page-size=500&archived=false');
    },

    // All users in workspace
    getUsers: function () {
      var wId = getWorkspaceId();
      return cfetch(BASE + '/workspaces/' + wId + '/users?page-size=500');
    },

    // Returns { workspaceName, workspaces[] }
    getWorkspaces: function () {
      return cfetch(BASE + '/workspaces');
    },
  };
})();
