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
