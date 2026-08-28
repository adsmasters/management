-- ============================================================================
-- Cashflow-Modul – Schema
-- Im Supabase SQL-Editor ausführen (oder via Management-API). Rein additiv.
-- RLS wie bei den übrigen Management-Tabellen: nur der Owner-Account.
-- ============================================================================

-- 1. Konten: Girokonto(en) + Kreditkarte, je mit Anfangssaldo -----------------
-- Der Kontostand wird aus den importierten Umsätzen gerechnet. Beginnt die
-- erste CSV nicht bei 0, trägt der Nutzer hier den Saldo VOR der ersten
-- importierten Buchung ein (opening_balance zum opening_date).
CREATE TABLE IF NOT EXISTS bank_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text NOT NULL UNIQUE,             -- 'kreissparkasse' | 'amex'
  name            text NOT NULL,
  kind            text NOT NULL DEFAULT 'bank',     -- 'bank' | 'credit_card'
  iban            text,
  opening_balance numeric(12,2) NOT NULL DEFAULT 0, -- Saldo vor der ersten importierten Buchung
  opening_date    date,
  settlement_day  int,                              -- Kreditkarte: Tag der Sammelabbuchung
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- 2. Import-Protokoll: ein Eintrag je hochgeladener CSV ----------------------
CREATE TABLE IF NOT EXISTS bank_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text NOT NULL,
  filename      text,
  file_hash     text,
  row_count     int NOT NULL DEFAULT 0,      -- neu eingefügt
  skipped_count int NOT NULL DEFAULT 0,      -- als Duplikat übersprungen
  period_from   date,
  period_to     date,
  period_label  text,
  created_at    timestamptz DEFAULT now()
);

-- 3. Kontoumsätze ------------------------------------------------------------
-- amount ist VORZEICHENBEHAFTET aus Kontosicht: + = Eingang, - = Ausgang.
-- (Anders als cost_transactions.amount_gross, das nur Kosten positiv führt.)
CREATE TABLE IF NOT EXISTS bank_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_date       date NOT NULL,
  value_date    date,
  year          int NOT NULL,
  month         int NOT NULL,
  source        text NOT NULL,               -- 'kreissparkasse' | 'amex'
  account_id    uuid REFERENCES bank_accounts(id) ON DELETE SET NULL,
  booking_text  text,
  purpose       text,
  payee         text,
  description   text NOT NULL,
  amount        numeric(12,2) NOT NULL,      -- + Eingang / - Ausgang
  category      text,                        -- Kategorie aus cost_category_rules
  flow_type     text,                        -- 'client_payment' | 'adspend_amazon' | 'card_settlement' | 'salary' | 'tax' | 'other_in' | 'other_out'
  is_card_settlement boolean NOT NULL DEFAULT false,  -- Sammelabbuchung der Kreditkarte
  import_id     uuid REFERENCES bank_imports(id) ON DELETE CASCADE,
  dedup_key     text NOT NULL,               -- Buchungstag|Betrag|Verwendungszweck(|Vorkommen)
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_tx_dedup_uidx ON bank_transactions (dedup_key);
CREATE INDEX IF NOT EXISTS bank_tx_date_idx        ON bank_transactions (tx_date);
CREATE INDEX IF NOT EXISTS bank_tx_year_month_idx  ON bank_transactions (year, month);

-- 4. Fixkosten-Plan ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS fixed_costs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label       text NOT NULL,
  amount      numeric(12,2) NOT NULL DEFAULT 0,
  pay_day     int NOT NULL DEFAULT 1,            -- Zahltag im Monat (1–31)
  rhythm      text NOT NULL DEFAULT 'monthly',   -- 'monthly' | 'quarterly' | 'yearly'
  start_month int,                               -- Anker für quartals-/jährliche Zahlung (1–12)
  bucket      text NOT NULL DEFAULT 'other_out', -- Vorschau-Zeile: 'salary' | 'supplier' | 'adspend_amazon' | 'tax' | 'other_out'
  active      boolean NOT NULL DEFAULT true,
  sort        int NOT NULL DEFAULT 0,
  note        text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- 5. Steuertermine -----------------------------------------------------------
-- kind='ustva' mit auto_estimate=true → Betrag wird geschätzt (USt aus Rechnungen
-- minus Vorsteuer aus den Buchungen); sonst gilt der eingetragene Betrag.
CREATE TABLE IF NOT EXISTS tax_dates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL DEFAULT 'other',   -- 'ustva' | 'kst' | 'gewst' | 'other'
  label         text NOT NULL,
  due_date      date NOT NULL,
  amount        numeric(12,2) NOT NULL DEFAULT 0,
  auto_estimate boolean NOT NULL DEFAULT false,
  period_label  text,
  note          text,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tax_dates_due_idx ON tax_dates (due_date);

-- 6. Geplante Zahlungen: Eingangsrechnungen + sonstige Ein-/Auszahlungen ------
-- Fällt die Lexoffice-Schnittstelle für Eingangsrechnungen aus, pflegt der
-- Nutzer sie hier (Lieferant, Betrag, Fälligkeit). lexoffice_id verhindert
-- Doppel-Anlage beim automatischen Abgleich.
CREATE TABLE IF NOT EXISTS ap_invoices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL DEFAULT 'supplier', -- 'supplier' | 'adspend_amazon' | 'other_income'
  supplier     text NOT NULL,
  amount       numeric(12,2) NOT NULL DEFAULT 0, -- immer positiv; Vorzeichen ergibt sich aus kind
  due_date     date NOT NULL,
  paid         boolean NOT NULL DEFAULT false,
  source       text NOT NULL DEFAULT 'manual',   -- 'manual' | 'lexoffice'
  lexoffice_id text UNIQUE,
  note         text,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ap_invoices_due_idx ON ap_invoices (due_date);

-- 7. Einstellungen (Ad-Spend-Erkennung, USt-Modus, Fristverlängerung …) ------
CREATE TABLE IF NOT EXISTS cashflow_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

-- ── RLS: nur der Owner-Account (wie employees.owner_full) ───────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_accounts','bank_imports','bank_transactions',
                           'fixed_costs','tax_dates','ap_invoices','cashflow_settings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS owner_full ON %I', t);
    EXECUTE format($p$CREATE POLICY owner_full ON %I FOR ALL TO authenticated
                      USING ((auth.jwt() ->> 'email') = 'hallo@tobias-dziuba.de')
                      WITH CHECK ((auth.jwt() ->> 'email') = 'hallo@tobias-dziuba.de')$p$, t);
  END LOOP;
END $$;

-- ── Startwerte ──────────────────────────────────────────────────────────────
INSERT INTO bank_accounts (source, name, kind, iban, settlement_day) VALUES
  ('kreissparkasse', 'Kreissparkasse Geschäftskonto', 'bank', NULL, NULL),
  ('amex',           'American Express',              'credit_card', NULL, NULL)
ON CONFLICT (source) DO NOTHING;

-- Fixkosten: Startwerte, vom Nutzer anzupassen.
INSERT INTO fixed_costs (label, amount, pay_day, rhythm, bucket, sort)
SELECT * FROM (VALUES
  ('Gehälter Mitarbeiter',        0::numeric, 27, 'monthly', 'salary',    10),
  ('Geschäftsführergehalt',       0::numeric, 27, 'monthly', 'salary',    20),
  ('Sozialabgaben & Lohnsteuer',  0::numeric, 27, 'monthly', 'salary',    30),
  ('Miete Büro',                  0::numeric, 30, 'monthly', 'supplier',  40),
  ('Software-Abos',               0::numeric, 15, 'monthly', 'supplier',  50),
  ('Buchführung / Steuerberater', 0::numeric, 15, 'monthly', 'supplier',  60)
) AS v(label, amount, pay_day, rhythm, bucket, sort)
WHERE NOT EXISTS (SELECT 1 FROM fixed_costs);
