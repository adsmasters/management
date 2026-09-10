-- ============================================================================
-- Kostenquellen scharf schalten: Migration + fertige Regeln für SEO,
-- Google Ads und YouTube. Im Supabase-SQL-Editor komplett ausführen.
--
-- Zeitliche Zuordnung: es zählt der MONAT DER ZAHLUNG (Buchungsdatum aus
-- Kreissparkasse/Amex), nicht der Leistungsmonat. Bewusst so entschieden –
-- über zwei Jahre gleicht sich der Versatz aus, und die Beträge sind klein
-- genug, dass eine Monatsverschiebung nichts kippt.
-- ============================================================================

-- 1) Tabelle und Spalten (identisch zu acquisition-cost-rules-schema.sql) ----
DO $guard$
BEGIN
  IF to_regclass('public.acquisition_cost_months') IS NULL THEN
    RAISE EXCEPTION 'Bitte zuerst supabase/acquisition-cost-months-schema.sql ausführen.';
  END IF;
END $guard$;

CREATE TABLE IF NOT EXISTS acquisition_cost_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acquisition_cost_id uuid NOT NULL REFERENCES acquisition_costs(id) ON DELETE CASCADE,
  match_type text NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains','equals','category')),
  pattern text NOT NULL,
  label text,
  created_at timestamptz DEFAULT now(),
  UNIQUE (acquisition_cost_id, pattern)
);
CREATE INDEX IF NOT EXISTS acquisition_cost_rules_cost_idx
  ON acquisition_cost_rules (acquisition_cost_id);
ALTER TABLE acquisition_cost_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on acquisition_cost_rules" ON acquisition_cost_rules;
CREATE POLICY "Allow all on acquisition_cost_rules" ON acquisition_cost_rules
  FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE acquisition_cost_months
  ADD COLUMN IF NOT EXISTS auto_amount   numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS manual_amount numeric(12,2) NOT NULL DEFAULT 0;
UPDATE acquisition_cost_months
   SET manual_amount = amount
 WHERE manual_amount = 0 AND amount <> 0;

-- 2) Für Google Ads 2026 gibt es noch keinen Eintrag ------------------------
INSERT INTO acquisition_costs (source_name, source_type, amount, cost_date, is_recurring)
SELECT 'Google Ads 2026', 'online-marketing', 0, '2026-01-01', true
WHERE NOT EXISTS (SELECT 1 FROM acquisition_costs WHERE source_name = 'Google Ads 2026');

-- 3) Die betroffenen Einträge auf monatliche Erfassung stellen --------------
UPDATE acquisition_costs SET is_recurring = true
 WHERE source_name IN (
   'Google Organic Search 2026 (Stand Ende August) & KI',
   'Google Organic Search 2025 & KI',
   'Google Ads - Leads (2500)',
   'Google Ads 2026',
   'YouTube 2026 (Bis Ende August)',
   'YouTube 2025'
 );

-- 4) Regeln setzen ----------------------------------------------------------
-- Jeder Eintrag zieht nur die Buchungen SEINES Jahres (aus cost_date), die
-- Suchbegriffe dürfen deshalb bei 2025 und 2026 identisch sein.
INSERT INTO acquisition_cost_rules (acquisition_cost_id, match_type, pattern, label)
SELECT c.id, 'contains', r.pattern, r.label
FROM acquisition_costs c
JOIN (VALUES
  -- SEO: Backlinks + SEO-Freelancer
  ('Google Organic Search 2026 (Stand Ende August) & KI', 'BACKLINKED',    'Backlinked'),
  ('Google Organic Search 2026 (Stand Ende August) & KI', 'Baris Dag',     'Baris Dag (SEO)'),
  ('Google Organic Search 2025 & KI',                     'BACKLINKED',    'Backlinked'),
  ('Google Organic Search 2025 & KI',                     'Baris Dag',     'Baris Dag (SEO)'),
  -- Google Ads: die Kundennummer fängt beide Schreibweisen
  -- ("GOOGLE*ADS6354044357" und "GOOGLE *ADS6354044357")
  ('Google Ads 2026',                                     'ADS6354044357', 'Google Ads'),
  ('Google Ads - Leads (2500)',                           'ADS6354044357', 'Google Ads'),
  -- YouTube: Teilbegriff fängt "T&P Fotografie" und "T & P Fotografie"
  ('YouTube 2026 (Bis Ende August)',                      'Fotografie',    'T&P Fotografie'),
  ('YouTube 2025',                                        'Fotografie',    'T&P Fotografie')
) AS r(source_name, pattern, label) ON r.source_name = c.source_name
ON CONFLICT (acquisition_cost_id, pattern) DO NOTHING;

-- Kontrolle
SELECT c.source_name, c.cost_date, c.amount AS bisher, r.pattern
FROM acquisition_costs c
JOIN acquisition_cost_rules r ON r.acquisition_cost_id = c.id
ORDER BY c.cost_date DESC, r.pattern;
