-- Rechnungen (LexOffice-Kontakte), die NICHT auf Mitarbeiter zugerechnet werden.
-- Der Umsatz bleibt im Kunden-Gesamt und in der Profitabilitaet voll enthalten;
-- er faellt nur aus der MA-Umsatz-Verteilung raus (z.B. Betreuung durch den Inhaber).
create table if not exists ma_revenue_exclusions (
  contact_name text primary key,          -- exakter LexOffice-Kontaktname der Rechnung
  note         text,
  created_at   timestamptz not null default now()
);

alter table ma_revenue_exclusions enable row level security;

drop policy if exists "allow all ma_revenue_exclusions" on ma_revenue_exclusions;
create policy "allow all ma_revenue_exclusions"
  on ma_revenue_exclusions for all
  using (true) with check (true);
