-- Nicht zugeordneter (Rest-)Umsatz eines Kunden wird einem Mitarbeiter
-- gutgeschrieben (z.B. Inhaber). Umfasst Umsatz ohne gebuchte Stunden,
-- bewusst ausgeschlossene Rechnungen und Zurechnungs-Rest. Ein MA je Kunde.
create table if not exists client_residual_assignments (
  client_id   uuid primary key,
  employee_id uuid not null,
  created_at  timestamptz not null default now()
);

alter table client_residual_assignments enable row level security;

drop policy if exists "allow all client_residual_assignments" on client_residual_assignments;
create policy "allow all client_residual_assignments"
  on client_residual_assignments for all
  using (true) with check (true);
