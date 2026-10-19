-- 0002_ledger
-- Chart of accounts, accounting periods, journal entries/lines with posting invariants.

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  code          text NOT NULL CHECK (code <> ''),
  name          text NOT NULL CHECK (name <> ''),
  type          account_type NOT NULL,
  role          account_role,
  parent_id     uuid,
  description   text,
  currency      text NOT NULL REFERENCES currencies(code),
  is_active     boolean NOT NULL DEFAULT true,
  is_system     boolean NOT NULL DEFAULT false,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (company_id, parent_id) REFERENCES accounts(company_id, id)
);
-- Single-instance roles: at most one active account per company.
CREATE UNIQUE INDEX accounts_single_role_uq ON accounts (company_id, role)
  WHERE role IN ('accounts_receivable', 'customer_deposits', 'sales_tax_payable', 'undeposited_funds',
                 'opening_balance_equity', 'retained_earnings', 'sales_discounts', 'bad_debt', 'bank_fees',
                 'uncategorized_income', 'uncategorized_expense', 'rounding', 'advance_payments')
    AND is_active;
CREATE INDEX accounts_company_type_idx ON accounts (company_id, type, code);
CREATE TRIGGER accounts_touch BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- Role/type consistency, immutability of type once used, no deletion when used (FK RESTRICT below).
CREATE OR REPLACE FUNCTION app.accounts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected account_type;
BEGIN
  IF NEW.role IS NOT NULL THEN
    expected := CASE NEW.role
      WHEN 'accounts_receivable' THEN 'asset'::account_type
      WHEN 'undeposited_funds' THEN 'asset'
      WHEN 'bank' THEN 'asset'
      WHEN 'customer_deposits' THEN 'liability'
      WHEN 'sales_tax_payable' THEN 'liability'
      WHEN 'credit_card' THEN 'liability'
      WHEN 'opening_balance_equity' THEN 'equity'
      WHEN 'owner_equity' THEN 'equity'
      WHEN 'owner_draws' THEN 'equity'
      WHEN 'retained_earnings' THEN 'equity'
      WHEN 'sales_discounts' THEN 'income'
      WHEN 'uncategorized_income' THEN 'income'
      WHEN 'advance_payments' THEN 'income'
      WHEN 'bad_debt' THEN 'expense'
      WHEN 'bank_fees' THEN 'expense'
      WHEN 'uncategorized_expense' THEN 'expense'
      WHEN 'rounding' THEN 'expense'
    END;
    IF expected IS DISTINCT FROM NEW.type THEN
      RAISE EXCEPTION 'Account role % requires type %', NEW.role, expected USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.type <> OLD.type AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.account_id = OLD.id) THEN
      RAISE EXCEPTION 'Cannot change the type of an account that has journal lines' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.currency <> OLD.currency THEN
      RAISE EXCEPTION 'Account currency is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.is_system AND NEW.is_active = false THEN
      RAISE EXCEPTION 'System accounts cannot be archived' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER accounts_guard BEFORE INSERT OR UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION app.accounts_guard();

CREATE OR REPLACE FUNCTION app.accounts_no_delete_when_used() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM journal_lines l WHERE l.account_id = OLD.id) THEN
    RAISE EXCEPTION 'Accounts with journal lines cannot be deleted; archive instead'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF OLD.is_system THEN
    RAISE EXCEPTION 'System accounts cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

SELECT app.enable_tenant_rls('accounts');

-- ---------------------------------------------------------------------------
-- Accounting periods (closed periods block postings)
-- ---------------------------------------------------------------------------
CREATE TABLE accounting_periods (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  status      text NOT NULL DEFAULT 'closed' CHECK (status IN ('open', 'closed')),
  closed_at   timestamptz,
  closed_by   text,
  reopened_at timestamptz,
  reopened_by text,
  reason      text,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  CHECK (start_date <= end_date),
  EXCLUDE USING gist (company_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
);
CREATE TRIGGER accounting_periods_touch BEFORE UPDATE ON accounting_periods FOR EACH ROW EXECUTE FUNCTION app.touch_row();
SELECT app.enable_tenant_rls('accounting_periods');

CREATE OR REPLACE FUNCTION app.is_date_locked(p_company uuid, p_date date) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM accounting_periods p
    WHERE p.company_id = p_company AND p.status = 'closed'
      AND p_date BETWEEN p.start_date AND p.end_date
  )
$$;

-- ---------------------------------------------------------------------------
-- Journal
-- ---------------------------------------------------------------------------
CREATE TYPE journal_status AS ENUM ('draft', 'posted');

CREATE TYPE journal_source AS ENUM (
  'manual', 'opening_balance', 'invoice', 'invoice_void', 'credit_note', 'credit_note_void',
  'payment', 'payment_void', 'allocation', 'allocation_reversal', 'refund', 'refund_void',
  'purchase', 'purchase_void', 'transfer', 'bank_categorization', 'reversal', 'adjustment'
);

CREATE TABLE journal_entries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id),
  entry_number          bigint,
  date                  date NOT NULL,
  memo                  text NOT NULL DEFAULT '',
  status                journal_status NOT NULL DEFAULT 'draft',
  source_type           journal_source NOT NULL,
  source_id             uuid,
  currency              text NOT NULL REFERENCES currencies(code),
  -- Cash-basis treatment. System documents derive recognition from the
  -- settlement layer ('derived'); manual journals must say whether their
  -- income/expense lines count on the cash basis ('include') or not ('exclude').
  cash_treatment        text NOT NULL CHECK (cash_treatment IN ('derived', 'include', 'exclude')),
  reverses_entry_id     uuid,
  reversed_by_entry_id  uuid,
  posted_at             timestamptz,
  posted_by             text,
  created_by            text NOT NULL,
  idempotency_key       text,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, entry_number),
  UNIQUE (company_id, idempotency_key),
  FOREIGN KEY (company_id, reverses_entry_id) REFERENCES journal_entries(company_id, id),
  FOREIGN KEY (company_id, reversed_by_entry_id) REFERENCES journal_entries(company_id, id),
  CHECK ((status = 'posted') = (posted_at IS NOT NULL)),
  CHECK ((status = 'posted') = (entry_number IS NOT NULL)),
  -- Sales documents derive cash recognition from settlements; everything else is
  -- a cash event ('include') or an accrual-only adjustment ('exclude').
  CHECK (
    CASE WHEN source_type IN ('invoice', 'invoice_void', 'credit_note', 'credit_note_void', 'payment', 'payment_void',
                              'allocation', 'allocation_reversal', 'refund', 'refund_void')
         THEN cash_treatment = 'derived'
         ELSE cash_treatment IN ('include', 'exclude') END
  )
);
CREATE INDEX journal_entries_company_date_idx ON journal_entries (company_id, date, entry_number);
CREATE INDEX journal_entries_source_idx ON journal_entries (company_id, source_type, source_id);
CREATE UNIQUE INDEX journal_entries_reverses_uq ON journal_entries (company_id, reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE TRIGGER journal_entries_touch BEFORE UPDATE ON journal_entries FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TABLE journal_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  entry_id    uuid NOT NULL,
  line_no     integer NOT NULL CHECK (line_no > 0),
  account_id  uuid NOT NULL,
  debit       numeric(20, 6) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit      numeric(20, 6) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo        text,
  contact_id  uuid,
  UNIQUE (company_id, id),
  UNIQUE (entry_id, line_no),
  FOREIGN KEY (company_id, entry_id) REFERENCES journal_entries(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id) ON DELETE RESTRICT,
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);
CREATE INDEX journal_lines_account_idx ON journal_lines (company_id, account_id);
CREATE INDEX journal_lines_entry_idx ON journal_lines (entry_id);
CREATE INDEX journal_lines_contact_idx ON journal_lines (company_id, contact_id) WHERE contact_id IS NOT NULL;

CREATE TRIGGER accounts_no_delete BEFORE DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION app.accounts_no_delete_when_used();

-- Immutability of posted entries. Only reversed_by_entry_id (null -> value),
-- updated_at and version may change once an entry is posted.
CREATE OR REPLACE FUNCTION app.journal_entries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN
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
    IF OLD.reversed_by_entry_id IS NOT NULL AND NEW.reversed_by_entry_id IS DISTINCT FROM OLD.reversed_by_entry_id THEN
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
CREATE TRIGGER journal_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.journal_entries_guard();

-- Lines of posted entries are immutable.
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
  IF v_status = 'posted' THEN
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
CREATE TRIGGER journal_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.journal_lines_guard();

-- Deferred validation at commit for posted entries: balanced, >= 2 lines,
-- accounts active and in the same currency, control accounts protected.
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
  -- Manual journals may not touch subledger control accounts.
  IF e.source_type IN ('manual') THEN
    SELECT count(*) INTO v_bad
      FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.entry_id = p_entry AND a.role IN ('accounts_receivable', 'customer_deposits', 'sales_tax_payable');
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'Manual journals cannot post to control accounts (AR, customer deposits, sales tax payable)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION app.journal_entries_validate_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.validate_posted_entry(NEW.id);
  IF NEW.status = 'posted' THEN
    UPDATE companies SET has_posted_entries = true WHERE id = NEW.company_id AND NOT has_posted_entries;
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER journal_entries_validate
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.journal_entries_validate_trigger();

CREATE OR REPLACE FUNCTION app.journal_lines_validate_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.validate_posted_entry(COALESCE(NEW.entry_id, OLD.entry_id));
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER journal_lines_validate
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.journal_lines_validate_trigger();

SELECT app.enable_tenant_rls('journal_entries');
SELECT app.enable_tenant_rls('journal_lines');

-- Company-scoped journal numbering (row lock on companies).
CREATE OR REPLACE FUNCTION app.next_journal_number(p_company uuid) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  UPDATE companies SET next_journal_number = next_journal_number + 1
    WHERE id = p_company RETURNING next_journal_number - 1 INTO n;
  IF n IS NULL THEN
    RAISE EXCEPTION 'Company % not found' , p_company;
  END IF;
  RETURN n;
END
$$;

-- Account balance helper used by reports and tests.
CREATE OR REPLACE VIEW account_balances AS
SELECT a.company_id, a.id AS account_id, a.code, a.name, a.type, a.role,
       COALESCE(sum(l.debit), 0) AS total_debit,
       COALESCE(sum(l.credit), 0) AS total_credit,
       CASE WHEN a.type IN ('asset', 'expense')
            THEN COALESCE(sum(l.debit), 0) - COALESCE(sum(l.credit), 0)
            ELSE COALESCE(sum(l.credit), 0) - COALESCE(sum(l.debit), 0) END AS balance
FROM accounts a
LEFT JOIN (journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted')
  ON l.account_id = a.id
GROUP BY a.company_id, a.id;

SELECT app.grant_app_privileges();
