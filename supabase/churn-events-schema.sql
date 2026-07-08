-- Manuelle Churn-Overrides je Kontakt (Churn-Analyse).
-- Übersteuern die automatische, umsatzbasierte Churn-Erkennung:
--   status = 'churned' + churn_date -> Kunde gilt ab diesem Datum als abgewandert,
--                                      auch wenn die Heuristik ihn (noch) nicht flaggt.
--   status = 'active'               -> unterdrückt einen Fehlalarm (Kunde pausiert /
--                                      saisonal / Rechnung verzögert), NICHT abgewandert.
create table if not exists churn_events (
  id           uuid primary key default gen_random_uuid(),
  contact_name text not null,
  status       text not null default 'churned',
  churn_date   date,
  reason       text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (contact_name)
);

alter table churn_events enable row level security;

drop policy if exists "allow all churn_events" on churn_events;
create policy "allow all churn_events"
  on churn_events for all
  using (true) with check (true);
