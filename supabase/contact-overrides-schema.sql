-- Zentrale Kontakt-Status-Overrides (fuer alle Dashboards, teamweit).
--   status = 'excluded'  -> zaehlt NIRGENDS als Umsatz (z.B. Event-/Durchlaufrechnung)
-- Nicht ausgeschlossene, nicht zugeordnete Kontakte zaehlen ueberall als
-- "Umsatz ohne Kunde" (Sammelumsatz) mit.
create table if not exists contact_overrides (
  contact_name text primary key,
  status       text not null,
  created_at   timestamptz not null default now()
);

alter table contact_overrides enable row level security;

drop policy if exists "allow all contact_overrides" on contact_overrides;
create policy "allow all contact_overrides"
  on contact_overrides for all
  using (true) with check (true);
