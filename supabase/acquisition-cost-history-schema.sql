-- Änderungsverlauf für Akquisitionskosten
--
-- Warum: acquisition_costs.updated_at wird bei jeder Änderung überschrieben.
-- Damit lässt sich nicht mehr beantworten, wann ein Betrag zuletzt erhöht
-- wurde – z. B. ob der August in einem laufenden Kanal schon drinsteckt.
-- Die Historie hängt an Triggern, nicht am Frontend: so wird auch eine
-- Änderung direkt im Supabase-Editor mitgeschrieben.

-- Reihenfolge: acquisition-cost-months-schema.sql muss vorher gelaufen sein.
DO $guard$
BEGIN
  IF to_regclass('public.acquisition_cost_months') IS NULL THEN
    RAISE EXCEPTION 'Bitte zuerst supabase/acquisition-cost-months-schema.sql ausführen.';
  END IF;
END $guard$;

CREATE TABLE IF NOT EXISTS acquisition_cost_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acquisition_cost_id uuid NOT NULL REFERENCES acquisition_costs(id) ON DELETE CASCADE,
  changed_at timestamptz NOT NULL DEFAULT now(),
  -- baseline = Stand bei Einführung des Verlaufs (keine echte Änderung)
  field text NOT NULL CHECK (field IN ('baseline','created','amount','name','month')),
  ym text,                      -- nur bei field='month'
  old_amount numeric(12,2),
  new_amount numeric(12,2),
  old_text text,
  new_text text
);

CREATE INDEX IF NOT EXISTS acquisition_cost_history_cost_idx
  ON acquisition_cost_history (acquisition_cost_id, changed_at DESC);

ALTER TABLE acquisition_cost_history ENABLE ROW LEVEL SECURITY;

-- Lesen darf jeder; geschrieben wird ausschließlich durch die Trigger
-- (SECURITY DEFINER umgeht RLS). Der Verlauf ist damit aus der Anwendung
-- heraus nicht manipulierbar.
DROP POLICY IF EXISTS "Read acquisition_cost_history" ON acquisition_cost_history;
CREATE POLICY "Read acquisition_cost_history" ON acquisition_cost_history
  FOR SELECT USING (true);

-- ── Trigger: Betrag und Name am Eintrag selbst ────────────────────────
CREATE OR REPLACE FUNCTION log_acquisition_cost_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO acquisition_cost_history (acquisition_cost_id, field, new_amount, new_text)
    VALUES (NEW.id, 'created', NEW.amount, NEW.source_name);
    RETURN NEW;
  END IF;

  IF NEW.amount IS DISTINCT FROM OLD.amount THEN
    INSERT INTO acquisition_cost_history (acquisition_cost_id, field, old_amount, new_amount)
    VALUES (NEW.id, 'amount', OLD.amount, NEW.amount);
  END IF;

  -- Umbenennungen mitschreiben: ein Stand im Namen („Bis Ende August") sagt
  -- sonst nichts darüber, ob der Betrag mitgezogen wurde.
  IF NEW.source_name IS DISTINCT FROM OLD.source_name THEN
    INSERT INTO acquisition_cost_history (acquisition_cost_id, field, old_text, new_text)
    VALUES (NEW.id, 'name', OLD.source_name, NEW.source_name);
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS acquisition_costs_log ON acquisition_costs;
CREATE TRIGGER acquisition_costs_log
  AFTER INSERT OR UPDATE ON acquisition_costs
  FOR EACH ROW EXECUTE FUNCTION log_acquisition_cost_change();

-- ── Trigger: einzelne Monatswerte ─────────────────────────────────────
CREATE OR REPLACE FUNCTION log_acquisition_month_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO acquisition_cost_history (acquisition_cost_id, field, ym, new_amount)
    VALUES (NEW.acquisition_cost_id, 'month', NEW.ym, NEW.amount);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.amount IS DISTINCT FROM OLD.amount THEN
      INSERT INTO acquisition_cost_history (acquisition_cost_id, field, ym, old_amount, new_amount)
      VALUES (NEW.acquisition_cost_id, 'month', NEW.ym, OLD.amount, NEW.amount);
    END IF;
    RETURN NEW;
  END IF;

  -- DELETE: beim Löschen des ganzen Eintrags ist die Elternzeile schon weg,
  -- dann würde der Fremdschlüssel brechen – deshalb der EXISTS-Test.
  IF EXISTS (SELECT 1 FROM acquisition_costs WHERE id = OLD.acquisition_cost_id) THEN
    INSERT INTO acquisition_cost_history (acquisition_cost_id, field, ym, old_amount)
    VALUES (OLD.acquisition_cost_id, 'month', OLD.ym, OLD.amount);
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS acquisition_cost_months_log ON acquisition_cost_months;
CREATE TRIGGER acquisition_cost_months_log
  AFTER INSERT OR UPDATE OR DELETE ON acquisition_cost_months
  FOR EACH ROW EXECUTE FUNCTION log_acquisition_month_change();

-- ── Startpunkt für bestehende Einträge ────────────────────────────────
-- Kein erfundener Verlauf: festgehalten wird nur der Betrag, der beim
-- Einschalten der Historie in der Zeile stand, mit dem Zeitstempel der
-- letzten Änderung laut updated_at. Alles davor hat die DB nie gespeichert.
INSERT INTO acquisition_cost_history (acquisition_cost_id, changed_at, field, new_amount, new_text)
SELECT c.id, COALESCE(c.updated_at, c.created_at, now()), 'baseline', c.amount, c.source_name
FROM acquisition_costs c
WHERE NOT EXISTS (
  SELECT 1 FROM acquisition_cost_history h WHERE h.acquisition_cost_id = c.id
);
