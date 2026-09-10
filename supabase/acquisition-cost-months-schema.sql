-- Monatsweise Erfassung laufender Akquisitionskosten
-- (SEO, YouTube, Google Ads … – alles, was nicht einmalig ist)
--
-- Warum: Bei laufenden Kanälen war bisher nur ein Gesamtbetrag hinterlegt.
-- Man konnte nicht sehen, welche Monate darin schon enthalten sind und wann
-- zuletzt nachgetragen wurde. Die Monatszeilen machen das nachvollziehbar;
-- acquisition_costs.amount bleibt die Summe daraus, damit alle bestehenden
-- Auswertungen (ROI, Typ-Ansicht, CAC) unverändert weiterlaufen.

ALTER TABLE acquisition_costs
  ADD COLUMN IF NOT EXISTS is_recurring boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS acquisition_cost_months (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acquisition_cost_id uuid NOT NULL REFERENCES acquisition_costs(id) ON DELETE CASCADE,
  ym text NOT NULL CHECK (ym ~ '^[0-9]{4}-[0-9]{2}$'),   -- 'YYYY-MM'
  amount numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (acquisition_cost_id, ym)
);

CREATE INDEX IF NOT EXISTS acquisition_cost_months_cost_idx
  ON acquisition_cost_months (acquisition_cost_id);

ALTER TABLE acquisition_cost_months ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all on acquisition_cost_months" ON acquisition_cost_months;
CREATE POLICY "Allow all on acquisition_cost_months" ON acquisition_cost_months
  FOR ALL USING (true) WITH CHECK (true);
