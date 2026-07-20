-- Kunden-Fallback für die Service-Klassifizierung des LexOffice-Syncs.
-- Greift NUR, wenn weder Positionsname noch Rechnungstitel ein Service-Keyword
-- enthalten (matchService in functions/sync-lexoffice/index.ts). Typische Fälle:
-- Produktbilder-Rechnungen mit reinen Produktnamen (MTS) und stundenbasierte
-- Betreuungs-Rechnungen ("ALLGEMEIN – Absprachen…", Bega-Gruppe).
-- Bereits am 20.07.2026 via Management-API angelegt und geseedet.
CREATE TABLE IF NOT EXISTS service_overrides (
  contact_name text PRIMARY KEY,   -- exakter LexOffice-Kontaktname
  service      text NOT NULL,      -- 'Full Service' | 'PPC' | 'Bilder' | 'Masterclass' | 'Starter-Programm' | 'Beratung'
  created_at   timestamptz DEFAULT now()
);
ALTER TABLE service_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on service_overrides" ON service_overrides;
CREATE POLICY "Allow all on service_overrides" ON service_overrides FOR ALL USING (true) WITH CHECK (true);

INSERT INTO service_overrides (contact_name, service) VALUES
  ('Bega BBK Sp. z o.o. sp. K.',               'Full Service'),
  ('Stolkom Sp. z o. o.',                      'Full Service'),
  ('Innostyle Möbelvertriebs GmbH & Co. KG',   'Full Service'),
  ('Pol-Power Sp. z o.o.',                     'Full Service'),
  ('MTS MarkenTechnikService GmbH & Co. KG',   'Bilder'),
  ('MTS Group - Inter-Union Technohandel GmbH','Bilder'),
  ('M. Kreher Werkzeugvertrieb e.K.',          'Bilder'),
  ('Kay Link - smilestore',                    'PPC')
ON CONFLICT (contact_name) DO UPDATE SET service = EXCLUDED.service;
