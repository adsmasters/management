/**
 * Central clustered navigation. Each page has an empty <nav id="mainnav"></nav>
 * in its header; this script fills it with grouped dropdowns and highlights the
 * active group/item. Single source of truth — menu changes happen only here.
 */
(function () {
  'use strict';

  var GROUPS = [
    { label: 'Übersicht', href: 'index.html' },
    { label: 'Kunden', items: [
      { href: 'clients.html',      label: 'Kunden' },
      { href: 'cac-analyse.html',  label: 'CAC-Analyse' },
      { href: 'churn.html',        label: 'Churn' },
      { href: 'acquisition.html',  label: 'Akquisition' },
    ] },
    { label: 'Team', items: [
      { href: 'employees.html',       label: 'Mitarbeiter' },
      { href: 'utilization.html',     label: 'Auslastung' },
      { href: 'employee-revenue.html',label: 'MA-Umsatz' },
    ] },
    { label: 'Finanzen', items: [
      { href: 'profit.html',          label: 'Profitabilität' },
      { href: 'funnel.html',          label: 'Profit-Funnel' },
      { href: 'kostenanalyse.html',   label: 'Kostenanalyse' },
      { href: 'revenue-timeline.html',label: 'Umsatz-Verlauf' },
    ] },
    { label: 'Rechnungen', items: [
      { href: 'open-invoices.html',   label: 'Offene Rechnungen' },
      { href: 'rechnungs-check.html', label: 'Rechnungs-Check' },
    ] },
    { label: 'Einstellungen', items: [
      { href: 'name-mapping.html',    label: 'Zuordnung' },
      { href: 'settings.html',        label: 'Einstellungen' },
    ] },
  ];

  // Detail sub-pages aren't menu entries themselves; map them to a group so the
  // right top-level item still highlights.
  var PAGE_ALIAS = {
    'detail.html': 'clients.html',
    'employee-detail.html': 'employees.html',
  };

  function currentPage() {
    var p = (location.pathname.split('/').pop() || 'index.html').replace(/[#?].*$/, '');
    if (!p) p = 'index.html';
    return PAGE_ALIAS[p] || p;
  }

  function injectStyles() {
    if (document.getElementById('nav-cluster-styles')) return;
    var css =
      '#mainnav{display:flex;align-items:center;gap:2px;flex-wrap:wrap}' +
      '#mainnav .nav-item{position:relative}' +
      '#mainnav .nav-top{display:inline-flex;align-items:center;gap:4px;padding:7px 12px;border-radius:8px;' +
        'font-size:14px;font-weight:500;color:var(--text-secondary,#64748b);text-decoration:none;cursor:pointer;' +
        'background:none;border:none;font-family:inherit;white-space:nowrap;line-height:1}' +
      '#mainnav .nav-top:hover{background:var(--bg,#f1f5f9);color:var(--text,#1e293b)}' +
      '#mainnav .nav-item.active > .nav-top{color:var(--primary,#4f46e5);font-weight:600;background:var(--primary-light,#eef2ff)}' +
      '#mainnav .nav-caret{font-size:9px;opacity:.6;transition:transform .15s}' +
      '#mainnav .nav-item.open .nav-caret{transform:rotate(180deg)}' +
      '#mainnav .nav-menu{position:absolute;top:calc(100% + 4px);left:0;min-width:190px;background:var(--surface,#fff);' +
        'border:1px solid var(--border,#e2e8f0);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);' +
        'padding:6px;display:none;z-index:200;flex-direction:column;gap:2px}' +
      '#mainnav .nav-item.open .nav-menu,#mainnav .nav-item:hover .nav-menu{display:flex}' +
      '#mainnav .nav-menu a{display:block;padding:8px 12px;border-radius:6px;font-size:13.5px;color:var(--text,#1e293b);' +
        'text-decoration:none;white-space:nowrap}' +
      '#mainnav .nav-menu a:hover{background:var(--bg,#f1f5f9)}' +
      '#mainnav .nav-menu a.active{background:var(--primary-light,#eef2ff);color:var(--primary,#4f46e5);font-weight:600}';
    var s = document.createElement('style');
    s.id = 'nav-cluster-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function build() {
    var nav = document.getElementById('mainnav');
    if (!nav) return;
    injectStyles();
    var cur = currentPage();
    nav.innerHTML = '';

    GROUPS.forEach(function (g) {
      var item = document.createElement('div');
      item.className = 'nav-item';

      if (g.href) {
        var link = document.createElement('a');
        link.className = 'nav-top';
        link.href = g.href;
        link.textContent = g.label;
        if (cur === g.href) item.classList.add('active');
        item.appendChild(link);
      } else {
        var isActiveGroup = g.items.some(function (it) { return it.href === cur; });
        if (isActiveGroup) item.classList.add('active');

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nav-top';
        btn.innerHTML = g.label + ' <span class="nav-caret">▼</span>';
        item.appendChild(btn);

        var menu = document.createElement('div');
        menu.className = 'nav-menu';
        g.items.forEach(function (it) {
          var a = document.createElement('a');
          a.href = it.href;
          a.textContent = it.label;
          if (it.href === cur) a.className = 'active';
          menu.appendChild(a);
        });
        item.appendChild(menu);

        // Click toggle (needed on touch / keyboard; hover handled by CSS on desktop)
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var wasOpen = item.classList.contains('open');
          closeAll();
          if (!wasOpen) item.classList.add('open');
        });
      }
      nav.appendChild(item);
    });

    function closeAll() {
      Array.prototype.forEach.call(nav.querySelectorAll('.nav-item.open'), function (el) { el.classList.remove('open'); });
    }
    document.addEventListener('click', closeAll);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
