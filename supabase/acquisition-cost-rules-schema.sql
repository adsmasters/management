-- Akquisitionskosten aus der Kostenanalyse speisen
--
-- Bisher musste jeder Monatswert von Hand eingetragen werden, obwohl die Zahlen
-- über die Kreissparkasse-/Amex-Uploads längst in cost_transactions liegen:
-- YouTube = "T&P Fotografie", SEO = "Backlinked" + SEO-Freelancer, dazu Google
-- Ads. Eine Regel je Lieferant genügt, den Rest rechnet die Seite aus. Statt
-- eines Suchbegriffs kann eine Regel auch eine ganze Kategorie greifen
-- (match_type='category'), weil die Buchungen dort schon einsortiert sind.
--
-- Übernommen wird nichts von allein: die Seite schlägt die Beträge vor,
-- geschrieben wird erst auf Knopfdruck.
--
-- Gerechnet wird mit amount_net: der Umsatz im Tool ist netto, die MwSt kommt
-- als Vorsteuer zurück. Sonst wäre der ROI systematisch zu schlecht.

-- Reihenfolge: acquisition-cost-months-schema.sql muss vorher gelaufen sein.
DO $guard$
BEGIN
  IF to_regclass('public.acquisition_cost_months') IS NULL THEN
    RAISE EXCEPTION 'Bitte zuerst supabase/acquisition-cost-months-schema.sql ausführen.';
  END IF;
END $guard$;

CREATE TABLE IF NOT EXISTS acquisition_cost_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acquisition_cost_id uuid NOT NULL REFERENCES acquisition_costs(id) ON DELETE CASCADE,
  -- contains/equals = Buchungstext, category = Kategorie aus der Kostenanalyse
  match_type text NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains','equals','category')),
  pattern text NOT NULL,          -- Suchbegriff im Buchungstext bzw. Kategoriename
  label text,                     -- Anzeigename, z.B. 'T&P Fotografie'
  created_at timestamptz DEFAULT now(),
  UNIQUE (acquisition_cost_id, pattern)
);

CREATE INDEX IF NOT EXISTS acquisition_cost_rules_cost_idx
  ON acquisition_cost_rules (acquisition_cost_id);

ALTER TABLE acquisition_cost_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on acquisition_cost_rules" ON acquisition_cost_rules;
CREATE POLICY "Allow all on acquisition_cost_rules" ON acquisition_cost_rules
  FOR ALL USING (true) WITH CHECK (true);

-- Monatswert bekommt zwei Herkünfte: was aus den Bankdaten kommt und was von
-- Hand dazukommt (z.B. ein separat gekaufter Backlink). amount bleibt die
-- Summe daraus und damit die Zahl, mit der alle Auswertungen rechnen.
ALTER TABLE acquisition_cost_months
  ADD COLUMN IF NOT EXISTS auto_amount   numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS manual_amount numeric(12,2) NOT NULL DEFAULT 0;

-- Was bisher drinsteht, war von Hand erfasst.
UPDATE acquisition_cost_months
   SET manual_amount = amount
 WHERE manual_amount = 0 AND amount <> 0;
