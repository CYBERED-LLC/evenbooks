-- 0004_sales
-- Invoices, credit notes, payments, allocations, refunds and the cash
-- recognition layer that feeds every cash-basis report.

CREATE TYPE document_status AS ENUM ('draft', 'issued', 'paid', 'void');

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------
CREATE TABLE invoices (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id),
  contact_id                  uuid NOT NULL,
  number                      text,
  status                      document_status NOT NULL DEFAULT 'draft',
  currency                    text NOT NULL REFERENCES currencies(code),
  issue_date                  date NOT NULL,
  due_date                    date NOT NULL,
  terms_days                  integer NOT NULL DEFAULT 30 CHECK (terms_days >= 0),
  customer_snapshot           jsonb NOT NULL DEFAULT '{}'::jsonb,
  memo                        text,
  footer                      text,
  payment_url                 text,
  document_discount           jsonb,
  subtotal                    numeric(20, 6) NOT NULL DEFAULT 0,
  discount_total              numeric(20, 6) NOT NULL DEFAULT 0,
  net_total                   numeric(20, 6) NOT NULL DEFAULT 0,
  tax_total                   numeric(20, 6) NOT NULL DEFAULT 0,
  total                       numeric(20, 6) NOT NULL DEFAULT 0,
  tax_summary                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount_settled              numeric(20, 6) NOT NULL DEFAULT 0 CHECK (amount_settled >= 0),
  balance_due                 numeric(20, 6) NOT NULL DEFAULT 0,
  journal_entry_id            uuid,
  void_journal_entry_id       uuid,
  recurring_schedule_id       uuid,
  recurring_occurrence_index  integer,
  template_version            integer,
  public_token_hash           text,
  public_token_revoked_at     timestamptz,
  current_pdf_attachment_id   uuid,
  issued_at                   timestamptz,
  issued_by                   text,
  voided_at                   timestamptz,
  voided_by                   text,
  void_reason                 text,
  last_sent_at                timestamptz,
  created_by                  text NOT NULL,
  version                     integer NOT NULL DEFAULT 1,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id),
  FOREIGN KEY (company_id, void_journal_entry_id) REFERENCES journal_entries(company_id, id),
  FOREIGN KEY (company_id, current_pdf_attachment_id) REFERENCES attachments(company_id, id),
  CHECK (issue_date <= due_date),
  CHECK ((status = 'draft') = (number IS NULL)),
  CHECK ((status IN ('issued', 'paid', 'void')) = (journal_entry_id IS NOT NULL)),
  CHECK ((status = 'void') = (void_journal_entry_id IS NOT NULL)),
  CHECK (balance_due = total - amount_settled),
  CHECK (status <> 'paid' OR balance_due = 0),
  CHECK (status <> 'issued' OR balance_due > 0),
  CHECK ((recurring_schedule_id IS NULL) = (recurring_occurrence_index IS NULL))
);
CREATE UNIQUE INDEX invoices_number_uq ON invoices (company_id, number) WHERE number IS NOT NULL;
CREATE UNIQUE INDEX invoices_recurring_uq ON invoices (company_id, recurring_schedule_id, recurring_occurrence_index)
  WHERE recurring_schedule_id IS NOT NULL;
CREATE UNIQUE INDEX invoices_public_token_uq ON invoices (public_token_hash) WHERE public_token_hash IS NOT NULL;
CREATE INDEX invoices_company_status_idx ON invoices (company_id, status, due_date);
CREATE INDEX invoices_contact_idx ON invoices (company_id, contact_id);
CREATE TRIGGER invoices_touch BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- Issued invoices are immutable except for settlement/status/pdf/email/token columns.
CREATE OR REPLACE FUNCTION app.invoices_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
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
CREATE TRIGGER invoices_guard BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION app.invoices_guard();
SELECT app.enable_tenant_rls_with_system_read('invoices');

CREATE TABLE invoice_lines (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES companies(id),
  invoice_id               uuid NOT NULL,
  line_no                  integer NOT NULL CHECK (line_no > 0),
  item_id                  uuid,
  description              text NOT NULL,
  quantity                 numeric(20, 6) NOT NULL CHECK (quantity >= 0),
  unit_price               numeric(20, 6) NOT NULL,
  discount                 jsonb,
  income_account_id        uuid NOT NULL,
  tax_rate_ids             uuid[] NOT NULL DEFAULT '{}',
  taxes                    jsonb NOT NULL DEFAULT '[]'::jsonb,
  gross                    numeric(20, 6) NOT NULL DEFAULT 0,
  line_discount            numeric(20, 6) NOT NULL DEFAULT 0,
  document_discount_share  numeric(20, 6) NOT NULL DEFAULT 0,
  net                      numeric(20, 6) NOT NULL DEFAULT 0,
  tax_total                numeric(20, 6) NOT NULL DEFAULT 0,
  total                    numeric(20, 6) NOT NULL DEFAULT 0,
  UNIQUE (company_id, id),
  UNIQUE (invoice_id, line_no),
  FOREIGN KEY (company_id, invoice_id) REFERENCES invoices(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, item_id) REFERENCES items(company_id, id),
  FOREIGN KEY (company_id, income_account_id) REFERENCES accounts(company_id, id)
);
CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (invoice_id);

CREATE OR REPLACE FUNCTION app.invoice_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status document_status;
BEGIN
  SELECT status INTO v_status FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'Lines of issued invoices are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION app.invoice_lines_guard();
SELECT app.enable_tenant_rls_with_system_read('invoice_lines');

-- Historical PDF versions stay tied to the issued document.
CREATE TABLE invoice_pdfs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  invoice_id     uuid NOT NULL,
  attachment_id  uuid NOT NULL,
  version        integer NOT NULL,
  reason         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, invoice_id, version),
  FOREIGN KEY (company_id, invoice_id) REFERENCES invoices(company_id, id),
  FOREIGN KEY (company_id, attachment_id) REFERENCES attachments(company_id, id)
);
SELECT app.enable_tenant_rls_with_system_read('invoice_pdfs');

-- ---------------------------------------------------------------------------
-- Credit notes: customer credits held in the customer-deposits liability.
-- ---------------------------------------------------------------------------
CREATE TABLE credit_notes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES companies(id),
  contact_id             uuid NOT NULL,
  invoice_id             uuid,
  number                 text,
  status                 document_status NOT NULL DEFAULT 'draft',
  currency               text NOT NULL REFERENCES currencies(code),
  issue_date             date NOT NULL,
  reason                 text,
  customer_snapshot      jsonb NOT NULL DEFAULT '{}'::jsonb,
  document_discount      jsonb,
  subtotal               numeric(20, 6) NOT NULL DEFAULT 0,
  discount_total         numeric(20, 6) NOT NULL DEFAULT 0,
  net_total              numeric(20, 6) NOT NULL DEFAULT 0,
  tax_total              numeric(20, 6) NOT NULL DEFAULT 0,
  total                  numeric(20, 6) NOT NULL DEFAULT 0,
  tax_summary            jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount_used            numeric(20, 6) NOT NULL DEFAULT 0 CHECK (amount_used >= 0),
  balance                numeric(20, 6) NOT NULL DEFAULT 0,
  journal_entry_id       uuid,
  void_journal_entry_id  uuid,
  issued_at              timestamptz,
  issued_by              text,
  voided_at              timestamptz,
  void_reason            text,
  created_by             text NOT NULL,
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id),
  FOREIGN KEY (company_id, invoice_id) REFERENCES invoices(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id),
  FOREIGN KEY (company_id, void_journal_entry_id) REFERENCES journal_entries(company_id, id),
  CHECK ((status = 'draft') = (number IS NULL)),
  CHECK ((status IN ('issued', 'paid', 'void')) = (journal_entry_id IS NOT NULL)),
  CHECK ((status = 'void') = (void_journal_entry_id IS NOT NULL)),
  CHECK (balance = total - amount_used),
  CHECK (status <> 'paid' OR balance = 0)
);
CREATE UNIQUE INDEX credit_notes_number_uq ON credit_notes (company_id, number) WHERE number IS NOT NULL;
CREATE INDEX credit_notes_contact_idx ON credit_notes (company_id, contact_id, status);
CREATE TRIGGER credit_notes_touch BEFORE UPDATE ON credit_notes FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE OR REPLACE FUNCTION app.credit_notes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
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
CREATE TRIGGER credit_notes_guard BEFORE UPDATE OR DELETE ON credit_notes FOR EACH ROW EXECUTE FUNCTION app.credit_notes_guard();
SELECT app.enable_tenant_rls('credit_notes');

CREATE TABLE credit_note_lines (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES companies(id),
  credit_note_id           uuid NOT NULL,
  line_no                  integer NOT NULL CHECK (line_no > 0),
  item_id                  uuid,
  description              text NOT NULL,
  quantity                 numeric(20, 6) NOT NULL CHECK (quantity >= 0),
  unit_price               numeric(20, 6) NOT NULL,
  discount                 jsonb,
  income_account_id        uuid NOT NULL,
  tax_rate_ids             uuid[] NOT NULL DEFAULT '{}',
  taxes                    jsonb NOT NULL DEFAULT '[]'::jsonb,
  gross                    numeric(20, 6) NOT NULL DEFAULT 0,
  line_discount            numeric(20, 6) NOT NULL DEFAULT 0,
  document_discount_share  numeric(20, 6) NOT NULL DEFAULT 0,
  net                      numeric(20, 6) NOT NULL DEFAULT 0,
  tax_total                numeric(20, 6) NOT NULL DEFAULT 0,
  total                    numeric(20, 6) NOT NULL DEFAULT 0,
  UNIQUE (company_id, id),
  UNIQUE (credit_note_id, line_no),
  FOREIGN KEY (company_id, credit_note_id) REFERENCES credit_notes(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, item_id) REFERENCES items(company_id, id),
  FOREIGN KEY (company_id, income_account_id) REFERENCES accounts(company_id, id)
);
CREATE OR REPLACE FUNCTION app.credit_note_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status document_status;
BEGIN
  SELECT status INTO v_status FROM credit_notes WHERE id = COALESCE(NEW.credit_note_id, OLD.credit_note_id);
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'Lines of issued credit notes are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER credit_note_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION app.credit_note_lines_guard();
SELECT app.enable_tenant_rls('credit_note_lines');

-- ---------------------------------------------------------------------------
-- Payments received. Posted as Dr deposit account / Cr AR (allocated part)
-- + Cr customer deposits (unapplied part).
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id),
  contact_id            uuid,
  date                  date NOT NULL,
  currency              text NOT NULL REFERENCES currencies(code),
  amount                numeric(20, 6) NOT NULL CHECK (amount > 0),
  method                text NOT NULL DEFAULT 'other',
  reference             text,
  memo                  text,
  deposit_account_id    uuid NOT NULL,
  -- refundable security deposits are liabilities on both bases until applied/forfeited
  is_refundable_deposit boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  amount_allocated      numeric(20, 6) NOT NULL DEFAULT 0 CHECK (amount_allocated >= 0),
  amount_refunded       numeric(20, 6) NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0),
  unapplied_amount      numeric(20, 6) NOT NULL DEFAULT 0,
  journal_entry_id      uuid NOT NULL,
  void_journal_entry_id uuid,
  bank_transaction_id   uuid,
  voided_at             timestamptz,
  void_reason           text,
  created_by            text NOT NULL,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id),
  FOREIGN KEY (company_id, deposit_account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id),
  FOREIGN KEY (company_id, void_journal_entry_id) REFERENCES journal_entries(company_id, id),
  CHECK (unapplied_amount = amount - amount_allocated - amount_refunded),
  CHECK (unapplied_amount >= 0),
  CHECK ((status = 'void') = (void_journal_entry_id IS NOT NULL))
);
CREATE INDEX payments_company_date_idx ON payments (company_id, date);
CREATE INDEX payments_contact_idx ON payments (company_id, contact_id);
CREATE TRIGGER payments_touch BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION app.touch_row();
SELECT app.enable_tenant_rls('payments');

-- Allocation of funds to an invoice. Source is a payment or a credit note.
CREATE TABLE payment_allocations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES companies(id),
  source_type              text NOT NULL CHECK (source_type IN ('payment', 'credit_note')),
  payment_id               uuid,
  credit_note_id           uuid,
  invoice_id               uuid NOT NULL,
  amount                   numeric(20, 6) NOT NULL CHECK (amount > 0),
  date                     date NOT NULL,
  -- null when the allocation was posted inside the payment's own entry
  journal_entry_id         uuid,
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reversed')),
  reversal_journal_entry_id uuid,
  reversed_at              timestamptz,
  created_by               text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, payment_id) REFERENCES payments(company_id, id),
  FOREIGN KEY (company_id, credit_note_id) REFERENCES credit_notes(company_id, id),
  FOREIGN KEY (company_id, invoice_id) REFERENCES invoices(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id),
  FOREIGN KEY (company_id, reversal_journal_entry_id) REFERENCES journal_entries(company_id, id),
  CHECK ((source_type = 'payment') = (payment_id IS NOT NULL)),
  CHECK ((source_type = 'credit_note') = (credit_note_id IS NOT NULL)),
  CHECK ((status = 'reversed') = (reversal_journal_entry_id IS NOT NULL))
);
CREATE INDEX payment_allocations_invoice_idx ON payment_allocations (company_id, invoice_id);
CREATE INDEX payment_allocations_payment_idx ON payment_allocations (company_id, payment_id);
CREATE INDEX payment_allocations_credit_idx ON payment_allocations (company_id, credit_note_id);
SELECT app.enable_tenant_rls('payment_allocations');

-- Refunds paid out from unapplied payment funds or credit note balances.
CREATE TABLE refunds (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id),
  contact_id            uuid,
  source_type           text NOT NULL CHECK (source_type IN ('payment', 'credit_note')),
  payment_id            uuid,
  credit_note_id        uuid,
  date                  date NOT NULL,
  amount                numeric(20, 6) NOT NULL CHECK (amount > 0),
  from_account_id       uuid NOT NULL,
  method                text NOT NULL DEFAULT 'other',
  reference             text,
  memo                  text,
  status                text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  journal_entry_id      uuid NOT NULL,
  void_journal_entry_id uuid,
  bank_transaction_id   uuid,
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id),
  FOREIGN KEY (company_id, payment_id) REFERENCES payments(company_id, id),
  FOREIGN KEY (company_id, credit_note_id) REFERENCES credit_notes(company_id, id),
  FOREIGN KEY (company_id, from_account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id),
  FOREIGN KEY (company_id, void_journal_entry_id) REFERENCES journal_entries(company_id, id),
  CHECK ((source_type = 'payment') = (payment_id IS NOT NULL)),
  CHECK ((source_type = 'credit_note') = (credit_note_id IS NOT NULL)),
  CHECK ((status = 'void') = (void_journal_entry_id IS NOT NULL))
);
CREATE INDEX refunds_company_date_idx ON refunds (company_id, date);
SELECT app.enable_tenant_rls('refunds');

-- ---------------------------------------------------------------------------
-- Cash recognition layer.
-- Every cash-basis P&L amount comes from this table. Rows are produced by the
-- recognition service from: settlements (payments/credits applied to invoices),
-- unapplied advance payments, refunds, and posted journal entries with
-- cash_treatment = 'include'. Rows are append-only; corrections are new rows
-- with opposite sign. The table can be rebuilt from source events.
-- ---------------------------------------------------------------------------
CREATE TABLE cash_recognitions (
  id                bigserial PRIMARY KEY,
  company_id        uuid NOT NULL REFERENCES companies(id),
  date              date NOT NULL,
  account_id        uuid NOT NULL,
  -- signed amount in the account's natural direction: positive income for
  -- income accounts, positive expense for expense accounts.
  amount            numeric(20, 6) NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('income', 'tax', 'expense', 'advance', 'other')),
  event_type        text NOT NULL,
  event_id          uuid NOT NULL,
  document_type     text,
  document_id       uuid,
  line_id           uuid,
  tax_rate_id       uuid,
  contact_id        uuid,
  journal_entry_id  uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id)
);
CREATE INDEX cash_recognitions_company_date_idx ON cash_recognitions (company_id, date, account_id);
CREATE INDEX cash_recognitions_event_idx ON cash_recognitions (company_id, event_type, event_id);
CREATE INDEX cash_recognitions_document_idx ON cash_recognitions (company_id, document_type, document_id);
CREATE TRIGGER cash_recognitions_append_only BEFORE UPDATE ON cash_recognitions
  FOR EACH ROW EXECUTE FUNCTION app.forbid_change();
SELECT app.enable_tenant_rls('cash_recognitions');

-- Company-scoped document numbering.
CREATE OR REPLACE FUNCTION app.next_document_number(p_company uuid, p_kind text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE n integer; prefix text;
BEGIN
  IF p_kind = 'invoice' THEN
    UPDATE companies SET next_invoice_number = next_invoice_number + 1
      WHERE id = p_company RETURNING next_invoice_number - 1, invoice_prefix INTO n, prefix;
  ELSIF p_kind = 'credit_note' THEN
    UPDATE companies SET next_credit_note_number = next_credit_note_number + 1
      WHERE id = p_company RETURNING next_credit_note_number - 1, credit_note_prefix INTO n, prefix;
  ELSE
    RAISE EXCEPTION 'Unknown document kind %', p_kind;
  END IF;
  IF n IS NULL THEN
    RAISE EXCEPTION 'Company % not found', p_company;
  END IF;
  RETURN prefix || lpad(n::text, 4, '0');
END
$$;

SELECT app.grant_app_privileges();
