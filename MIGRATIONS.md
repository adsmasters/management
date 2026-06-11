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
