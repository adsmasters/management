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
      allContactNames: () =>
        q(s => s.from('revenue').select('contact_name').order('contact_name'))
          .then(rows => [...new Set(rows.map(r => r.contact_name).filter(Boolean))].sort()),
      allRows: () =>
        q(s => s.from('revenue').select('contact_name,total_amount').limit(100000)),
      forContacts: (contactNames) =>
        q(s => s.from('revenue').select('id,contact_name,year,month,total_amount')
          .in('contact_name', contactNames).order('year').order('month').limit(10000)),
      updateAmount: (id, total_amount) =>
        q(s => s.from('revenue').update({ total_amount }).eq('id', id).select().single()),
      clearMonth: (year, month) =>
        q(s => s.from('revenue').delete().eq('year', year).eq('month', month)),
      insertMany: (year, month, rows) =>
        q(s => s.from('revenue').insert(
          rows.map(r => ({ year, month, contact_name: r.contact_name, total_amount: r.total_amount }))
        )),
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

  };
})();
