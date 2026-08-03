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

## 9. Abwesenheit vs. Austritt (07/2026)

```sql
ALTER TABLE employees ADD COLUMN IF NOT EXISTS leave_until date;
```

Bereits ausgeführt (20.07.2026). `leave_start` OHNE `leave_until` = endgültig
ausgeschieden (in Kapazitäts-Ansicht ausgeblendet, Umsatz-Historie bleibt).
`leave_start` MIT `leave_until` = vorübergehend abwesend (Mutterschutz/
Elternzeit): bleibt sichtbar mit 0 Kapazität, nach dem Enddatum wieder volle
Kapazität und Kosten. Austrittsmonat zählt anteilig nach Tagen.

## 12. Personal-Seite: HR-Felder + Abwesenheits-Einträge (ausgeführt 03.08.2026)

```sql
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS iban text,
  ADD COLUMN IF NOT EXISTS start_date date,
  ADD COLUMN IF NOT EXISTS work_location text,
  ADD COLUMN IF NOT EXISTS applied_via text,
  ADD COLUMN IF NOT EXISTS personality_test text,
  ADD COLUMN IF NOT EXISTS vacation_days_per_year numeric,
  ADD COLUMN IF NOT EXISTS hr_notes text,
  ADD COLUMN IF NOT EXISTS hr_custom jsonb DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS hr_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  sort integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE hr_fields ENABLE ROW LEVEL SECURITY;
CREATE POLICY authenticated_all ON hr_fields FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS absence_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'vacation',        -- vacation | sick
  start_date date NOT NULL,
  end_date date NOT NULL,
  days numeric NOT NULL DEFAULT 0,              -- Arbeitstage (0.5 = halber Tag)
  note text,
  source text DEFAULT 'manual',                 -- manual | gcal
  gcal_uid text UNIQUE,                         -- Google-Event-ID (Sync-Dedupe)
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS absence_entries_emp_idx ON absence_entries (employee_id, start_date);
ALTER TABLE absence_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY authenticated_all ON absence_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);
```

Hinweis: `employee_absences` (Monats-Aggregate, Auslastung) wird von personal.js
automatisch aus `absence_entries` neu berechnet (pro Typ nur, wenn Einträge existieren).

## 13. Werkstudenten: anteilige Urlaubszählung (ausgeführt 03.08.2026)

```sql
ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_days_per_week numeric DEFAULT 5;
```

Urlaubstage werden mit Faktor (work_days_per_week ÷ 5) gezählt, z.B. 2/Woche →
volle Urlaubswoche = 2 Tage. Gilt für Auto-Berechnung und Kalender-Sync.

## 14. Bundesland pro Mitarbeiter für Feiertage (ausgeführt 03.08.2026)

```sql
ALTER TABLE employees ADD COLUMN IF NOT EXISTS federal_state text DEFAULT 'NW';
```

Feiertage werden je Mitarbeiter nach Bundesland berechnet (Default NW).
Sonderwert 'XX' = keine deutschen Feiertage (Ausland, nur Wochenenden).

## 15. Personal-Bereich: hr_hidden-Schalter (ausgeführt 03.08.2026)

```sql
ALTER TABLE employees ADD COLUMN IF NOT EXISTS hr_hidden boolean DEFAULT false;
```

Blendet einzelne Personen aus dem Personal-Bereich aus (z.B. Freelancer mit
role=advertising wie Laura G), ohne role/active anzufassen — Auslastung
bleibt unberührt. Mitarbeiter in Abwesenheit (leave_start/leave_until,
z.B. Mutterschutz) werden auf der Personal-Seite automatisch ausgeblendet.

## 16. Arbeitstage-Verlauf für unterjährige Wechsel (ausgeführt 03.08.2026)

```sql
ALTER TABLE employees ADD COLUMN IF NOT EXISTS workdays_history jsonb DEFAULT '[]'::jsonb;
```

Format: `[{"from":"2026-06-01","days":2.5}]` — Arbeitstage/Woche ab Datum.
Urlaubszählung nutzt tagesgenau den zum jeweiligen Datum gültigen Wert
(Basis: work_days_per_week). Kapazitäts-% (capacity_pct) beeinflusst die
Urlaubszählung bewusst NICHT (nur Wochentage zählen).
