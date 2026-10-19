-- 0012_ledger_imports
-- Import historical transactions from another accounting system as balanced
-- journal entries (source_type 'import'). A ledger import is previewed from the
-- stored file, then committed in one step; each posted entry carries an
-- idempotency key derived from its content so an overlapping export cannot post
-- the same transaction twice.

ALTER TYPE journal_source ADD VALUE IF NOT EXISTS 'import';

CREATE TABLE ledger_imports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id),
  file_attachment_id  uuid,
  file_name           text NOT NULL,
  file_sha256         text NOT NULL,
  mapping             jsonb,
  account_map         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'committed', 'discarded')),
  row_count           integer NOT NULL DEFAULT 0,
  entry_count         integer NOT NULL DEFAULT 0,
  ready_count         integer NOT NULL DEFAULT 0,
  imported_count      integer NOT NULL DEFAULT 0,
  duplicate_count     integer NOT NULL DEFAULT 0,
  error_count         integer NOT NULL DEFAULT 0,
  window_start        date,
  window_end          date,
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  committed_at        timestamptz,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, file_attachment_id) REFERENCES attachments(company_id, id)
);
CREATE UNIQUE INDEX ledger_imports_file_uq ON ledger_imports (company_id, file_sha256) WHERE status = 'committed';
CREATE INDEX ledger_imports_company_idx ON ledger_imports (company_id, created_at DESC);
SELECT app.enable_tenant_rls('ledger_imports');

-- Imported entries follow the manual-journal rule: subledger control accounts
-- (AR, customer deposits, sales tax payable) are reachable only through documents.
CREATE OR REPLACE FUNCTION app.validate_posted_entry(p_entry uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  e journal_entries%ROWTYPE;
  v_debit numeric;
  v_credit numeric;
  v_count integer;
  v_bad integer;
BEGIN
  SELECT * INTO e FROM journal_entries WHERE id = p_entry;
  IF NOT FOUND OR e.status <> 'posted' THEN
    RETURN;
  END IF;
  SELECT COALESCE(sum(debit), 0), COALESCE(sum(credit), 0), count(*)
    INTO v_debit, v_credit, v_count
    FROM journal_lines WHERE entry_id = p_entry;
  IF v_count < 2 THEN
    RAISE EXCEPTION 'Posted entry % needs at least two lines', p_entry USING ERRCODE = 'check_violation';
  END IF;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'Posted entry % is not balanced (debits % / credits %)', p_entry, v_debit, v_credit
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_bad
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE l.entry_id = p_entry AND (a.currency <> e.currency OR a.company_id <> e.company_id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Posted entry % mixes currencies or companies', p_entry USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_bad
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE l.entry_id = p_entry AND NOT a.is_active;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Posted entry % uses an archived account', p_entry USING ERRCODE = 'check_violation';
  END IF;
  -- Manual and imported journals may not touch subledger control accounts.
  IF e.source_type::text IN ('manual', 'import') THEN
    SELECT count(*) INTO v_bad
      FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.entry_id = p_entry AND a.role IN ('accounts_receivable', 'customer_deposits', 'sales_tax_payable');
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'Manual and imported journals cannot post to control accounts (AR, customer deposits, sales tax payable)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END
$$;

SELECT app.grant_app_privileges();
