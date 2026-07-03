-- Regel: eine Leistung (PPC, Full Service, Bilder, Andere ...) eines Kunden wird
-- gezielt bestimmten Mitarbeitern zugerechnet, statt nach Stunden ueber alle.
-- Gilt dauerhaft (monatsuebergreifend). Mehrere MA je Leistung moeglich.
create table if not exists revenue_service_assignments (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid  not null,
  service     text  not null,
  employee_id uuid  not null,
  created_at  timestamptz not null default now(),
  unique (client_id, service, employee_id)
);

alter table revenue_service_assignments enable row level security;

drop policy if exists "allow all revenue_service_assignments" on revenue_service_assignments;
create policy "allow all revenue_service_assignments"
  on revenue_service_assignments for all
  using (true) with check (true);
