(function () {
  'use strict';

  var yearSel  = document.getElementById('yearSelect');
  var metricSel= document.getElementById('metricSelect');
  var loadBtn  = document.getElementById('loadBtn');
  var loadingEl= document.getElementById('loading');
  var contentEl= document.getElementById('content');
  var errorEl  = document.getElementById('error');
  var gridBody = document.getElementById('gridBody');
  var gridHead = document.getElementById('gridHead');
  var scenarioWrap = document.getElementById('scenarioWrap');

  var MONTHS = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  var ym = window.currentYearMonth();

  // ── Jahr-Auswahl ──────────────────────────────────────────────────────
  for (var y = ym.year + 1; y >= ym.year - 3; y--) {
    var o = document.createElement('option'); o.value = y; o.textContent = y; yearSel.appendChild(o);
  }
  yearSel.value = ym.year;

  function fmtEur(n) { return Math.round(n).toLocaleString('de-DE') + ' €'; }
  function fmtH(n)   { return (Math.round(n * 10) / 10).toLocaleString('de-DE') + ' h'; }
  function norm(s)   { return (s || '').trim().toLowerCase(); }

  function getExcludeKeywords() {
    return (localStorage.getItem('revenueExcludeKeywords') || '')
      .split('\n').map(function (k) { return k.trim().toLowerCase(); }).filter(Boolean);
  }
  function isExcluded(name) {
    var kws = getExcludeKeywords(); if (!kws.length) return false;
    var n = (name || '').toLowerCase();
    return kws.some(function (kw) { return n.includes(kw); });
  }

  // ── Arbeitstage / Feiertage ───────────────────────────────────────────
  function getWorkDays(year, month) {
    var count = 0, days = new Date(year, month, 0).getDate();
    for (var d = 1; d <= days; d++) { var w = new Date(year, month - 1, d).getDay(); if (w >= 1 && w <= 5) count++; }
    return count;
  }
  function holidayWorkdaysByMonth(year) {
    var a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),
        g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,
        m=Math.floor((a+11*h+22*l)/451),mo=Math.floor((h+l-7*m+114)/31),dy=((h+l-7*m+114)%31)+1;
    var E=new Date(year,mo-1,dy); function add(dt,n){var r=new Date(dt);r.setDate(r.getDate()+n);return r;}
    var hs=[new Date(year,0,1),add(E,-2),add(E,1),new Date(year,4,1),add(E,39),add(E,50),
            new Date(year,9,3),new Date(year,11,25),new Date(year,11,26)];
    var counts={}; hs.forEach(function(dt){var w=dt.getDay(); if(w>=1&&w<=5){var mm=dt.getMonth()+1; counts[mm]=(counts[mm]||0)+1;}});
    return counts;
  }

  // ── Szenario (localStorage) ───────────────────────────────────────────
  function loadScenario() {
    try { return JSON.parse(localStorage.getItem('empRevScenario') || '{}'); } catch (e) { return {}; }
  }
  function saveScenario(s) { localStorage.setItem('empRevScenario', JSON.stringify(s)); }
  var scenario = loadScenario();
  if (!scenario.lost) scenario.lost = {};          // { clientId: fromMonth(1-12) }
  if (!scenario.prospects) scenario.prospects = []; // [{id,name,amEmpId,advEmpId,amBudget,advBudget,revenue,startMonth}]

  var DATA = null; // geladene Rohdaten
  var COMP = null; // berechnete Maps (für Drilldown-Modal)

  // "Prognose-Monat" = laufender + zukünftige Monate (Ist ist noch unvollständig)
  function isFuture(year, m) {
    return year > ym.year || (year === ym.year && m >= ym.month);
  }

  // ── Daten laden ───────────────────────────────────────────────────────
  function loadData() {
    var year = parseInt(yearSel.value);
    errorEl.innerHTML = '';
    loadingEl.classList.remove('hidden');
    contentEl.classList.add('hidden');

    var monthNums = [];
    for (var m = 1; m <= 12; m++) monthNums.push(m);

    Promise.all([
      window.db.employees.listActive(),
      window.db.clients.list(),
      window.db.entries.forYear(year),
      window.db.mappings.list(),
      window.db.utilHours.forYear(year),
      window.db.absences.forYear(year).catch(function () { return []; }),
      Promise.all(monthNums.map(function (m) { return window.db.revenue.forMonth(year, m); })),
      Promise.all(monthNums.map(function (m) { return window.db.adjustments.forMonth(year, m).catch(function () { return []; }); })),
      window.db.revenueExclusions.listAll().catch(function () { return []; }),
      window.db.maRevenueExclusions.listAll().catch(function () { return []; }),
      Promise.all(monthNums.map(function (m) { return window.db.revenueServices.forMonth(year, m).catch(function () { return []; }); })),
      window.db.revenueServiceAssignments.listAll().catch(function () { return []; }),
      window.db.residualAssignments.listAll().catch(function () { return []; }),
    ]).then(function (r) {
      DATA = {
        year: year,
        employees: r[0], clients: r[1], entries: r[2], mappings: r[3],
        utilHours: r[4], absences: r[5], revenueByMonth: r[6], adjByMonth: r[7],
        exclusions: r[8] || [],
        maExclusions: r[9] || [],
        svcByMonth: r[10] || [],
        svcAssignments: r[11] || [],
        residualAssignments: r[12] || [],
      };
      loadingEl.classList.add('hidden');
      contentEl.classList.remove('hidden');
      compute();
    }).catch(function (e) {
      loadingEl.classList.add('hidden');
      errorEl.innerHTML = '<div class="alert alert-danger">⚠️ ' + e.message + '</div>';
    });
  }

  // ── Berechnung (Ist + Forecast + Szenario) ────────────────────────────
  function compute() {
    var year = DATA.year;
    var employees = DATA.employees;
    var clients = DATA.clients;

    // Mappings: clientId → [lexoffice_name]
    var mappingsByClient = {};
    DATA.mappings.forEach(function (mp) {
      (mappingsByClient[mp.client_id] = mappingsByClient[mp.client_id] || []).push(mp.lexoffice_name);
    });

    // Rechnungen (LexOffice-Kontakte), die NICHT auf Mitarbeiter zugerechnet
    // werden (z.B. eine von zwei Rechnungen eines Kunden, die der Inhaber macht).
    // Der Umsatz bleibt im Kunden-Gesamt/Profitabilität, fällt nur hier raus.
    var maExclSet = {};
    (DATA.maExclusions || []).forEach(function (x) { maExclSet[norm(x.contact_name)] = true; });

    // Umsatz je Kunde je Monat (Ist) ------------------------------------
    // revenueMap[m] = { normContact → betrag }
    var clientRevMonth = {}; // clientId → {m → revenue} (MA-zurechenbar, ohne ausgeschlossene Rechnungen)
    var revMapByMonth = {};  // m → { normContact → betrag }  (für Modal-Rechnungsliste)
    var maExclRevByMonth = {}; // clientId → {m → ausgeschlossener (Inhaber-)Umsatz}
    for (var m = 1; m <= 12; m++) {
      var revMap = {};
      (DATA.revenueByMonth[m - 1] || []).forEach(function (row) {
        if (isExcluded(row.contact_name)) return;
        var key = norm(row.contact_name);
        revMap[key] = (revMap[key] || 0) + (row.total_amount || 0);
      });
      revMapByMonth[m] = revMap;
      // Kunden-Umsatzkorrektur (adjustments.revenue_deduction) je Kunde
      var dedByClient = {};
      (DATA.adjByMonth[m - 1] || []).forEach(function (a) {
        dedByClient[a.client_id] = (dedByClient[a.client_id] || 0) + (a.revenue_deduction || 0);
      });
      clients.forEach(function (c) {
        var rev = 0, maExclRev = 0;
        var mapped = mappingsByClient[c.id] || [];
        if (mapped.length) {
          mapped.forEach(function (lx) { var v = revMap[norm(lx)] || 0; if (maExclSet[norm(lx)]) maExclRev += v; else rev += v; });
        } else {
          var cn = norm(c.lexoffice_name || c.name), cn2 = norm(c.name);
          var v0 = revMap[cn] || revMap[cn2] || 0;
          if (maExclSet[cn] || maExclSet[cn2]) maExclRev += v0; else rev = v0;
        }
        rev += dedByClient[c.id] || 0;
        (clientRevMonth[c.id] = clientRevMonth[c.id] || {})[m] = rev;
        (maExclRevByMonth[c.id] = maExclRevByMonth[c.id] || {})[m] = maExclRev;
      });
    }

    // Leistungs-Umsatz je Kunde je Monat (aus revenue_services) ----------
    var clientSvcMonth = {}; // cid → { m → { service → amount } }
    for (var ms = 1; ms <= 12; ms++) {
      var byContactSvc = {};   // normContact → { service → amount }
      (DATA.svcByMonth[ms - 1] || []).forEach(function (r) {
        if (isExcluded(r.contact_name)) return;
        var kc = norm(r.contact_name);
        (byContactSvc[kc] = byContactSvc[kc] || {});
        byContactSvc[kc][r.service] = (byContactSvc[kc][r.service] || 0) + (r.amount || 0);
      });
      clients.forEach(function (c) {
        var mapped = mappingsByClient[c.id] || [c.lexoffice_name || c.name];
        var agg = {};
        mapped.forEach(function (lx) {
          if (maExclSet[norm(lx)]) return;            // Kontakt-Ausschluss respektieren
          var cm = byContactSvc[norm(lx)]; if (!cm) return;
          Object.keys(cm).forEach(function (sv) { agg[sv] = (agg[sv] || 0) + cm[sv]; });
        });
        (clientSvcMonth[c.id] = clientSvcMonth[c.id] || {})[ms] = agg;
      });
    }
    // Leistungs-Zuweisungen: cid → service → [employee_id]
    var svcAssign = {};
    (DATA.svcAssignments || []).forEach(function (a) {
      var cc = (svcAssign[a.client_id] = svcAssign[a.client_id] || {});
      (cc[a.service] = cc[a.service] || []).push(a.employee_id);
    });

    // Stunden je Kunde je Monat + je (Kunde,MA) -------------------------
    var clientHoursMonth = {}; // clientId → {m → totalHours}
    var entryByClientEmpMonth = {}; // clientId → m → empId → hours
    DATA.entries.forEach(function (e) {
      var cm = (clientHoursMonth[e.client_id] = clientHoursMonth[e.client_id] || {});
      cm[e.month] = (cm[e.month] || 0) + (e.hours || 0);
      var cc = (entryByClientEmpMonth[e.client_id] = entryByClientEmpMonth[e.client_id] || {});
      var mm = (cc[e.month] = cc[e.month] || {});
      mm[e.employee_id] = (mm[e.employee_id] || 0) + (e.hours || 0);
    });

    // Ist: Umsatz je MA je Monat ---------------------------------------
    // Modell:
    //  • Freelancer mit Verrechnungssatz (billing_rate > 0) bekommen
    //    Stunden × Satz. Der REST des Kundenumsatzes geht an die übrigen
    //    Mitarbeiter ("Owner") nach Stundenanteil.
    //  • Übersteigt die Summe der Freelancer-Ansprüche den Kundenumsatz
    //    (z.B. reiner Bild-Kunde), werden sie anteilig auf den Umsatz
    //    gedeckelt → der Freelancer bekommt praktisch den ganzen Umsatz.
    //  • Ausgeschlossene (Kunde × MA) zählen NICHT für den Umsatz
    //    (ihre Stunden bleiben aber sichtbar).
    var empRev = {};   // empId → {m → revenue}
    var empHours = {};  // empId → {m → kundenstunden}
    var empClientRevMonth = {}; // cid → m → eid → revenue (für Modal-Aufschlüsselung)
    function addRev(empId, m, v) { (empRev[empId] = empRev[empId] || {})[m] = ((empRev[empId] || {})[m] || 0) + v; }
    function addHrs(empId, m, v) { (empHours[empId] = empHours[empId] || {})[m] = ((empHours[empId] || {})[m] || 0) + v; }
    function addClientRev(cid, m, eid, v) {
      var a = (empClientRevMonth[cid] = empClientRevMonth[cid] || {});
      var b = (a[m] = a[m] || {});
      b[eid] = (b[eid] || 0) + v;
    }

    var empById = {};
    employees.forEach(function (e) { empById[e.id] = e; });
    var excludedSet = {}; // 'cid|eid' → true
    (DATA.exclusions || []).forEach(function (x) { excludedSet[x.client_id + '|' + x.employee_id] = true; });

    for (var cid in entryByClientEmpMonth) {
      for (var mo in entryByClientEmpMonth[cid]) {
        var rev  = (clientRevMonth[cid] && clientRevMonth[cid][mo]) || 0;
        var emps = entryByClientEmpMonth[cid][mo];

        // Stunden immer tracken (auch ausgeschlossene – sie haben gearbeitet)
        for (var eidH in emps) addHrs(eidH, mo, emps[eidH]);
        if (!rev) continue;

        // ── Leistungs-Zuweisung: bestimmte Leistungen gezielt zurechnen ──
        // Zugewiesene Leistungen werden aus dem Kundenumsatz herausgelöst und
        // NUR unter den zugewiesenen MA verteilt (nach deren Stunden am Kunden;
        // haben sie keine Stunden → gleichmäßig). Der Rest läuft unten wie
        // bisher nach Stunden über alle.
        var svcRule = svcAssign[cid];
        if (svcRule) {
          var svcAmts = (clientSvcMonth[cid] || {})[mo] || {};
          var assignedTotal = 0;
          Object.keys(svcRule).forEach(function (sv) {
            var eids = svcRule[sv];
            var amt = svcAmts[sv] || 0;
            if (!eids.length || amt <= 0) return;
            var hrsSum = eids.reduce(function (s, e) { return s + (emps[e] || 0); }, 0);
            eids.forEach(function (e) {
              var share = hrsSum > 0 ? (emps[e] || 0) / hrsSum : 1 / eids.length;
              var v = amt * share;
              addRev(e, mo, v); addClientRev(cid, mo, e, v);
            });
            assignedTotal += amt;
          });
          rev = Math.max(0, rev - assignedTotal);
          if (!rev) continue;
        }

        // Teilnehmer für die Umsatzverteilung (Ausgeschlossene raus)
        var freelancers = [], owners = [], ownerHrs = 0, claimSum = 0;
        for (var eid in emps) {
          if (excludedSet[cid + '|' + eid]) continue;
          var hrs  = emps[eid];
          var rate = +((empById[eid] || {}).billing_rate) || 0;
          if (rate > 0) { var claim = hrs * rate; freelancers.push({ eid: eid, claim: claim }); claimSum += claim; }
          else          { owners.push({ eid: eid, hrs: hrs }); ownerHrs += hrs; }
        }

        if (freelancers.length && claimSum >= rev) {
          // Ansprüche ≥ Umsatz → anteilig deckeln, Owner bekommen 0
          freelancers.forEach(function (f) {
            var v = rev * f.claim / claimSum;
            addRev(f.eid, mo, v); addClientRev(cid, mo, f.eid, v);
          });
        } else {
          // Freelancer bekommen Satz-Wert; Rest an Owner nach Stunden
          freelancers.forEach(function (f) { addRev(f.eid, mo, f.claim); addClientRev(cid, mo, f.eid, f.claim); });
          var remaining = rev - claimSum;
          if (ownerHrs > 0 && remaining > 0) {
            owners.forEach(function (o) {
              var v = remaining * o.hrs / ownerHrs;
              addRev(o.eid, mo, v); addClientRev(cid, mo, o.eid, v);
            });
          }
        }
      }
    }

    // ── Nicht zugeordneter (Rest-)Umsatz je Kunde je Monat ──────────────
    // Voller Kundenumsatz (inkl. bewusst ausgeschlossener Rechnungen) minus was
    // Mitarbeiter tatsächlich bekommen haben = nicht zugeordnet. Ist der Kunde
    // einem MA/Inhaber zugewiesen, wird dieser Rest ihm gutgeschrieben.
    var ownerAssign = {}; // cid → eid
    (DATA.residualAssignments || []).forEach(function (a) { ownerAssign[a.client_id] = a.employee_id; });
    var residualByClientMonth = {}; // cid → { m → rest }
    clients.forEach(function (c) {
      for (var rm = 1; rm <= 12; rm++) {
        if (isFuture(year, rm)) continue; // nur Ist-Monate
        var full = ((clientRevMonth[c.id] || {})[rm] || 0) + ((maExclRevByMonth[c.id] || {})[rm] || 0);
        if (full <= 0) continue;
        var attr = 0;
        var ecm = (empClientRevMonth[c.id] || {})[rm] || {};
        Object.keys(ecm).forEach(function (e) { attr += ecm[e] || 0; });
        var resid = full - attr;
        if (resid < 0.5) resid = 0;
        (residualByClientMonth[c.id] = residualByClientMonth[c.id] || {})[rm] = resid;
        var owner = ownerAssign[c.id];
        if (owner && resid > 0) { addRev(owner, rm, resid); addClientRev(c.id, rm, owner, resid); }
      }
    });

    // Kapazität: verfügbare Stunden je MA je Monat ----------------------
    var holiday = holidayWorkdaysByMonth(year);
    var availBase = {};
    for (var mm2 = 1; mm2 <= 12; mm2++) availBase[mm2] = (getWorkDays(year, mm2) - (holiday[mm2] || 0)) * 8;
    var absenceMap = {}; // empId → m → days
    DATA.absences.forEach(function (a) {
      (absenceMap[a.employee_id] = absenceMap[a.employee_id] || {})[a.month] = (a.vacation_days || 0) + (a.sick_days || 0);
    });
    function available(empId, m) { return Math.max(0, availBase[m] - ((absenceMap[empId] || {})[m] || 0) * 8); }

    // util_hours (tatsächliche Gesamtstunden) je MA je Monat
    var utilMap = {};
    DATA.utilHours.forEach(function (u) { (utilMap[u.employee_id] = utilMap[u.employee_id] || {})[u.month] = u.hours || 0; });

    // Abgeschlossene (Ist-)Monate für Durchschnitte
    function completed(m) { return year < ym.year || (year === ym.year && m < ym.month); }
    // Ø der letzten bis zu 3 abgeschlossenen Monate mit Wert
    function avgRecent(getter) {
      var rec = [];
      for (var m = 12; m >= 1 && rec.length < 3; m--) {
        if (!completed(m)) continue;
        var v = getter(m);
        if (v > 0) rec.push(v);
      }
      return rec.length ? rec.reduce(function (a, b) { return a + b; }, 0) / rec.length : 0;
    }
    function avgUtil(empId) {
      return avgRecent(function (m) {
        var u = (utilMap[empId] || {})[m];
        return (u != null && u > 0) ? u : ((empHours[empId] || {})[m] || 0);
      });
    }
    function avgEmpRev(empId) { return avgRecent(function (m) { return (empRev[empId] || {})[m] || 0; }); }
    function avgEmpClientHrs(empId, cid) {
      return avgRecent(function (m) { return (((entryByClientEmpMonth[cid] || {})[m]) || {})[empId] || 0; });
    }
    function avgEmpClientRev(empId, cid) {
      return avgRecent(function (m) {
        var h = (((entryByClientEmpMonth[cid] || {})[m]) || {})[empId] || 0;
        var tot = (clientHoursMonth[cid] || {})[m] || 0;
        var r = (clientRevMonth[cid] || {})[m] || 0;
        return tot > 0 ? r * h / tot : 0;
      });
    }

    // Forecast/Grundlast je MA je laufendem+zukünftigem Monat -----------
    // Grundlast = Ø tatsächl. Stunden/Umsatz der letzten 3 Monate,
    // ± Szenario (verlorene Kunden abziehen, Neukunden addieren).
    var fcRev = {}, fcHours = {};
    employees.forEach(function (emp) {
      var baseH = avgUtil(emp.id);
      var baseR = avgEmpRev(emp.id);
      for (var m = 1; m <= 12; m++) {
        if (!isFuture(year, m)) continue; // nur laufender + zukünftige Monate
        var h = baseH, r = baseR;
        // verlorene Kunden ab Verlustmonat → freigewordene Kapazität/Umsatz abziehen
        clients.forEach(function (c) {
          var lost = scenario.lost[c.id];
          if (!lost || m < lost) return;
          if (c.am_employee_id === emp.id || c.adv_employee_id === emp.id) {
            h -= avgEmpClientHrs(emp.id, c.id);
            r -= avgEmpClientRev(emp.id, c.id);
          }
        });
        // potenzielle Neukunden ab Startmonat → zusätzliche Last/Umsatz
        scenario.prospects.forEach(function (p) {
          if (m < (p.startMonth || 1)) return;
          var amB = +p.amBudget || 0, advB = +p.advBudget || 0, tot = amB + advB, rev = +p.revenue || 0;
          if (p.amEmpId === emp.id) { h += amB; r += tot ? rev * amB / tot : (advB ? 0 : rev); }
          if (p.advEmpId === emp.id) { h += advB; r += tot ? rev * advB / tot : 0; }
        });
        (fcHours[emp.id] = fcHours[emp.id] || {})[m] = Math.max(0, h);
        (fcRev[emp.id] = fcRev[emp.id] || {})[m] = Math.max(0, r);
      }
    });
    var avgHrs = {}; // (nicht mehr separat genutzt)

    // Für Drilldown-Modal speichern
    COMP = {
      year: year, employees: employees, clients: clients,
      entryByClientEmpMonth: entryByClientEmpMonth,
      clientHoursMonth: clientHoursMonth,
      clientRevMonth: clientRevMonth,
      empClientRevMonth: empClientRevMonth,
      excludedSet: excludedSet,
      mappingsByClient: mappingsByClient,
      revMapByMonth: revMapByMonth,
      maExclSet: maExclSet,
      clientSvcMonth: clientSvcMonth,
      svcAssign: svcAssign,
      residualByClientMonth: residualByClientMonth,
      ownerAssign: ownerAssign,
      maExclRevByMonth: maExclRevByMonth,
    };

    render({
      year: year, employees: employees,
      empRev: empRev, empHours: empHours, utilMap: utilMap,
      fcRev: fcRev, fcHours: fcHours, available: available, avgHrs: avgHrs,
    });
    renderScenario(clients, employees);
    renderUnattributed();
  }

  // ── Nicht zugeordneter Umsatz (Panel) ─────────────────────────────────
  function renderUnattributed() {
    var wrap = document.getElementById('unattributedWrap');
    if (!wrap || !COMP) return;
    var clientsById = {};
    COMP.clients.forEach(function (c) { clientsById[c.id] = c; });
    var empNameById = {};
    COMP.employees.forEach(function (e) { empNameById[e.id] = e.name; });

    // Rest je Kunde JE MONAT sammeln (nur Monate mit offenem/zugewiesenem Rest)
    var MS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
    var rbc = COMP.residualByClientMonth || {};
    var monthSet = {}, perClient = {};
    Object.keys(rbc).forEach(function (cid) {
      var byM = rbc[cid] || {}, sum = 0, months = {};
      Object.keys(byM).forEach(function (m) { var v = byM[m] || 0; if (v > 0.5) { months[m] = v; sum += v; monthSet[m] = 1; } });
      if (sum > 0.5) perClient[cid] = { months: months, sum: sum };
    });
    var monthCols = Object.keys(monthSet).map(Number).sort(function (a, b) { return a - b; });
    var rows = Object.keys(perClient).map(function (cid) {
      return { cid: cid, name: (clientsById[cid] || {}).name || '?', months: perClient[cid].months, sum: perClient[cid].sum, owner: COMP.ownerAssign[cid] || null };
    }).sort(function (a, b) { return b.sum - a.sum; });

    if (!rows.length) {
      wrap.innerHTML = '<h2 style="font-size:16px;font-weight:700;margin:0 0 10px">Nicht zugeordneter Umsatz</h2>' +
        '<div class="card" style="padding:14px;color:var(--text-secondary);font-size:13px">✓ Für ' + COMP.year + ' ist der gesamte Umsatz einem Mitarbeiter zugeordnet.</div>';
      return;
    }

    var empOptions = COMP.employees.map(function (e) { return '<option value="' + e.id + '">' + e.name + '</option>'; }).join('');
    var footOpen = {}; var totalOpen = 0;
    monthCols.forEach(function (m) { footOpen[m] = 0; });

    var body = rows.map(function (r) {
      var monthCells = monthCols.map(function (m) {
        var v = r.months[m] || 0;
        if (!r.owner) footOpen[m] += v;
        return '<td class="right" style="padding:7px 10px;font-variant-numeric:tabular-nums;color:' + (v ? 'var(--text)' : 'var(--text-muted,#9aa4b2)') + '">' + (v ? fmtEur(v) : '–') + '</td>';
      }).join('');
      if (!r.owner) totalOpen += r.sum;
      var action;
      if (r.owner) {
        action = '<span style="display:inline-flex;align-items:center;gap:6px;background:#eef2ff;color:var(--primary);border-radius:10px;padding:2px 10px;font-size:12px;font-weight:600;white-space:nowrap">→ ' +
          (empNameById[r.owner] || '?') +
          ' <span class="res-unassign" data-cid="' + r.cid + '" title="Zuweisung entfernen" style="cursor:pointer">×</span></span>';
      } else {
        action = '<select class="res-assign" data-cid="' + r.cid + '" style="font-size:12px;border:1px solid var(--border);border-radius:var(--radius);padding:3px 6px;background:var(--surface);color:var(--text)"><option value="">→ zuweisen an…</option>' + empOptions + '</select>';
      }
      return '<tr><td style="padding:7px 12px;white-space:nowrap;font-weight:600">' + r.name + '</td>' + monthCells +
        '<td class="right" style="padding:7px 12px;font-variant-numeric:tabular-nums;font-weight:700">' + fmtEur(r.sum) + '</td>' +
        '<td class="right" style="padding:7px 12px">' + action + '</td></tr>';
    }).join('');

    var monthHead = monthCols.map(function (m) { return '<th class="right" style="padding:6px 10px">' + MS[(m - 1) % 12] + '</th>'; }).join('');
    var footCells = monthCols.map(function (m) { return '<td class="right" style="padding:8px 10px;font-variant-numeric:tabular-nums">' + (footOpen[m] > 0.5 ? fmtEur(footOpen[m]) : '–') + '</td>'; }).join('');

    wrap.innerHTML = '<h2 style="font-size:16px;font-weight:700;margin:0 0 10px">Nicht zugeordneter Umsatz <span style="font-weight:400;font-size:13px;color:var(--text-secondary)">· ' + COMP.year + ' (Ist) · je Monat</span></h2>' +
      '<div class="card" style="padding:0;overflow-x:auto">' +
      '<div style="padding:10px 12px;font-size:12px;color:var(--text-secondary);border-bottom:1px solid var(--border)">Umsatz, der auf keinem Mitarbeiter landet (keine Stunden gebucht, bewusst ausgeschlossene Rechnungen, oder Zurechnungs-Rest) – aufgeschlüsselt nach Monat. Weise ihn z.B. dir selbst zu (gilt für alle betroffenen Monate). Gesamtumsatz &amp; Profitabilität bleiben unberührt.</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="text-align:left;color:var(--text-secondary);font-size:11px;text-transform:uppercase">' +
      '<th style="padding:6px 12px">Kunde</th>' + monthHead + '<th class="right" style="padding:6px 12px">Summe</th><th class="right" style="padding:6px 12px">Zuweisen</th></tr></thead>' +
      '<tbody>' + body + '</tbody>' +
      '<tfoot><tr style="font-weight:700;border-top:2px solid var(--border)"><td style="padding:8px 12px">Summe offen</td>' + footCells +
      '<td class="right" style="padding:8px 12px;font-variant-numeric:tabular-nums">' + fmtEur(totalOpen) + '</td><td></td></tr></tfoot>' +
      '</table></div>';

    wrap.querySelectorAll('.res-assign').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var eid = sel.value; if (!eid) return;
        var cid = sel.getAttribute('data-cid');
        sel.disabled = true;
        window.db.residualAssignments.set(cid, eid).then(function () {
          DATA.residualAssignments = (DATA.residualAssignments || []).filter(function (a) { return String(a.client_id) !== String(cid); });
          DATA.residualAssignments.push({ client_id: cid, employee_id: eid });
          compute();
        }).catch(function (e) { alert('Fehler: ' + e.message); sel.disabled = false; });
      });
    });
    wrap.querySelectorAll('.res-unassign').forEach(function (x) {
      x.addEventListener('click', function () {
        var cid = x.getAttribute('data-cid');
        window.db.residualAssignments.remove(cid).then(function () {
          DATA.residualAssignments = (DATA.residualAssignments || []).filter(function (a) { return String(a.client_id) !== String(cid); });
          compute();
        }).catch(function (e) { alert('Fehler: ' + e.message); });
      });
    });
  }

  // ── Rendering Hauptgrid ───────────────────────────────────────────────
  function render(M) {
    var metric = metricSel.value; // revenue | hours | free
    var year = M.year;

    // Kopf
    var head = '<th style="min-width:170px">Mitarbeiter</th>';
    for (var m = 1; m <= 12; m++) {
      var fut = isFuture(year, m);
      head += '<th class="right' + (fut ? ' fc' : '') + '">' + MONTHS[m - 1] + (fut ? ' <span class="fc-tag">P</span>' : '') + '</th>';
    }
    head += '<th class="right" style="border-left:2px solid var(--border)">Σ Jahr</th>';
    gridHead.innerHTML = head;

    function valueFor(empId, m) {
      var fut = isFuture(year, m);
      if (metric === 'revenue') {
        return fut ? ((M.fcRev[empId] || {})[m] || 0) : ((M.empRev[empId] || {})[m] || 0);
      }
      if (metric === 'hours') {
        if (fut) return (M.fcHours[empId] || {})[m] || 0;
        // Ist: tatsächliche Gesamtstunden (util_hours) falls vorhanden, sonst Kundenstunden
        var u = (M.utilMap[empId] || {})[m];
        return (u != null && u > 0) ? u : ((M.empHours[empId] || {})[m] || 0);
      }
      // free = verfügbar − gebucht
      var booked = fut ? ((M.fcHours[empId] || {})[m] || 0)
                       : (((M.utilMap[empId] || {})[m] > 0) ? M.utilMap[empId][m] : ((M.empHours[empId] || {})[m] || 0));
      return M.available(empId, m) - booked;
    }

    function fmtVal(v) {
      if (metric === 'revenue') return fmtEur(v);
      return fmtH(v);
    }

    var rows = '';
    var colTot = {}; // m → sum (für Summenzeile bei revenue/hours)
    M.employees.forEach(function (emp) {
      var rowSum = 0;
      var cells = '';
      for (var m = 1; m <= 12; m++) {
        var v = valueFor(emp.id, m);
        var fut = isFuture(year, m);
        rowSum += v;
        colTot[m] = (colTot[m] || 0) + v;
        var cls = 'right' + (fut ? ' fc' : '');
        if (metric === 'free') cls += v < 0 ? ' neg' : (v > 0 ? ' pos' : '');
        cells += '<td class="' + cls + '">' + (v === 0 ? '<span class="muted">–</span>' : fmtVal(v)) + '</td>';
      }
      rows += '<tr class="emp-row" data-emp="' + emp.id + '" title="Klick: Aufschlüsselung nach Kunde"><td class="emp">' + emp.name + ' <span class="role">' + window.getRoleShort(emp.role) + '</span></td>' +
        cells + '<td class="right tot">' + (metric === 'free' ? '' : fmtVal(rowSum)) + '</td></tr>';
    });

    // Summenzeile (nur revenue/hours sinnvoll)
    if (metric !== 'free') {
      var sumCells = ''; var grand = 0;
      for (var m2 = 1; m2 <= 12; m2++) { sumCells += '<td class="right tot">' + fmtVal(colTot[m2] || 0) + '</td>'; grand += colTot[m2] || 0; }
      rows += '<tr class="sum-row"><td class="emp">Gesamt</td>' + sumCells + '<td class="right tot">' + fmtVal(grand) + '</td></tr>';
    }

    gridBody.innerHTML = rows;

    gridBody.querySelectorAll('tr.emp-row').forEach(function (tr) {
      tr.addEventListener('click', function () { openEmpModal(tr.getAttribute('data-emp')); });
    });
  }

  // ── Drilldown-Modal: Aufschlüsselung je Kunde ─────────────────────────
  var modalOv    = document.getElementById('empModal');
  var modalTitle = document.getElementById('empModalTitle');
  var modalSub   = document.getElementById('empModalSub');
  var modalMonth = document.getElementById('empModalMonth');
  var modalBody  = document.getElementById('empModalBody');
  var modalEmpId = null;

  document.getElementById('empModalClose').addEventListener('click', closeModal);
  modalOv.addEventListener('click', function (e) { if (e.target === modalOv) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
  modalMonth.addEventListener('change', renderModalBody);
  function closeModal() { modalOv.classList.remove('open'); }

  function openEmpModal(empId) {
    if (!COMP) return;
    modalEmpId = empId;
    var emp = COMP.employees.find(function (e) { return e.id === empId; });
    modalTitle.textContent = (emp ? emp.name : '?') + ' – Aufschlüsselung nach Kunde';
    modalSub.textContent = 'Umsatz anteilig: MA-Stunden ÷ Kunden-Stunden gesamt × Kunden-Umsatz';
    // Monatsauswahl (nur Ist-Monate, da Forecast budgetbasiert ist)
    var opts = '<option value="all">Ganzes Jahr (Ist)</option>';
    for (var m = 1; m <= 12; m++) {
      if (isFuture(COMP.year, m)) continue;
      opts += '<option value="' + m + '">' + MONTHS[m - 1] + ' ' + COMP.year + '</option>';
    }
    modalMonth.innerHTML = opts;
    modalMonth.value = 'all';
    renderModalBody();
    modalOv.classList.add('open');
  }

  function renderModalBody() {
    var empId = modalEmpId;
    var scope = modalMonth.value; // 'all' | monthNumber
    var clientsById = {};
    COMP.clients.forEach(function (c) { clientsById[c.id] = c; });

    function monthsInScope() {
      if (scope === 'all') {
        var arr = []; for (var m = 1; m <= 12; m++) if (!isFuture(COMP.year, m)) arr.push(m); return arr;
      }
      return [parseInt(scope)];
    }

    var rows = [];
    var totHrs = 0, totRev = 0;
    Object.keys(COMP.entryByClientEmpMonth).forEach(function (cid) {
      var hrs = 0, rev = 0, cTotH = 0, cRev = 0;
      monthsInScope().forEach(function (m) {
        var emps = (COMP.entryByClientEmpMonth[cid][m]) || {};
        var h = emps[empId] || 0;
        if (!h) return;
        var totalH = (COMP.clientHoursMonth[cid] || {})[m] || 0;
        var r = (COMP.clientRevMonth[cid] || {})[m] || 0;
        hrs += h;
        cTotH += totalH;
        cRev += r;
        rev += (((COMP.empClientRevMonth[cid] || {})[m] || {})[empId]) || 0;
      });
      if (hrs > 0) {
        rows.push({ cid: cid, name: (clientsById[cid] || {}).name || '?', hrs: hrs, rev: rev, cTotH: cTotH, cRev: cRev,
                    excluded: !!COMP.excludedSet[cid + '|' + empId] });
        totHrs += hrs; totRev += rev;
      }
    });
    rows.sort(function (a, b) { return b.rev - a.rev || b.hrs - a.hrs; });

    var single = scope !== 'all';
    var html = '<div class="table-wrap"><table class="mini-table"><thead><tr>' +
      '<th>Kunde</th><th class="right">MA-Std</th>' +
      (single ? '<th class="right">Kunden-Std ges.</th><th class="right">Anteil</th><th class="right">Kunden-Umsatz</th>' : '') +
      '<th class="right">MA-Umsatz</th><th></th></tr></thead><tbody>';

    if (!rows.length) {
      html += '<tr><td colspan="' + (single ? 7 : 4) + '" class="muted">Keine Stunden in diesem Zeitraum.</td></tr>';
    } else {
      rows.forEach(function (r) {
        var share = (single && r.cTotH > 0) ? (r.hrs / r.cTotH * 100).toFixed(1) + ' %' : '';
        var nameCell = r.name + (r.excluded ? ' <span style="font-size:10px;color:var(--danger);font-weight:600;white-space:nowrap">· ausgeschlossen</span>' : '');
        var btn = '<button class="excl-toggle" data-cid="' + r.cid + '" title="'
          + (r.excluded ? 'Wieder am Umsatz beteiligen' : 'Bei diesem Kunden vom Umsatz ausschließen')
          + '" style="background:none;border:1px solid var(--border);border-radius:4px;cursor:pointer;padding:1px 7px;font-size:11px;color:'
          + (r.excluded ? 'var(--primary)' : 'var(--text-secondary)') + '">'
          + (r.excluded ? '↩ einbeziehen' : '🚫 ausschließen') + '</button>';
        html += '<tr><td><span class="cli-expand" data-cid="' + r.cid + '" title="Klick: wer hat noch an diesem Kunden gearbeitet?" style="cursor:pointer;user-select:none">' +
            '<span class="cli-caret" style="display:inline-block;width:12px;color:var(--text-secondary)">▸</span>' + nameCell + '</span></td>' +
          '<td class="right">' + fmtH(r.hrs) + '</td>' +
          (single ? '<td class="right">' + fmtH(r.cTotH) + '</td><td class="right">' + share + '</td><td class="right">' + fmtEur(r.cRev) + '</td>' : '') +
          '<td class="right">' + (r.excluded ? '<span class="muted">0 €</span>' : fmtEur(r.rev)) + '</td>' +
          '<td class="right">' + btn + '</td></tr>';
      });
      html += '<tr style="font-weight:700;border-top:2px solid var(--border)"><td>Gesamt</td>' +
        '<td class="right">' + fmtH(totHrs) + '</td>' +
        (single ? '<td></td><td></td><td></td>' : '') +
        '<td class="right">' + fmtEur(totRev) + '</td><td></td></tr>';
    }
    html += '</tbody></table></div>' +
      '<div style="margin-top:8px;font-size:11px;color:var(--text-secondary)">🚫 Ausschließen = dieser Mitarbeiter wird beim Umsatz dieses Kunden nicht berücksichtigt (Umsatz geht ganz an die Owner). Stunden bleiben sichtbar.</div>';
    modalBody.innerHTML = html;

    // Ausschluss-Schalter
    modalBody.querySelectorAll('.excl-toggle').forEach(function (b) {
      b.addEventListener('click', function () {
        var cid = b.getAttribute('data-cid');
        var isExcl = !!COMP.excludedSet[cid + '|' + empId];
        b.disabled = true; b.textContent = '…';
        var op = isExcl ? window.db.revenueExclusions.remove(cid, empId)
                        : window.db.revenueExclusions.add(cid, empId);
        op.then(function () {
          if (isExcl) DATA.exclusions = (DATA.exclusions || []).filter(function (x) { return !(x.client_id === cid && x.employee_id === empId); });
          else        (DATA.exclusions = DATA.exclusions || []).push({ client_id: cid, employee_id: empId });
          compute();          // Grid + COMP neu berechnen
          renderModalBody();  // Modal aktualisieren
        }).catch(function (e) { alert('Fehler: ' + e.message); b.disabled = false; });
      });
    });

    // Aufklappen: wer hat noch an diesem Kunden gearbeitet?
    var empNameById = {};
    COMP.employees.forEach(function (e) { empNameById[e.id] = e.name; });
    function clientTeam(cid) {
      var byEmp = {}; // eid → {hrs, rev}
      monthsInScope().forEach(function (m) {
        var emps = (COMP.entryByClientEmpMonth[cid] || {})[m] || {};
        var revM = (COMP.empClientRevMonth[cid] || {})[m] || {};
        Object.keys(emps).forEach(function (eid) {
          var e = byEmp[eid] = byEmp[eid] || { hrs: 0, rev: 0 };
          e.hrs += emps[eid] || 0;
          e.rev += revM[eid] || 0;
        });
      });
      return byEmp;
    }
    var colspan = single ? 7 : 4;
    modalBody.querySelectorAll('.cli-expand').forEach(function (el) {
      el.addEventListener('click', function () {
        var cid = el.getAttribute('data-cid');
        var tr = el.closest('tr');
        var caret = el.querySelector('.cli-caret');
        var nxt = tr.nextElementSibling;
        if (nxt && nxt.classList.contains('cli-detail') && nxt.getAttribute('data-cid') === cid) {
          nxt.remove(); caret.textContent = '▸'; return;
        }
        var team = clientTeam(cid);
        var list = Object.keys(team).map(function (eid) {
          return { eid: eid, name: empNameById[eid] || '?', hrs: team[eid].hrs, rev: team[eid].rev,
                   excl: !!COMP.excludedSet[cid + '|' + eid] };
        }).filter(function (x) { return x.hrs > 0; }).sort(function (a, b) { return b.hrs - a.hrs; });

        var totH = list.reduce(function (s, x) { return s + x.hrs; }, 0);
        var inner = list.map(function (x) {
          var me = x.eid === empId;
          var pct = totH > 0 ? ' <span style="color:var(--text-muted)">(' + (x.hrs / totH * 100).toFixed(0) + '%)</span>' : '';
          return '<div style="display:flex;justify-content:space-between;gap:12px;padding:3px 0;border-bottom:1px solid var(--border)' + (me ? ';font-weight:700' : '') + '">' +
            '<span>' + (me ? '➤ ' : '') + x.name + (x.excl ? ' <span style="color:var(--danger);font-size:10px;font-weight:600">· ausgeschlossen</span>' : '') + '</span>' +
            '<span style="color:var(--text-secondary);font-variant-numeric:tabular-nums;white-space:nowrap">' + fmtH(x.hrs) + pct + ' · ' + (x.excl ? '0 €' : fmtEur(x.rev)) + '</span>' +
          '</div>';
        }).join('');

        // Rechnungen (LexOffice-Kontakte) dieses Kunden im Zeitraum
        var contacts = (COMP.mappingsByClient[cid] || []).slice();
        if (!contacts.length) { var cc0 = clientsById[cid] || {}; contacts = [cc0.lexoffice_name || cc0.name].filter(Boolean); }
        var invSeen = {}, invoices = [];
        contacts.forEach(function (cn) {
          var key = norm(cn); if (invSeen[key]) return; invSeen[key] = true;
          var amt = 0;
          monthsInScope().forEach(function (m) { amt += (COMP.revMapByMonth[m] || {})[key] || 0; });
          var excl = !!COMP.maExclSet[key];
          if (amt > 0 || excl) invoices.push({ name: cn, key: key, amt: amt, excl: excl });
        });
        var showInv = invoices.length >= 2 || invoices.some(function (x) { return x.excl; });
        var invHtml = '';
        if (showInv) {
          invHtml = '<div style="font-size:11px;color:var(--text-secondary);margin:10px 0 4px">Rechnungen dieses Kunden – auf Mitarbeiter zurechnen?</div>' +
            invoices.map(function (iv) {
              return '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:3px 0;border-bottom:1px solid var(--border)' + (iv.excl ? ';opacity:.6' : '') + '">' +
                '<span>' + iv.name + (iv.excl ? ' <span style="color:var(--danger);font-size:10px;font-weight:600">· nicht zugerechnet</span>' : '') + '</span>' +
                '<span style="display:flex;align-items:center;gap:10px;white-space:nowrap">' +
                  '<span style="color:var(--text-secondary);font-variant-numeric:tabular-nums">' + fmtEur(iv.amt) + '</span>' +
                  '<button class="ma-inv-toggle" data-contact="' + encodeURIComponent(iv.name) + '" style="background:none;border:1px solid var(--border);border-radius:4px;cursor:pointer;padding:1px 7px;font-size:11px;color:' + (iv.excl ? 'var(--primary)' : 'var(--text-secondary)') + '">' + (iv.excl ? '↩ zurechnen' : '🚫 nicht zurechnen') + '</button>' +
                '</span>' +
              '</div>';
            }).join('') +
            '<div style="font-size:10px;color:var(--text-secondary);margin-top:5px">Nicht zugerechnete Rechnungen bleiben im Gesamtumsatz &amp; in der Profitabilität — sie fallen nur aus der Mitarbeiter-Verteilung (z.B. Inhaber-Betreuung).</div>';
        }

        // ── Leistungen dieses Kunden (gezielte Zuweisung) ──
        var svcAgg = {};
        monthsInScope().forEach(function (m) {
          var sm = (COMP.clientSvcMonth[cid] || {})[m] || {};
          Object.keys(sm).forEach(function (sv) { svcAgg[sv] = (svcAgg[sv] || 0) + sm[sv]; });
        });
        var svcNames = Object.keys(svcAgg).filter(function (sv) { return svcAgg[sv] > 0.5; });
        var svcHtml = '';
        if (svcNames.length >= 2) {   // nur bei mehreren Leistungen sinnvoll
          var assignForCid = COMP.svcAssign[cid] || {};
          var empOptions = COMP.employees.map(function (e) { return '<option value="' + e.id + '">' + e.name + '</option>'; }).join('');
          svcHtml = '<div style="font-size:11px;color:var(--text-secondary);margin:10px 0 4px">Leistungen dieses Kunden – gezielt zurechnen?</div>' +
            svcNames.sort(function (a, b) { return svcAgg[b] - svcAgg[a]; }).map(function (sv) {
              var eids = assignForCid[sv] || [];
              var chips = eids.map(function (eid) {
                return '<span style="display:inline-flex;align-items:center;gap:4px;background:#eef2ff;color:var(--primary);border-radius:10px;padding:1px 8px;font-size:11px;font-weight:600">' +
                  (empNameById[eid] || '?') +
                  ' <span class="svc-unassign" data-cid="' + cid + '" data-svc="' + encodeURIComponent(sv) + '" data-eid="' + eid + '" title="Entfernen" style="cursor:pointer">×</span></span>';
              }).join(' ');
              var status = eids.length ? chips : '<span class="muted" style="font-size:11px">nach Stunden (Standard)</span>';
              return '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:4px 0;border-bottom:1px solid var(--border)">' +
                '<span>' + sv + '</span>' +
                '<span style="display:flex;align-items:center;gap:10px;white-space:nowrap;flex-wrap:wrap;justify-content:flex-end">' +
                  '<span style="color:var(--text-secondary);font-variant-numeric:tabular-nums">' + fmtEur(svcAgg[sv]) + '</span>' +
                  status +
                  '<select class="svc-assign" data-cid="' + cid + '" data-svc="' + encodeURIComponent(sv) + '" style="font-size:11px;border:1px solid var(--border);border-radius:4px;padding:1px 4px;color:var(--text-secondary)"><option value="">+ zuweisen…</option>' + empOptions + '</select>' +
                '</span>' +
              '</div>';
            }).join('') +
            '<div style="font-size:10px;color:var(--text-secondary);margin-top:5px">Zugewiesene Leistungen gehen nur an die gewählten MA. Nicht zugewiesene laufen wie bisher nach Stunden über alle. Gilt dauerhaft.</div>';
        }

        var dtr = document.createElement('tr');
        dtr.className = 'cli-detail';
        dtr.setAttribute('data-cid', cid);
        dtr.innerHTML = '<td colspan="' + colspan + '" style="background:var(--surface-hover,#f8fafc);padding:8px 14px 10px 26px">' +
          '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px">Alle Mitarbeiter an diesem Kunden (Stunden · MA-Umsatz):</div>' +
          (inner || '<div class="muted" style="font-size:12px">Keine weiteren.</div>') + invHtml + svcHtml + '</td>';
        tr.parentNode.insertBefore(dtr, tr.nextSibling);
        caret.textContent = '▾';

        // Schalter: einzelne Rechnung auf MA zurechnen / nicht zurechnen
        dtr.querySelectorAll('.ma-inv-toggle').forEach(function (b) {
          b.addEventListener('click', function () {
            var contact = decodeURIComponent(b.getAttribute('data-contact'));
            var k = norm(contact);
            var isExcl = !!COMP.maExclSet[k];
            b.disabled = true; b.textContent = '…';
            var op = isExcl ? window.db.maRevenueExclusions.remove(contact)
                            : window.db.maRevenueExclusions.add(contact, null);
            op.then(function () {
              if (isExcl) DATA.maExclusions = (DATA.maExclusions || []).filter(function (x) { return norm(x.contact_name) !== k; });
              else        (DATA.maExclusions = DATA.maExclusions || []).push({ contact_name: contact });
              compute();          // Grid + COMP neu berechnen
              renderModalBody();  // Modal aktualisieren
            }).catch(function (e) { alert('Fehler: ' + e.message); b.disabled = false; });
          });
        });

        // Leistungs-Zuweisung: Mitarbeiter zuweisen / entfernen
        dtr.querySelectorAll('.svc-assign').forEach(function (sel) {
          sel.addEventListener('change', function () {
            var eid = sel.value; if (!eid) return;
            var cid2 = sel.getAttribute('data-cid');
            var sv = decodeURIComponent(sel.getAttribute('data-svc'));
            // Doppelte Zuweisung vermeiden
            var exists = (DATA.svcAssignments || []).some(function (a) { return String(a.client_id) === String(cid2) && a.service === sv && String(a.employee_id) === String(eid); });
            if (exists) { sel.value = ''; return; }
            sel.disabled = true;
            window.db.revenueServiceAssignments.add(cid2, sv, eid).then(function () {
              (DATA.svcAssignments = DATA.svcAssignments || []).push({ client_id: cid2, service: sv, employee_id: eid });
              compute(); renderModalBody();
            }).catch(function (e) { alert('Fehler: ' + e.message); sel.disabled = false; });
          });
        });
        dtr.querySelectorAll('.svc-unassign').forEach(function (x) {
          x.addEventListener('click', function () {
            var cid2 = x.getAttribute('data-cid');
            var sv = decodeURIComponent(x.getAttribute('data-svc'));
            var eid = x.getAttribute('data-eid');
            window.db.revenueServiceAssignments.remove(cid2, sv, eid).then(function () {
              DATA.svcAssignments = (DATA.svcAssignments || []).filter(function (a) { return !(String(a.client_id) === String(cid2) && a.service === sv && String(a.employee_id) === String(eid)); });
              compute(); renderModalBody();
            }).catch(function (e) { alert('Fehler: ' + e.message); });
          });
        });
      });
    });
  }

  // ── Szenario-Panel ────────────────────────────────────────────────────
  function renderScenario(clients, employees) {
    var empOpts = '<option value="">–</option>' + employees.map(function (e) {
      return '<option value="' + e.id + '">' + e.name + '</option>';
    }).join('');

    // Kunden-Status (verloren ab Monat)
    var lostRows = clients.map(function (c) {
      var cur = scenario.lost[c.id] || '';
      var opts = '<option value="">aktiv</option>';
      for (var m = 1; m <= 12; m++) opts += '<option value="' + m + '"' + (cur == m ? ' selected' : '') + '>verloren ab ' + MONTHS[m - 1] + '</option>';
      return '<tr><td>' + c.name + '</td><td><select data-lost="' + c.id + '" class="mini-sel">' + opts + '</select></td></tr>';
    }).join('');

    // Potenzielle Neukunden
    var prospRows = scenario.prospects.map(function (p, i) {
      return '<tr>' +
        '<td>' + (p.name || '(ohne Name)') + '</td>' +
        '<td>' + empName(employees, p.amEmpId) + ' / ' + empName(employees, p.advEmpId) + '</td>' +
        '<td class="right">' + (p.amBudget || 0) + ' / ' + (p.advBudget || 0) + ' h</td>' +
        '<td class="right">' + fmtEur(+p.revenue || 0) + '</td>' +
        '<td>ab ' + MONTHS[(p.startMonth || 1) - 1] + '</td>' +
        '<td class="right"><button class="btn-link-del" data-del="' + i + '">×</button></td>' +
      '</tr>';
    }).join('');

    scenarioWrap.innerHTML =
      '<div class="scn-grid">' +
        '<div class="scn-card">' +
          '<div class="scn-h">Kunden-Status (Forecast)</div>' +
          '<div class="scn-scroll"><table class="mini-table"><tbody>' + lostRows + '</tbody></table></div>' +
        '</div>' +
        '<div class="scn-card">' +
          '<div class="scn-h">Potenzielle Neukunden</div>' +
          '<div class="scn-scroll"><table class="mini-table"><thead><tr><th>Name</th><th>AM / ADV</th><th class="right">Std AM/ADV</th><th class="right">Umsatz/Mon</th><th>Start</th><th></th></tr></thead><tbody>' +
            (prospRows || '<tr><td colspan="6" class="muted">Noch keine.</td></tr>') + '</tbody></table></div>' +
          '<div class="prosp-form">' +
            '<input id="pName" placeholder="Name" class="inp">' +
            '<select id="pAm" class="inp" title="Account Manager">' + empOpts + '</select>' +
            '<select id="pAdv" class="inp" title="Advertising">' + empOpts + '</select>' +
            '<input id="pAmB" type="number" placeholder="Std AM" class="inp inp-s">' +
            '<input id="pAdvB" type="number" placeholder="Std ADV" class="inp inp-s">' +
            '<input id="pRev" type="number" placeholder="Umsatz/Mon €" class="inp inp-s">' +
            '<select id="pStart" class="inp inp-s">' + MONTHS.map(function (mn, i) { return '<option value="' + (i + 1) + '"' + ((i + 1) === ym.month + 1 ? ' selected' : '') + '>' + mn + '</option>'; }).join('') + '</select>' +
            '<button id="pAdd" class="btn btn-primary btn-sm">+ Hinzufügen</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div style="margin-top:10px"><button id="scnReset" class="btn btn-sm">Szenario zurücksetzen</button> <span class="muted" style="font-size:12px">Änderungen wirken nur auf Forecast-Monate (P). Lokal gespeichert.</span></div>';

    // Events
    scenarioWrap.querySelectorAll('select[data-lost]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var cid = sel.getAttribute('data-lost');
        if (sel.value) scenario.lost[cid] = parseInt(sel.value); else delete scenario.lost[cid];
        saveScenario(scenario); compute();
      });
    });
    scenarioWrap.querySelectorAll('button[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        scenario.prospects.splice(parseInt(b.getAttribute('data-del')), 1);
        saveScenario(scenario); compute();
      });
    });
    var addBtn = document.getElementById('pAdd');
    if (addBtn) addBtn.addEventListener('click', function () {
      scenario.prospects.push({
        name: document.getElementById('pName').value.trim(),
        amEmpId: document.getElementById('pAm').value || null,
        advEmpId: document.getElementById('pAdv').value || null,
        amBudget: parseFloat(document.getElementById('pAmB').value) || 0,
        advBudget: parseFloat(document.getElementById('pAdvB').value) || 0,
        revenue: parseFloat(document.getElementById('pRev').value) || 0,
        startMonth: parseInt(document.getElementById('pStart').value) || (ym.month + 1),
      });
      saveScenario(scenario); compute();
    });
    var rst = document.getElementById('scnReset');
    if (rst) rst.addEventListener('click', function () {
      scenario = { lost: {}, prospects: [] }; saveScenario(scenario); compute();
    });
  }

  function empName(employees, id) {
    if (!id) return '–';
    var e = employees.find(function (x) { return x.id === id; });
    return e ? e.name : '–';
  }

  // ── Events / Boot ─────────────────────────────────────────────────────
  loadBtn.addEventListener('click', loadData);
  metricSel.addEventListener('change', function () { if (DATA) compute(); });
  yearSel.addEventListener('change', loadData);
  loadData();
})();
