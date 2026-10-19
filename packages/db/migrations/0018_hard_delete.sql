-- 0018_hard_delete
-- Permanent deletion of posted records. Guards stay closed unless the deletion
-- service sets app.hard_delete for its transaction AND the company allows it, so
-- the company setting is enforced here as well as in the service.

ALTER TABLE companies ADD COLUMN transaction_deletion_enabled boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION app.hard_delete_allowed(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.hard_delete', true), '') = 'on'
     AND EXISTS (SELECT 1 FROM companies WHERE id = p_company AND transaction_deletion_enabled)
$$;

CREATE OR REPLACE FUNCTION app.journal_entries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' AND NOT app.hard_delete_allowed(OLD.company_id) THEN
      RAISE EXCEPTION 'Posted journal entries cannot be deleted; post a reversal instead'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'posted' THEN
      -- posting is a two-step flow (insert draft with lines, then update to posted)
      RAISE EXCEPTION 'Journal entries must be inserted as drafts and then posted'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.reversed_by_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'reversed_by_entry_id cannot be set on insert' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.status = 'posted' THEN
    IF NEW.status <> 'posted'
       OR NEW.entry_number <> OLD.entry_number
       OR NEW.date <> OLD.date
       OR NEW.memo <> OLD.memo
       OR NEW.source_type <> OLD.source_type
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.currency <> OLD.currency
       OR NEW.cash_treatment <> OLD.cash_treatment
       OR NEW.reverses_entry_id IS DISTINCT FROM OLD.reverses_entry_id
       OR NEW.posted_at <> OLD.posted_at
       OR NEW.posted_by IS DISTINCT FROM OLD.posted_by
       OR NEW.created_by <> OLD.created_by
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.company_id <> OLD.company_id
    THEN
      RAISE EXCEPTION 'Posted journal entries are immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.reversed_by_entry_id IS NOT NULL AND NEW.reversed_by_entry_id IS DISTINCT FROM OLD.reversed_by_entry_id
       AND NOT (NEW.reversed_by_entry_id IS NULL AND app.hard_delete_allowed(OLD.company_id)) THEN
      RAISE EXCEPTION 'An entry can only be reversed once' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
    IF app.is_date_locked(NEW.company_id, NEW.date) THEN
      RAISE EXCEPTION 'Accounting period containing % is closed', NEW.date USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.reverses_entry_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM journal_entries e WHERE e.id = NEW.reverses_entry_id AND e.company_id = NEW.company_id AND e.status = 'posted'
    ) THEN
      RAISE EXCEPTION 'Only posted entries can be reversed' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.journal_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry_id uuid := COALESCE(NEW.entry_id, OLD.entry_id);
  v_status journal_status;
  v_entry_company uuid;
  v_minor smallint;
  v_amount numeric;
BEGIN
  SELECT e.status, e.company_id INTO v_status, v_entry_company FROM journal_entries e WHERE e.id = v_entry_id;
  IF v_status = 'posted' AND NOT (TG_OP = 'DELETE' AND app.hard_delete_allowed(OLD.company_id)) THEN
    RAISE EXCEPTION 'Lines of posted journal entries are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NEW.company_id <> v_entry_company THEN
      RAISE EXCEPTION 'Line company must match entry company' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- amounts must be at the account currency's precision
    SELECT c.minor_units INTO v_minor FROM accounts a JOIN currencies c ON c.code = a.currency WHERE a.id = NEW.account_id;
    v_amount := GREATEST(NEW.debit, NEW.credit);
    IF v_amount <> round(v_amount, v_minor) THEN
      RAISE EXCEPTION 'Amount % exceeds currency precision (% decimals)', v_amount, v_minor USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END
$$;

CREATE OR REPLACE FUNCTION app.invoices_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND NOT app.hard_delete_allowed(OLD.company_id) THEN
      RAISE EXCEPTION 'Issued invoices cannot be deleted; void them instead' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' THEN
    IF NEW.contact_id <> OLD.contact_id OR NEW.number <> OLD.number OR NEW.currency <> OLD.currency
       OR NEW.issue_date <> OLD.issue_date OR NEW.due_date <> OLD.due_date
       OR NEW.customer_snapshot <> OLD.customer_snapshot OR NEW.memo IS DISTINCT FROM OLD.memo
       OR NEW.footer IS DISTINCT FROM OLD.footer OR NEW.document_discount IS DISTINCT FROM OLD.document_discount
       OR NEW.subtotal <> OLD.subtotal OR NEW.discount_total <> OLD.discount_total OR NEW.net_total <> OLD.net_total
       OR NEW.tax_total <> OLD.tax_total OR NEW.total <> OLD.total OR NEW.tax_summary <> OLD.tax_summary
       OR NEW.journal_entry_id <> OLD.journal_entry_id OR NEW.issued_at <> OLD.issued_at
       OR NEW.recurring_schedule_id IS DISTINCT FROM OLD.recurring_schedule_id
       OR NEW.recurring_occurrence_index IS DISTINCT FROM OLD.recurring_occurrence_index
       OR NEW.created_by <> OLD.created_by OR NEW.company_id <> OLD.company_id
    THEN
      RAISE EXCEPTION 'Issued invoices are immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status = 'void' AND NEW.status <> 'void' THEN
      RAISE EXCEPTION 'Void invoices cannot be reopened' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW.payment_url IS NOT NULL AND NEW.payment_url !~ '^https://' THEN
    RAISE EXCEPTION 'payment_url must be an https URL' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.invoice_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status document_status;
BEGIN
  SELECT status INTO v_status FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF v_status IS NOT NULL AND v_status <> 'draft' AND NOT (TG_OP = 'DELETE' AND app.hard_delete_allowed(OLD.company_id)) THEN
    RAISE EXCEPTION 'Lines of issued invoices are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.credit_notes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND NOT app.hard_delete_allowed(OLD.company_id) THEN
      RAISE EXCEPTION 'Issued credit notes cannot be deleted; void them instead' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' THEN
    IF NEW.contact_id <> OLD.contact_id OR NEW.number <> OLD.number OR NEW.issue_date <> OLD.issue_date
       OR NEW.total <> OLD.total OR NEW.net_total <> OLD.net_total OR NEW.tax_total <> OLD.tax_total
       OR NEW.subtotal <> OLD.subtotal OR NEW.discount_total <> OLD.discount_total
       OR NEW.tax_summary <> OLD.tax_summary OR NEW.customer_snapshot <> OLD.customer_snapshot
       OR NEW.journal_entry_id <> OLD.journal_entry_id OR NEW.company_id <> OLD.company_id
    THEN
      RAISE EXCEPTION 'Issued credit notes are immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.credit_note_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status document_status;
BEGIN
  SELECT status INTO v_status FROM credit_notes WHERE id = COALESCE(NEW.credit_note_id, OLD.credit_note_id);
  IF v_status IS NOT NULL AND v_status <> 'draft' AND NOT (TG_OP = 'DELETE' AND app.hard_delete_allowed(OLD.company_id)) THEN
    RAISE EXCEPTION 'Lines of issued credit notes are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

-- Deleted bank lines stay deleted: CSV import and bank sync skip these keys.
CREATE TABLE deleted_bank_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  bank_account_id  uuid NOT NULL,
  provider_txn_id  text,
  fingerprint      text,
  date             date NOT NULL,
  amount           numeric(20, 6) NOT NULL,
  description      text NOT NULL,
  deleted_by       text NOT NULL,
  deleted_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, bank_account_id) REFERENCES bank_accounts(company_id, id),
  CHECK (provider_txn_id IS NOT NULL OR fingerprint IS NOT NULL)
);
CREATE UNIQUE INDEX deleted_bank_transactions_provider_uq ON deleted_bank_transactions (company_id, bank_account_id, provider_txn_id)
  WHERE provider_txn_id IS NOT NULL;
CREATE UNIQUE INDEX deleted_bank_transactions_fingerprint_uq ON deleted_bank_transactions (company_id, bank_account_id, fingerprint)
  WHERE fingerprint IS NOT NULL;
SELECT app.enable_tenant_rls_with_system_read('deleted_bank_transactions');

SELECT app.grant_app_privileges();
