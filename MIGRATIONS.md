# SQL Migrations

Run these in the Supabase SQL editor.

## 1. Add source column to clients

```sql
ALTER TABLE clients ADD COLUMN IF NOT EXISTS source text;
```

## 2. Create acquisition_costs table

```sql
CREATE TABLE IF NOT EXISTS acquisition_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name text NOT NULL,
  source_type text DEFAULT 'sonstige',
  amount numeric(12,2) NOT NULL DEFAULT 0,
  cost_date date,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE acquisition_costs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on acquisition_costs" ON acquisition_costs FOR ALL USING (true) WITH CHECK (true);
```

## 3. Create acquisition_contact_links table

```sql
CREATE TABLE IF NOT EXISTS acquisition_contact_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acquisition_cost_id uuid NOT NULL REFERENCES acquisition_costs(id) ON DELETE CASCADE,
  contact_name text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(acquisition_cost_id, contact_name)
);
ALTER TABLE acquisition_contact_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on acquisition_contact_links" ON acquisition_contact_links FOR ALL USING (true) WITH CHECK (true);
```

## 4. Freelancer-Verrechnungssatz + Umsatz-Ausschlüsse (MA-Umsatz-Modell)

```sql
-- Verrechnungssatz pro Mitarbeiter (was die Agentur dem Kunden pro Stunde
-- berechnet, z.B. 50 €/h für die Designerin). NICHT der Kostensatz (hourly_rate).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS billing_rate numeric;

-- Welche Mitarbeiter bei welchem Kunden NICHT am Umsatz beteiligt werden.
CREATE TABLE IF NOT EXISTS client_employee_exclusions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES clients(id)   ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(client_id, employee_id)
);
ALTER TABLE client_employee_exclusions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on client_employee_exclusions" ON client_employee_exclusions FOR ALL USING (true) WITH CHECK (true);
```

## 5. Kostenanalyse (Cost Analysis)

Im Supabase SQL-Editor **in dieser Reihenfolge** ausführen:

1. `supabase/cost-analysis-schema.sql` – legt die Tabellen an
   (`cost_transactions`, `cost_category_rules`, `cost_vat_rules`,
   `cost_exclude_rules`, `cost_category_settings`, `cost_imports`),
   RLS-Policies, Defaults (Steuern/Umsatzsteuer aus dem Gewinn vor Steuern)
   und die eingebauten Kreditkarten-Verrechnungs-Ausschlüsse.
2. `supabase/cost-analysis-seed-rules.sql` – seedt die 402 Kategorie- und
   27 MwSt-Regeln aus dem alten Google Sheet „Cost Analysis" + Red-Bull-Ausschluss.
   Idempotent (NOT EXISTS), kann gefahrlos erneut laufen.

**Transaktionshistorie laden:** Anschließend in der App unter
**Kostenanalyse → Import** die vorhandenen CSV-Dateien (Kreissparkasse + AMEX,
z. B. aus dem Google-Drive-Ordner) hochladen. Der Import ist idempotent
(Dedup über Signatur + Vorkommen), d. h. dieselbe oder eine überlappende Datei
erneut hochzuladen erzeugt keine Doppelbuchungen. So entsteht die vollständige
Historie mit konsistenter Kategorisierung/MwSt-Logik – ohne die im Sheet teils
abgeschnittenen Zeilen abzuschreiben.

> Umsatz kommt weiterhin aus Lexoffice; umsatzseitige Ausschlüsse (z. B. Red Bull)
> stehen wie gehabt unter **Einstellungen → Umsatz-Ausschlüsse**.

## 6. Churn-Analyse

```sql
-- oder: supabase/churn-events-schema.sql im SQL-Editor ausführen
create table if not exists churn_events (
  id           uuid primary key default gen_random_uuid(),
  contact_name text not null,
  status       text not null default 'churned',   -- 'churned' | 'active' (Fehlalarm unterdrücken)
  churn_date   date,
  reason       text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (contact_name)
);
alter table churn_events enable row level security;
drop policy if exists "allow all churn_events" on churn_events;
create policy "allow all churn_events" on churn_events for all using (true) with check (true);
```

Nur nötig für **manuelle** Churn-Einträge. Die automatische Churn-Erkennung
(≥ N aktive Monate, danach ≥ M Monate ohne Rechnung) läuft auch ohne diese
Tabelle rein aus der `revenue`-Historie.

## 7. Service-Klassifizierung: Kunden-Fallback (07/2026)

```sql
-- oder: supabase/service-overrides-schema.sql (inkl. Seed) im SQL-Editor ausführen
CREATE TABLE IF NOT EXISTS service_overrides (
  contact_name text PRIMARY KEY,
  service      text NOT NULL,
  created_at   timestamptz DEFAULT now()
);
ALTER TABLE service_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on service_overrides" ON service_overrides FOR ALL USING (true) WITH CHECK (true);
```

Bereits ausgeführt (20.07.2026). Fallback des LexOffice-Syncs für Kunden, deren
Rechnungstexte keine Service-Keywords enthalten (z.B. MTS → Bilder).

## 8. Teilzeit-Kapazität (07/2026)

```sql
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS capacity_pct numeric,   -- z.B. 70 für 70 %; NULL = Vollzeit
  ADD COLUMN IF NOT EXISTS capacity_from date;      -- NULL = gilt immer; sonst ab diesem Monat
```

Bereits ausgeführt (20.07.2026). Skaliert die verfügbaren Stunden in
Auslastung (utilization.js) und Freier Kapazität (employee-revenue.js);
Monate vor `capacity_from` rechnen mit 100 %. Pflegbar im Mitarbeiter-Formular.
