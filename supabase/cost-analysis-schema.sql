-- ============================================================================
-- Kostenanalyse (Cost Analysis) – Schema
-- Im Supabase SQL-Editor ausführen. Alle Tabellen sind additiv; bestehende
-- Daten werden nicht verändert.
-- ============================================================================

-- 1. Import-Protokoll: ein Eintrag pro hochgeladener CSV-Datei -----------------
CREATE TABLE IF NOT EXISTS cost_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text NOT NULL,                 -- 'kreissparkasse' | 'amex'
  filename      text,
  file_hash     text,                          -- informativ: Datei schon mal importiert?
  row_count     int  NOT NULL DEFAULT 0,       -- neu eingefügte Zeilen
  skipped_count int  NOT NULL DEFAULT 0,       -- als Duplikat übersprungen
  period_label  text,                          -- z.B. "Nov 2025 – März 2026"
  created_at    timestamptz DEFAULT now()
);
ALTER TABLE cost_imports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on cost_imports" ON cost_imports;
CREATE POLICY "Allow all on cost_imports" ON cost_imports FOR ALL USING (true) WITH CHECK (true);

-- 2. Transaktionen: eine Zeile je Bank-/Kreditkartenbuchung -------------------
-- amount_gross ist NORMALISIERT als Kostenbeitrag: positiv = ausgegeben.
--   Kreissparkasse: nur Abflüsse (Betrag < 0) werden als Kosten importiert.
--   AMEX:           Belastungen positiv = Kosten, Gutschriften negativ.
CREATE TABLE IF NOT EXISTS cost_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_date       date    NOT NULL,
  year          int     NOT NULL,
  month         int     NOT NULL,
  source        text    NOT NULL,              -- 'kreissparkasse' | 'amex'
  description   text    NOT NULL,              -- kombinierter Match-Text
  payee         text,                          -- Beguenstigter/Zahlungspflichtiger
  purpose       text,                          -- Verwendungszweck / Beschreibung
  booking_text  text,                          -- Buchungstext (nur Bank)
  amount_gross  numeric(12,2) NOT NULL,        -- Brutto-Kostenbeitrag (positiv = Kosten)
  category      text,                          -- NULL = noch nicht kategorisiert
  vat_rate      numeric(6,4)  NOT NULL DEFAULT 0,    -- z.B. 0.1900
  vat_amount    numeric(12,2) NOT NULL DEFAULT 0,    -- enthaltene MwSt
  amount_net    numeric(12,2) NOT NULL,              -- Brutto - MwSt
  excluded      boolean NOT NULL DEFAULT false,      -- aus Profit ausgeschlossen
  exclude_reason text,
  import_id     uuid REFERENCES cost_imports(id) ON DELETE CASCADE,
  dedup_hash    text NOT NULL UNIQUE,           -- source|datum|betrag|text|vorkommen
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);
ALTER TABLE cost_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on cost_transactions" ON cost_transactions;
CREATE POLICY "Allow all on cost_transactions" ON cost_transactions FOR ALL USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_cost_tx_year_month ON cost_transactions (year, month);
CREATE INDEX IF NOT EXISTS idx_cost_tx_category   ON cost_transactions (category);

-- 3. Kategorie-Regeln ("Dictionary") -----------------------------------------
CREATE TABLE IF NOT EXISTS cost_category_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_type text NOT NULL DEFAULT 'contains',  -- 'contains' | 'equals'
  pattern    text NOT NULL,
  category   text NOT NULL,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE cost_category_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on cost_category_rules" ON cost_category_rules;
CREATE POLICY "Allow all on cost_category_rules" ON cost_category_rules FOR ALL USING (true) WITH CHECK (true);

-- 4. MwSt-Regeln (Lieferant -> Steuersatz, optional zeitlich begrenzt) --------
CREATE TABLE IF NOT EXISTS cost_vat_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_type text NOT NULL DEFAULT 'contains',
  pattern    text NOT NULL,
  vat_rate   numeric(6,4) NOT NULL DEFAULT 0.1900,
  start_date date,
  end_date   date,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE cost_vat_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on cost_vat_rules" ON cost_vat_rules;
CREATE POLICY "Allow all on cost_vat_rules" ON cost_vat_rules FOR ALL USING (true) WITH CHECK (true);

-- 5. Ausschluss-Regeln (kostenseitig; z.B. Red Bull, Kreditkarten-Verrechnung)-
CREATE TABLE IF NOT EXISTS cost_exclude_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_type text NOT NULL DEFAULT 'contains',
  pattern    text NOT NULL,
  reason     text,
  builtin    boolean NOT NULL DEFAULT false,    -- systemseitig (Kreditkarten-Verrechnung)
  created_at timestamptz DEFAULT now()
);
ALTER TABLE cost_exclude_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on cost_exclude_rules" ON cost_exclude_rules;
CREATE POLICY "Allow all on cost_exclude_rules" ON cost_exclude_rules FOR ALL USING (true) WITH CHECK (true);

-- 6. Kategorie-Einstellungen: zählt eine Kategorie in den Gewinn vor Steuern? -
-- Fehlt eine Kategorie hier, gilt sie als EINBEZOGEN (include_in_profit = true).
CREATE TABLE IF NOT EXISTS cost_category_settings (
  category          text PRIMARY KEY,
  include_in_profit boolean NOT NULL DEFAULT true,
  updated_at        timestamptz DEFAULT now()
);
ALTER TABLE cost_category_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on cost_category_settings" ON cost_category_settings;
CREATE POLICY "Allow all on cost_category_settings" ON cost_category_settings FOR ALL USING (true) WITH CHECK (true);

-- Defaults: Gewinnsteuern & Umsatzsteuer NICHT in "Gewinn vor Steuern".
INSERT INTO cost_category_settings (category, include_in_profit) VALUES
  ('Steuern',      false),   -- Körperschaft-/Gewerbesteuer
  ('Umsatzsteuer', false)
ON CONFLICT (category) DO NOTHING;

-- Eingebaute Ausschlüsse: Kreditkarten-Verrechnung (verhindert Doppelzählung) -
INSERT INTO cost_exclude_rules (match_type, pattern, reason, builtin) VALUES
  ('contains', 'AMERICAN EXPRESS',           'Kreditkarten-Verrechnung (AMEX-Posten zählen einzeln)', true),
  ('contains', 'EIGENE KREDITKARTENABRECHN', 'Kreditkarten-Verrechnung (AMEX-Posten zählen einzeln)', true),
  ('contains', 'UEBERWEISUNG ERHALTEN BESTEN DANK', 'Kreditkarten-Zahlung (Ausgleich, keine Kosten)',  true),
  ('contains', 'ÜBERWEISUNG ERHALTEN BESTEN DANK',  'Kreditkarten-Zahlung (Ausgleich, keine Kosten)',  true)
ON CONFLICT DO NOTHING;
