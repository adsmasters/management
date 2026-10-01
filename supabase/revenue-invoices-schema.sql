-- Einzelrechnungen pro Monat (befüllt vom LexOffice-Sync, additiv zu revenue)
-- + Ausschluss einzelner Rechnungen vom Umsatz (z.B. Doppel-/Sonderrechnung).
--   Ausgeschlossene Rechnungen landen weiter in revenue_invoices (excluded=true),
--   zählen aber NICHT in revenue / revenue_services.
create table if not exists revenue_invoices (
  id             uuid primary key default gen_random_uuid(),
  year           int  not null,
  month          int  not null,
  contact_name   text not null,
  voucher_id     text not null,
  voucher_number text,
  voucher_date   date,
  title          text,
  amount         numeric(12,2) not null default 0,  -- Netto-Anteil für diesen Monat
  excluded       boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (year, month, voucher_id)
);
create index if not exists revenue_invoices_ym on revenue_invoices (year, month);

create table if not exists revenue_invoice_exclusions (
  voucher_id     text primary key,
  contact_name   text,
  voucher_number text,
  note           text,
  created_at     timestamptz not null default now()
);

alter table revenue_invoices enable row level security;
alter table revenue_invoice_exclusions enable row level security;
drop policy if exists "allow all revenue_invoices" on revenue_invoices;
create policy "allow all revenue_invoices" on revenue_invoices for all using (true) with check (true);
drop policy if exists "allow all revenue_invoice_exclusions" on revenue_invoice_exclusions;
create policy "allow all revenue_invoice_exclusions" on revenue_invoice_exclusions for all using (true) with check (true);
