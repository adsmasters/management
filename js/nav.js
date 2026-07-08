(function () {
  'use strict';

  // ── Menüstruktur — EINZIGE Stelle zum Ändern/Umsortieren ──────────────
  // Standalone-Link: { label, href }.  Gruppe mit Dropdown: { label, children:[…] }.
  // 'alt' = weitere Seiten, die diesen Punkt als aktiv markieren (Detailseiten).
  var NAV = [
    { label: 'Übersicht', href: 'index.html' },
    { label: 'Kunden', children: [
      { label: 'Kunden',       href: 'clients.html', alt: ['detail.html'] },
      { label: 'Akquisition',  href: 'acquisition.html' },
      { label: 'CAC-Analyse',  href: 'cac-analyse.html' },
      { label: 'Churn',        href: 'churn.html' },
    ]},
    { label: 'Team', children: [
      { label: 'Mitarbeiter',  href: 'employees.html', alt: ['employee-detail.html'] },
      { label: 'Auslastung',   href: 'utilization.html' },
      { label: 'MA-Umsatz',    href: 'employee-revenue.html' },
    ]},
    { label: 'Finanzen', children: [
      { label: 'Profitabilität',  href: 'profit.html' },
      { label: 'Profit-Funnel',   href: 'funnel.html' },
      { label: 'Umsatz-Verlauf',  href: 'revenue-timeline.html' },
      { label: 'Kostenanalyse',   href: 'kostenanalyse.html' },
    ]},
    { label: 'Rechnungen', children: [
      { label: 'Offene Rechnungen', href: 'open-invoices.html' },
      { label: 'Rechnungs-Check',   href: 'rechnungs-check.html' },
    ]},
    { label: 'Einstellungen', children: [
      { label: 'Zuordnung',    href: 'name-mapping.html' },
      { label: 'Einstellungen', href: 'settings.html' },
    ]},
  ];

  function currentPage() {
    var p = (location.pathname.split('/').pop() || 'index.html');
    return p || 'index.html';
  }
  function matches(leaf, page) {
    if (leaf.href === page) return true;
    return !!(leaf.alt && leaf.alt.indexOf(page) !== -1);
  }

  function render(container) {
    var page = currentPage();
    container.className = 'mainnav';
    container.innerHTML = '';

    NAV.forEach(function (item) {
      if (!item.children) {
        var a = document.createElement('a');
        a.href = item.href;
        a.className = 'nav-link' + (matches(item, page) ? ' active' : '');
        a.textContent = item.label;
        container.appendChild(a);
        return;
      }
      var groupActive = item.children.some(function (c) { return matches(c, page); });
      var group = document.createElement('div');
      group.className = 'nav-group' + (groupActive ? ' active' : '');

      var top = document.createElement('button');
      top.type = 'button';
      top.className = 'nav-top';
      top.innerHTML = escapeHtml(item.label) + ' <span class="caret">▾</span>';
      group.appendChild(top);

      var menu = document.createElement('div');
      menu.className = 'nav-menu';
      item.children.forEach(function (c) {
        var a = document.createElement('a');
        a.href = c.href;
        a.className = matches(c, page) ? 'active' : '';
        a.textContent = c.label;
        menu.appendChild(a);
      });
      group.appendChild(menu);

      // Click-toggle (Touch / Klick), zusätzlich zum CSS-Hover.
      top.addEventListener('click', function (e) {
        e.stopPropagation();
        var wasOpen = group.classList.contains('open');
        closeAll();
        if (!wasOpen) group.classList.add('open');
      });

      container.appendChild(group);
    });
  }

  function closeAll() {
    var groups = document.querySelectorAll('.nav-group.open');
    Array.prototype.forEach.call(groups, function (g) { g.classList.remove('open'); });
  }
  document.addEventListener('click', closeAll);

  function escapeHtml(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function init() {
    var container = document.querySelector('nav.mainnav') || document.querySelector('#mainnav');
    if (container) render(container);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
