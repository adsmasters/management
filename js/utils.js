(function () {
  'use strict';

  window.MONTHS_DE = [
    'Januar','Februar','März','April','Mai','Juni',
    'Juli','August','September','Oktober','November','Dezember'
  ];

  window.ROLES = {
    account_manager: { label: 'Account Manager',        short: 'AM',  cls: 'role-am',     dept: 'am'  },
    advertising:     { label: 'Advertising Manager',    short: 'ADV', cls: 'role-adv',    dept: 'adv' },
    freelancer:      { label: 'Freelancer/Werksstudent', short: 'FL',  cls: 'role-fl',     dept: 'am'  },
    other:           { label: 'Sonstige',               short: '–',   cls: 'role-ignore', dept: null  },
  };

  window.getRoleLabel = (role) => window.ROLES[role]?.label || role;
  window.getRoleShort = (role) => window.ROLES[role]?.short || role;
  window.getRoleCls   = (role) => window.ROLES[role]?.cls   || '';

  // Aggregate per-employee entries → { amH, advH, flH, amTotal, breakdown }
  window.aggregateEntries = function (entries) {
    let amH = 0, advH = 0, flH = 0;
    const breakdown = [];
    (entries || []).forEach(e => {
      const role  = e.employees?.role;
      const hours = e.hours || 0;
      if      (role === 'account_manager') amH  += hours;
      else if (role === 'advertising')     advH += hours;
      else if (role === 'freelancer')      flH  += hours;
      breakdown.push({
        employeeId: e.employee_id,
        name:  e.employees?.name || '?',
        role,
        hours,
      });
    });
    return { amH, advH, flH, amTotal: amH + flH / 3, breakdown };
  };

  window.parseHours = function (input) {
    if (input === '' || input == null) return 0;
    const s = String(input).trim();
    if (s.includes(':')) {
      const [h, m] = s.split(':');
      return (parseInt(h, 10) || 0) + (parseInt(m, 10) || 0) / 60;
    }
    return parseFloat(s) || 0;
  };

  window.fmtHours = function (h) {
    if (h == null) return '—';
    const neg  = h < 0;
    const abs  = Math.abs(h);
    const hrs  = Math.floor(abs);
    const mins = Math.round((abs - hrs) * 60);
    return `${neg ? '-' : ''}${hrs}:${String(mins).padStart(2, '0')} h`;
  };

  window.fmtDiff = function (diff) {
    if (diff == null) return { text: '—', cls: 'zero' };
    const text = (diff > 0 ? '+' : '') + window.fmtHours(diff);
    const cls  = diff > 0.05 ? 'positive' : diff < -0.05 ? 'negative' : 'zero';
    return { text, cls };
  };

  window.currentYearMonth = function () {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  };

  window.svgChevron = () =>
    '<svg class="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 4 10 8 6 12"/></svg>';

  window.svgArrow = () =>
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="8" x2="13" y2="8"/><polyline points="9 4 13 8 9 12"/></svg>';

  window.svgPencil = () =>
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
})();
