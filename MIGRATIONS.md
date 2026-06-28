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

## 3. Kostenanalyse (Cost Analysis)

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
