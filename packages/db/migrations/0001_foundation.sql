-- 0001_foundation
-- Extensions, helper schema, tenancy functions, reference data, companies.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA IF NOT EXISTS app;

-- ---------------------------------------------------------------------------
-- Tenancy context
-- ---------------------------------------------------------------------------
-- The application sets `app.company_id` per transaction with
--   select set_config('app.company_id', '<uuid>', true);
-- Worker/system code paths (outbox dispatch, company resolution) additionally set
--   select set_config('app.system', 'on', true);
-- Row-level policies below use these functions.

CREATE OR REPLACE FUNCTION app.current_company_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.company_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.is_system() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.system', true), '') = 'on'
$$;

-- Grants the application role access to everything in public. Called at the end
-- of every migration so new objects are covered. The role is created by the
-- bootstrap script (roles are cluster-wide and not part of migrations).
CREATE OR REPLACE FUNCTION app.grant_app_privileges() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beans_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public, app TO beans_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO beans_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO beans_app';
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO beans_app';
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO beans_app';
  END IF;
END
$$;

-- Standard tenant policy + RLS setup for a table with a company_id column.
CREATE OR REPLACE FUNCTION app.enable_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s AS PERMISSIVE FOR ALL
       USING (company_id = app.current_company_id())
       WITH CHECK (company_id = app.current_company_id())', tbl);
END
$$;

-- Same, but system context may also read (not write) all rows. Used for tables
-- the worker must scan across companies (outbox, schedules, connections).
CREATE OR REPLACE FUNCTION app.enable_tenant_rls_with_system_read(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.enable_tenant_rls(tbl);
  EXECUTE format('DROP POLICY IF EXISTS system_read ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY system_read ON %s AS PERMISSIVE FOR SELECT USING (app.is_system())', tbl);
END
$$;

-- updated_at / version bump helper
CREATE OR REPLACE FUNCTION app.touch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' AND NEW.version IS NOT DISTINCT FROM OLD.version THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only (% on %)', TG_TABLE_NAME, TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------
CREATE TABLE currencies (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  minor_units smallint NOT NULL CHECK (minor_units BETWEEN 0 AND 6),
  symbol      text NOT NULL,
  name        text NOT NULL
);
INSERT INTO currencies (code, minor_units, symbol, name) VALUES ('USD', 2, '$', 'US Dollar');

CREATE TYPE account_type AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');

CREATE TYPE account_role AS ENUM (
  'accounts_receivable', 'customer_deposits', 'sales_tax_payable', 'undeposited_funds',
  'bank', 'credit_card', 'opening_balance_equity', 'owner_equity', 'owner_draws',
  'retained_earnings', 'sales_discounts', 'bad_debt', 'bank_fees', 'uncategorized_income',
  'uncategorized_expense', 'rounding', 'advance_payments'
);

-- ---------------------------------------------------------------------------
-- Companies (one per Clerk organization)
-- ---------------------------------------------------------------------------
CREATE TABLE companies (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_org_id            text NOT NULL UNIQUE,
  name                    text NOT NULL,
  legal_name              text,
  email                   text,
  phone                   text,
  address                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  base_currency           text NOT NULL REFERENCES currencies(code) DEFAULT 'USD',
  time_zone               text NOT NULL DEFAULT 'America/New_York',
  fiscal_year_start_month smallint NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  invoice_prefix          text NOT NULL DEFAULT 'INV-',
  next_invoice_number     integer NOT NULL DEFAULT 1 CHECK (next_invoice_number > 0),
  credit_note_prefix      text NOT NULL DEFAULT 'CN-',
  next_credit_note_number integer NOT NULL DEFAULT 1 CHECK (next_credit_note_number > 0),
  next_journal_number     bigint NOT NULL DEFAULT 1 CHECK (next_journal_number > 0),
  default_terms_days      integer NOT NULL DEFAULT 30 CHECK (default_terms_days >= 0),
  invoice_footer          text,
  settings                jsonb NOT NULL DEFAULT '{}'::jsonb,
  has_posted_entries      boolean NOT NULL DEFAULT false,
  version                 integer NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER companies_touch BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- Changing base currency after posting is not allowed in MVP.
CREATE OR REPLACE FUNCTION app.companies_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.base_currency <> OLD.base_currency AND OLD.has_posted_entries THEN
    RAISE EXCEPTION 'Cannot change base currency after entries have been posted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.clerk_org_id <> OLD.clerk_org_id THEN
    RAISE EXCEPTION 'clerk_org_id is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER companies_guard BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION app.companies_guard();

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
CREATE POLICY company_self ON companies AS PERMISSIVE FOR ALL
  USING (id = app.current_company_id()) WITH CHECK (id = app.current_company_id());
-- System context (company resolution / provisioning / scheduling) may read and insert.
CREATE POLICY company_system_read ON companies AS PERMISSIVE FOR SELECT USING (app.is_system());
CREATE POLICY company_system_insert ON companies AS PERMISSIVE FOR INSERT WITH CHECK (app.is_system());

-- ---------------------------------------------------------------------------
-- Audit trail (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
  id            bigserial PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES companies(id),
  actor_type    text NOT NULL CHECK (actor_type IN ('user', 'system', 'job')),
  actor_id      text NOT NULL,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  reason        text,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id    text,
  job_id        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_company_created_idx ON audit_events (company_id, created_at DESC);
CREATE INDEX audit_events_entity_idx ON audit_events (company_id, entity_type, entity_id);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.forbid_change();
SELECT app.enable_tenant_rls('audit_events');

-- ---------------------------------------------------------------------------
-- Idempotency keys for financial commands
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  company_id    uuid NOT NULL REFERENCES companies(id),
  key           text NOT NULL,
  request_hash  text NOT NULL,
  response      jsonb,
  status        text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key)
);
SELECT app.enable_tenant_rls('idempotency_keys');

SELECT app.grant_app_privileges();
