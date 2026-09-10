-- Zeitfenster für Kostenquellen
--
-- Warum: Ein Webinar wird über Facebook und Google beworben. Der Kunde kommt
-- aber "über das Webinar" – welche Plattform ihn ins Webinar gebracht hat, ist
-- nicht messbar. Die Werbekosten gehören deshalb in den Webinar-Eintrag, nicht
-- in eigene Plattform-Quellen (sonst stünden dort Kosten ohne Kunden und beim
-- Webinar Kunden ohne Kosten).
--
-- Da sich mehrere Aktionen denselben Werbekonto-Lieferanten teilen, braucht die
-- Regel eine zeitliche Eingrenzung – wie cost_vat_rules sie schon kennt.
ALTER TABLE acquisition_cost_rules
  ADD COLUMN IF NOT EXISTS start_date date,
  ADD COLUMN IF NOT EXISTS end_date   date;
