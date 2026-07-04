(function () {
  'use strict';

  let _sb = null;

  // ── Supabase-Zugangsdaten ─────────────────────────────────────────────
  // Fest hinterlegt – kein Setup durch den Nutzer erforderlich.
  // localStorage-Werte überschreiben (für lokale Entwicklung / Umzug).
  var DEFAULT_URL = 'https://lgrnmiszhhahfcmctmwo.supabase.co';   // ← hier deine URL eintragen
  var DEFAULT_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxncm5taXN6aGhhaGZjbWN0bXdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NjE2NDksImV4cCI6MjA4OTIzNzY0OX0.FDZRGMESves7XbAMs_oMLWmvnywMlVqe8p7f1kt06qk';                               // ← hier deinen Anon-Key eintragen

  function sb() {
    if (_sb) return _sb;
    const url = localStorage.getItem('supabaseUrl') || DEFAULT_URL;
    const key = localStorage.getItem('supabaseKey') || DEFAULT_KEY;
    if (!url || !key || url === 'SUPABASE_URL_HERE') throw new Error('NOT_CONFIGURED');
    if (!window.supabase) throw new Error('Supabase-Bibliothek nicht geladen.');
    _sb = window.supabase.createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    return _sb;
  }

  async function q(fn) {
    const { data, error } = await fn(sb());
    if (error) throw error;
    return data;
  }

  window.getSb = function () { return sb(); };

  window.isConfigured = () => {
    const url = localStorage.getItem('supabaseUrl') || DEFAULT_URL;
    const key = localStorage.getItem('supabaseKey') || DEFAULT_KEY;
    return !!(url && key && url !== 'SUPABASE_URL_HERE');
  };

  window.configure = (url, key) => {
    localStorage.setItem('supabaseUrl', url.trim());
    localStorage.setItem('supabaseKey', key.trim());
    _sb = null;
  };

  window.db = {

    employees: {
      list: () =>
        q(s => s.from('employees').select('*').order('name')),
      listActive: () =>
        q(s => s.from('employees').select('*').eq('active', true).order('name')),
      create: (name, role, email, monthlyCost) =>
        q(s => s.from('employees')
          .insert({ name, role, email: email || null, active: true, monthly_cost: monthlyCost || 0 })
          .select().single()),
      update: (id, fields) =>
        q(s => s.from('employees').update(fields).eq('id', id).select().single()),
      delete: (id) =>
        q(s => s.from('employees').delete().eq('id', id)),
    },

    clients: {
      list: () =>
        q(s => s.from('clients')
          .select('*, am_emp:am_employee_id(id,name), adv_emp:adv_employee_id(id,name)')
          .order('name')),
      get: (id) =>
        q(s => s.from('clients').select('*').eq('id', id).single()),
      create: (name, amBudget, advBudget, amEmpId, advEmpId, contractStart, isProject, projectEnd, lexofficeName, source) =>
        q(s => s.from('clients')
          .insert({ name, am_budget: amBudget || null, adv_budget: advBudget || null,
                    am_employee_id: amEmpId || null, adv_employee_id: advEmpId || null,
                    contract_start: contractStart || null,
                    is_project: !!isProject, project_end: projectEnd || null,
                    lexoffice_name: lexofficeName || null,
                    source: source || null })
          .select().single()),
      update: (id, fields) =>
        q(s => s.from('clients').update(fields).eq('id', id).select().single()),
      delete: (id) =>
        q(s => s.from('clients').delete().eq('id', id)),
    },

    utilHours: {
      forYear: (year) =>
        q(s => s.from('util_hours').select('*').eq('year', year)),
      upsert: (employeeId, year, month, hours, internHours) =>
        q(s => s.from('util_hours').upsert(
          { employee_id: employeeId, year, month,
            hours: hours || 0,
            intern_hours: internHours || 0,
            updated_at: new Date().toISOString() },
          { onConflict: 'employee_id,year,month' }
        ).select().single()),
    },

    adjustments: {
      forClientYear: (clientId, year) =>
        q(s => s.from('adjustments').select('*')
          .eq('client_id', clientId).eq('year', year)),
      forYear: (year) =>
        q(s => s.from('adjustments').select('*').eq('year', year)),
      forMonth: (year, month) =>
        q(s => s.from('adjustments').select('*').eq('year', year).eq('month', month)),
      upsert: (clientId, year, month, amHours, advHours, note, revenueDeduction) =>
        q(s => s.from('adjustments').upsert(
          { client_id: clientId, year, month,
            am_hours:          amHours          || 0,
            adv_hours:         advHours         || 0,
            note:              note             || null,
            revenue_deduction: revenueDeduction || 0,
            updated_at: new Date().toISOString() },
          { onConflict: 'client_id,year,month' }
        ).select().single()),
      delete: (clientId, year, month) =>
        q(s => s.from('adjustments').delete()
          .eq('client_id', clientId).eq('year', year).eq('month', month)),
    },

    absences: {
      forYear: (year) =>
        q(s => s.from('employee_absences').select('*').eq('year', year)),
      upsert: (empId, year, month, vacDays, sickDays) =>
        q(s => s.from('employee_absences').upsert(
          { employee_id: empId, year, month,
            vacation_days: vacDays  || 0,
            sick_days:     sickDays || 0,
            updated_at: new Date().toISOString() },
          { onConflict: 'employee_id,year,month' }
        ).select().single()),
    },

    revenue: {
      forMonth: (year, month) =>
        q(s => s.from('revenue').select('*').eq('year', year).eq('month', month)),
      allContactNames: async () => {
        var rows = await window.db.revenue.allRows();
        return [...new Set(rows.map(r => r.contact_name).filter(Boolean))].sort();
      },
      allRows: async () => {
        // Supabase caps each request at ~1000 rows regardless of .limit().
        // Paginate with .range() until fewer than PAGE rows come back.
        var PAGE = 1000;
        var all  = [];
        var from = 0;
        var client = sb();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          var res = await client.from('revenue')
            .select('contact_name,total_amount,year,month')
            .order('id', { ascending: true })
            .range(from, from + PAGE - 1);
          if (res.error) throw res.error;
          var chunk = res.data || [];
          all = all.concat(chunk);
          if (chunk.length < PAGE) break;
          from += PAGE;
        }
        return all;
      },
      forContacts: async (contactNames) => {
        if (!contactNames || contactNames.length === 0) return [];
        // Paginate with .range() — Supabase caps each request at ~1000 rows.
        var PAGE = 1000;
        var all  = [];
        var from = 0;
        var client = sb();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          var res = await client.from('revenue')
            .select('id,contact_name,year,month,total_amount')
            .in('contact_name', contactNames)
            .order('id', { ascending: true })
            .range(from, from + PAGE - 1);
          if (res.error) throw res.error;
          var chunk = res.data || [];
          all = all.concat(chunk);
          if (chunk.length < PAGE) break;
          from += PAGE;
        }
        return all;
      },
      updateAmount: (id, total_amount) =>
        q(s => s.from('revenue').update({ total_amount }).eq('id', id).select().single()),
      insertRow: (year, month, contactName, amount) =>
        q(s => s.from('revenue')
          .insert({ year, month, contact_name: contactName, total_amount: amount })
          .select().single()),
      clearMonth: (year, month) =>
        q(s => s.from('revenue').delete().eq('year', year).eq('month', month)),
      insertMany: (year, month, rows) =>
        q(s => s.from('revenue').insert(
          rows.map(r => ({ year, month, contact_name: r.contact_name, total_amount: r.total_amount }))
        )),
    },

    // Umsatz pro Kunde × Service (befüllt vom LexOffice-Sync, additiv zu revenue)
    revenueServices: {
      allRows: async () => {
        var PAGE = 1000, all = [], from = 0, client = sb();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          var res = await client.from('revenue_services')
            .select('contact_name,service,amount,year,month')
            .order('id', { ascending: true })
            .range(from, from + PAGE - 1);
          if (res.error) throw res.error;
          var chunk = res.data || [];
          all = all.concat(chunk);
          if (chunk.length < PAGE) break;
          from += PAGE;
        }
        return all;
      },
    },

    employeeRates: {
      listAll: () =>
        q(s => s.from('employee_rates').select('*').order('effective_from')),
      forEmployee: (employeeId) =>
        q(s => s.from('employee_rates').select('*')
          .eq('employee_id', employeeId).order('effective_from')),
      create: (employeeId, effectiveFrom, monthlyCost, hourlyRate) =>
        q(s => s.from('employee_rates')
          .insert({ employee_id: employeeId, effective_from: effectiveFrom,
                    monthly_cost: monthlyCost || null, hourly_rate: hourlyRate || null })
          .select().single()),
      delete: (id) =>
        q(s => s.from('employee_rates').delete().eq('id', id)),
    },

    manualCosts: {
      forMonth: (year, month) =>
        q(s => s.from('manual_costs').select('*').eq('year', year).eq('month', month)),
      forClientMonth: (clientId, year, month) =>
        q(s => s.from('manual_costs').select('*')
          .eq('client_id', clientId).eq('year', year).eq('month', month)
          .order('created_at')),
      create: (clientId, year, month, name, amount) =>
        q(s => s.from('manual_costs')
          .insert({ client_id: clientId, year, month, name: name, amount: amount || 0 })
          .select().single()),
      delete: (id) =>
        q(s => s.from('manual_costs').delete().eq('id', id)),
    },

    mappings: {
      list: () =>
        q(s => s.from('client_revenue_mappings').select('*').order('lexoffice_name')),
      add: (clientId, lexofficeName) =>
        q(s => s.from('client_revenue_mappings')
          .insert({ client_id: clientId, lexoffice_name: lexofficeName }).select().single()),
      remove: (id) =>
        q(s => s.from('client_revenue_mappings').delete().eq('id', id)),
    },

    acquisitionCosts: {
      list: () =>
        q(s => s.from('acquisition_costs').select('*').order('cost_date', { ascending: false, nullsFirst: false })),
      create: (sourceName, sourceType, amount, costDate, notes) =>
        q(s => s.from('acquisition_costs')
          .insert({ source_name: sourceName, source_type: sourceType || 'sonstige',
                    amount: amount || 0, cost_date: costDate || null, notes: notes || null })
          .select().single()),
      update: (id, fields) =>
        q(s => s.from('acquisition_costs').update(fields).eq('id', id).select().single()),
      delete: (id) =>
        q(s => s.from('acquisition_costs').delete().eq('id', id)),
    },

    revenueExclusions: {
      // (Kunde × Mitarbeiter) die NICHT am Umsatz beteiligt werden
      listAll: () =>
        q(s => s.from('client_employee_exclusions').select('client_id,employee_id')),
      add: (clientId, employeeId) =>
        q(s => s.from('client_employee_exclusions')
          .insert({ client_id: clientId, employee_id: employeeId }).select().single()),
      remove: (clientId, employeeId) =>
        q(s => s.from('client_employee_exclusions')
          .delete().eq('client_id', clientId).eq('employee_id', employeeId)),
    },

    maRevenueExclusions: {
      // Einzelne LexOffice-Kontakte (Rechnungen), die NICHT auf Mitarbeiter
      // zugerechnet werden. Der Umsatz bleibt im Kunden-Gesamt/Profitabilität,
      // fällt aber aus der MA-Umsatz-Verteilung raus (z.B. Betreuung durch Inhaber).
      listAll: () =>
        q(s => s.from('ma_revenue_exclusions').select('contact_name')),
      add: (contactName, note) =>
        q(s => s.from('ma_revenue_exclusions')
          .insert({ contact_name: contactName, note: note || null }).select().single()),
      remove: (contactName) =>
        q(s => s.from('ma_revenue_exclusions')
          .delete().eq('contact_name', contactName)),
    },

    revenueServices: {
      // Umsatz je Kunde je Leistung (PPC, Full Service, Bilder, Andere …)
      forMonth: (year, month) =>
        q(s => s.from('revenue_services').select('contact_name,service,amount').eq('year', year).eq('month', month)),
    },

    revenueServiceAssignments: {
      // Regel: eine Leistung eines Kunden wird gezielt Mitarbeiter(n) zugerechnet
      // (statt nach Stunden über alle). Gilt dauerhaft (monatsübergreifend).
      listAll: () =>
        q(s => s.from('revenue_service_assignments').select('client_id,service,employee_id')),
      add: (clientId, service, employeeId) =>
        q(s => s.from('revenue_service_assignments')
          .insert({ client_id: clientId, service: service, employee_id: employeeId }).select().single()),
      remove: (clientId, service, employeeId) =>
        q(s => s.from('revenue_service_assignments')
          .delete().eq('client_id', clientId).eq('service', service).eq('employee_id', employeeId)),
    },

    residualAssignments: {
      // Nicht zugeordneter (Rest-)Umsatz eines Kunden → einem Mitarbeiter gutschreiben
      // (z.B. Inhaber). Umfasst Umsatz ohne gebuchte Stunden + bewusst ausgeschlossene
      // Rechnungen + Zurechnungs-Rest. Ein MA je Kunde.
      listAll: () =>
        q(s => s.from('client_residual_assignments').select('client_id,employee_id')),
      set: (clientId, employeeId) =>
        q(s => s.from('client_residual_assignments')
          .upsert({ client_id: clientId, employee_id: employeeId }, { onConflict: 'client_id' }).select().single()),
      remove: (clientId) =>
        q(s => s.from('client_residual_assignments').delete().eq('client_id', clientId)),
    },

    acquisitionContactLinks: {
      listForCost: (costId) =>
        q(s => s.from('acquisition_contact_links').select('*').eq('acquisition_cost_id', costId)),
      listAll: () =>
        q(s => s.from('acquisition_contact_links').select('*')),
      create: (costId, contactName) =>
        q(s => s.from('acquisition_contact_links')
          .insert({ acquisition_cost_id: costId, contact_name: contactName })
          .select().single()),
      delete: (costId, contactName) =>
        q(s => s.from('acquisition_contact_links')
          .delete().eq('acquisition_cost_id', costId).eq('contact_name', contactName)),
    },

    entries: {
      // All entries for a month across all clients (includes employee data)
      forMonth: (year, month) =>
        q(s => s.from('entries')
          .select('*, employees(id, name, role)')
          .eq('year', year).eq('month', month)),

      // All entries for one employee in a month (includes client data)
      forEmployeeMonth: (employeeId, year, month) =>
        q(s => s.from('entries')
          .select('*, clients(id, name)')
          .eq('employee_id', employeeId).eq('year', year).eq('month', month)
          .gt('hours', 0).order('hours', { ascending: false })),

      // All entries for a specific client + month
      forClientMonth: (clientId, year, month) =>
        q(s => s.from('entries')
          .select('*, employees(id, name, role)')
          .eq('client_id', clientId).eq('year', year).eq('month', month)),

      // All entries for a specific client + year (for detail page)
      forClientYear: (clientId, year) =>
        q(s => s.from('entries')
          .select('*, employees(id, name, role)')
          .eq('client_id', clientId).eq('year', year)
          .order('month')),

      // All entries for all clients for a full year (for overview)
      forYear: (year) =>
        q(s => s.from('entries')
          .select('*, employees(id, name, role)')
          .eq('year', year)),

      upsert: (clientId, employeeId, year, month, hours) =>
        q(s => s.from('entries')
          .upsert(
            { client_id: clientId, employee_id: employeeId, year, month,
              hours: hours ?? 0, updated_at: new Date().toISOString() },
            { onConflict: 'client_id,employee_id,year,month' }
          ).select().single()),

      // Delete a single entry (0 hours)
      delete: (clientId, employeeId, year, month) =>
        q(s => s.from('entries').delete()
          .eq('client_id', clientId).eq('employee_id', employeeId)
          .eq('year', year).eq('month', month)),

      // Delete all entries for a client+month (used when resetting)
      deleteAll: (clientId, year, month) =>
        q(s => s.from('entries').delete()
          .eq('client_id', clientId).eq('year', year).eq('month', month)),
    },

    // ── Kostenanalyse ───────────────────────────────────────────────────────
    cost: {
      imports: {
        list: () =>
          q(s => s.from('cost_imports').select('*').order('created_at', { ascending: false })),
        create: (source, filename, fileHash, rowCount, skippedCount, periodLabel) =>
          q(s => s.from('cost_imports')
            .insert({ source, filename: filename || null, file_hash: fileHash || null,
                      row_count: rowCount || 0, skipped_count: skippedCount || 0,
                      period_label: periodLabel || null })
            .select().single()),
        update: (id, fields) =>
          q(s => s.from('cost_imports').update(fields).eq('id', id).select().single()),
        delete: (id) =>
          q(s => s.from('cost_imports').delete().eq('id', id)),   // cascade → Transaktionen
        findByHash: (fileHash) =>
          q(s => s.from('cost_imports').select('*').eq('file_hash', fileHash)),
      },

      transactions: {
        // Alle Transaktionen (Agentur-Maßstab; Übersicht aggregiert clientseitig).
        // Supabase liefert max ~1000 Zeilen/Request → paginieren, sonst fallen die
        // ältesten Buchungen weg (z.B. Jan–Jul 2025 in der Datenabdeckung).
        all: async () => {
          var PAGE = 1000, out = [], from = 0, client = sb();
          // eslint-disable-next-line no-constant-condition
          while (true) {
            var res = await client.from('cost_transactions')
              .select('*')
              .order('tx_date', { ascending: false })
              .order('id', { ascending: false })
              .range(from, from + PAGE - 1);
            if (res.error) throw res.error;
            var chunk = res.data || [];
            out = out.concat(chunk);
            if (chunk.length < PAGE) break;
            from += PAGE;
          }
          return out;
        },
        forImport: (importId) =>
          q(s => s.from('cost_transactions').select('*').eq('import_id', importId)),
        uncategorized: () =>
          q(s => s.from('cost_transactions').select('*').is('category', null).order('tx_date', { ascending: false })),
        // Einfügen; Duplikate (dedup_hash) werden ignoriert. Liefert eingefügte Zeilen.
        insertMany: (rows) =>
          q(s => s.from('cost_transactions')
            .upsert(rows, { onConflict: 'dedup_hash', ignoreDuplicates: true })
            .select()),
        update: (id, fields) =>
          q(s => s.from('cost_transactions')
            .update(Object.assign({ updated_at: new Date().toISOString() }, fields))
            .eq('id', id).select().single()),
        // Bulk-Neuberechnung (Kategorie/MwSt/Ausschluss) – volle Zeilen upserten.
        bulkUpsert: (rows) =>
          q(s => s.from('cost_transactions')
            .upsert(rows, { onConflict: 'id' }).select('id')),
        // Einzelne Buchungen aus-/einschließen (manuell, überlebt „Regeln neu anwenden").
        bulkExclude: (ids, excluded, reason) =>
          q(s => s.from('cost_transactions')
            .update({ excluded: !!excluded, exclude_reason: excluded ? (reason || null) : null,
                      updated_at: new Date().toISOString() })
            .in('id', ids).select('id')),
      },

      categoryRules: {
        list: () =>
          q(s => s.from('cost_category_rules').select('*').order('category')),
        add: (matchType, pattern, category) =>
          q(s => s.from('cost_category_rules')
            .insert({ match_type: matchType || 'contains', pattern, category }).select().single()),
        // Sammel-Insert: rules = [{match_type, pattern, category}]
        addMany: (rules) =>
          q(s => s.from('cost_category_rules')
            .insert(rules.map(r => ({ match_type: r.match_type || 'contains', pattern: r.pattern, category: r.category })))
            .select()),
        update: (id, fields) =>
          q(s => s.from('cost_category_rules').update(fields).eq('id', id).select().single()),
        delete: (id) =>
          q(s => s.from('cost_category_rules').delete().eq('id', id)),
      },

      vatRules: {
        list: () =>
          q(s => s.from('cost_vat_rules').select('*').order('pattern')),
        add: (matchType, pattern, vatRate, startDate, endDate) =>
          q(s => s.from('cost_vat_rules')
            .insert({ match_type: matchType || 'contains', pattern,
                      vat_rate: vatRate != null ? vatRate : 0.19,
                      start_date: startDate || null, end_date: endDate || null })
            .select().single()),
        update: (id, fields) =>
          q(s => s.from('cost_vat_rules').update(fields).eq('id', id).select().single()),
        delete: (id) =>
          q(s => s.from('cost_vat_rules').delete().eq('id', id)),
      },

      excludeRules: {
        list: () =>
          q(s => s.from('cost_exclude_rules').select('*').order('builtin', { ascending: false })),
        add: (matchType, pattern, reason, startDate, endDate) =>
          q(s => s.from('cost_exclude_rules')
            .insert({ match_type: matchType || 'contains', pattern, reason: reason || null, builtin: false,
                      start_date: startDate || null, end_date: endDate || null })
            .select().single()),
        delete: (id) =>
          q(s => s.from('cost_exclude_rules').delete().eq('id', id)),
      },

      categorySettings: {
        list: () =>
          q(s => s.from('cost_category_settings').select('*')),
        set: (category, includeInProfit) =>
          q(s => s.from('cost_category_settings').upsert(
            { category, include_in_profit: !!includeInProfit, updated_at: new Date().toISOString() },
            { onConflict: 'category' }).select().single()),
      },
    },

  };
})();
