-- Persist reviewed cash-basis amounts separately from immutable accrual lines.
ALTER TABLE journal_entries ADD COLUMN cash_components jsonb;
ALTER TABLE ledger_imports ADD COLUMN cash_overrides jsonb NOT NULL DEFAULT '{}';
ALTER TABLE journal_entries ADD CONSTRAINT cash_components_array CHECK (cash_components IS NULL OR jsonb_typeof(cash_components) = 'array');

CREATE FUNCTION app.validate_import_cash_components() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.cash_components IS NOT DISTINCT FROM OLD.cash_components THEN RETURN NEW; END IF;
  IF NEW.cash_components IS NULL AND (TG_OP = 'INSERT' OR OLD.cash_components IS NULL) THEN RETURN NEW; END IF;
  IF NEW.source_type::text <> 'import' THEN RAISE EXCEPTION 'Only imported entries accept cash components' USING ERRCODE = 'check_violation'; END IF;
  IF app.is_date_locked(NEW.company_id, NEW.date) THEN RAISE EXCEPTION 'Cash review date is closed' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.cash_components IS NULL THEN RETURN NEW; END IF;
  FOR c IN SELECT * FROM jsonb_array_elements(NEW.cash_components) LOOP
    IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = (c->>'accountId')::uuid AND company_id = NEW.company_id AND currency = NEW.currency AND type::text = c->>'kind' AND type IN ('income','expense')) THEN
      RAISE EXCEPTION 'Invalid cash component account' USING ERRCODE = 'check_violation';
    END IF;
    IF c->>'amount' IS NULL OR length(c->>'amount') > 32 OR (c->>'amount')::numeric <> round((c->>'amount')::numeric, 2) THEN
      RAISE EXCEPTION 'Invalid cash component amount' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_import_cash_validate BEFORE INSERT OR UPDATE ON journal_entries FOR EACH ROW EXECUTE FUNCTION app.validate_import_cash_components();
-- Keep legacy patterns for inspection, but never run them.
ALTER TABLE categorization_rules DISABLE ROW LEVEL SECURITY;
UPDATE categorization_rules SET is_active = false WHERE match_type = 'regex';
ALTER TABLE categorization_rules ENABLE ROW LEVEL SECURITY;
SELECT app.grant_app_privileges();
