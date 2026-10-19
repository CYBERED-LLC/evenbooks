-- 0006_banking
-- Bank connections, bank accounts, imports, bank transactions (review inbox),
-- matches, categorization rules, reconciliation.

CREATE TABLE bank_connections (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES companies(id),
  provider               text NOT NULL CHECK (provider IN ('simplefin')),
  name                   text NOT NULL,
  -- AES-256-GCM ciphertext (see @beans/integrations crypto); never logged
  access_url_ciphertext  text NOT NULL,
  key_version            integer NOT NULL DEFAULT 1,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'revoked', 'disabled')),
  sync_interval_minutes  integer NOT NULL DEFAULT 360 CHECK (sync_interval_minutes >= 60),
  next_sync_at           timestamptz,
  last_sync_started_at   timestamptz,
  last_success_at        timestamptz,
  last_error             text,
  last_error_at          timestamptz,
  consecutive_failures   integer NOT NULL DEFAULT 0,
  created_by             text NOT NULL,
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);
CREATE INDEX bank_connections_due_idx ON bank_connections (next_sync_at) WHERE status = 'active';
CREATE TRIGGER bank_connections_touch BEFORE UPDATE ON bank_connections FOR EACH ROW EXECUTE FUNCTION app.touch_row();
SELECT app.enable_tenant_rls_with_system_read('bank_connections');

CREATE TABLE bank_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id),
  ledger_account_id     uuid NOT NULL,
  name                  text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('bank', 'credit_card')),
  connection_id         uuid,
  provider_account_id   text,
  provider_org_name     text,
  currency              text NOT NULL REFERENCES currencies(code),
  last_balance          numeric(20, 6),
  last_balance_at       timestamptz,
  last_synced_at        timestamptz,
  is_active             boolean NOT NULL DEFAULT true,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, ledger_account_id),
  FOREIGN KEY (company_id, ledger_account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, connection_id) REFERENCES bank_connections(company_id, id),
  CHECK ((connection_id IS NULL) = (provider_account_id IS NULL))
);
CREATE UNIQUE INDEX bank_accounts_provider_uq ON bank_accounts (company_id, connection_id, provider_account_id)
  WHERE connection_id IS NOT NULL;
CREATE TRIGGER bank_accounts_touch BEFORE UPDATE ON bank_accounts FOR EACH ROW EXECUTE FUNCTION app.touch_row();
SELECT app.enable_tenant_rls_with_system_read('bank_accounts');

CREATE TABLE import_batches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id),
  bank_account_id     uuid NOT NULL,
  source              text NOT NULL CHECK (source IN ('csv', 'simplefin')),
  file_attachment_id  uuid,
  file_name           text,
  file_sha256         text,
  mapping             jsonb,
  status              text NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'committed', 'discarded', 'failed')),
  row_count           integer NOT NULL DEFAULT 0,
  imported_count      integer NOT NULL DEFAULT 0,
  duplicate_count     integer NOT NULL DEFAULT 0,
  error_count         integer NOT NULL DEFAULT 0,
  window_start        date,
  window_end          date,
  error               text,
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  committed_at        timestamptz,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, bank_account_id) REFERENCES bank_accounts(company_id, id),
  FOREIGN KEY (company_id, file_attachment_id) REFERENCES attachments(company_id, id)
);
-- A given file can only be committed once per bank account (replay prevention).
CREATE UNIQUE INDEX import_batches_file_uq ON import_batches (company_id, bank_account_id, file_sha256)
  WHERE source = 'csv' AND status = 'committed';
CREATE INDEX import_batches_account_idx ON import_batches (company_id, bank_account_id, created_at DESC);
SELECT app.enable_tenant_rls_with_system_read('import_batches');

CREATE TABLE bank_transactions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  bank_account_id      uuid NOT NULL,
  source               text NOT NULL CHECK (source IN ('csv', 'simplefin', 'manual')),
  import_batch_id      uuid,
  provider_txn_id      text,
  fingerprint          text,
  date                 date NOT NULL,
  -- signed: positive = money into the account
  amount               numeric(20, 6) NOT NULL,
  currency             text NOT NULL REFERENCES currencies(code),
  description          text NOT NULL,
  payee                text,
  memo                 text,
  reference            text,
  pending              boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'unreviewed'
                       CHECK (status IN ('unreviewed', 'categorized', 'matched', 'transfer', 'excluded')),
  excluded_reason      text,
  journal_entry_id     uuid,
  raw                  jsonb,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  -- set when the provider changed amount/date/description after we saw it
  changed_at           timestamptz,
  change_note          text,
  reviewed_by          text,
  reviewed_at          timestamptz,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, bank_account_id) REFERENCES bank_accounts(company_id, id),
  FOREIGN KEY (company_id, import_batch_id) REFERENCES import_batches(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id),
  CHECK ((status = 'excluded') = (excluded_reason IS NOT NULL)),
  CHECK (provider_txn_id IS NOT NULL OR fingerprint IS NOT NULL)
);
CREATE UNIQUE INDEX bank_transactions_provider_uq ON bank_transactions (company_id, bank_account_id, provider_txn_id)
  WHERE provider_txn_id IS NOT NULL;
CREATE UNIQUE INDEX bank_transactions_fingerprint_uq ON bank_transactions (company_id, bank_account_id, fingerprint)
  WHERE fingerprint IS NOT NULL;
CREATE INDEX bank_transactions_inbox_idx ON bank_transactions (company_id, status, date DESC);
CREATE INDEX bank_transactions_account_date_idx ON bank_transactions (company_id, bank_account_id, date DESC);
CREATE TRIGGER bank_transactions_touch BEFORE UPDATE ON bank_transactions FOR EACH ROW EXECUTE FUNCTION app.touch_row();
SELECT app.enable_tenant_rls_with_system_read('bank_transactions');

ALTER TABLE payments ADD FOREIGN KEY (company_id, bank_transaction_id) REFERENCES bank_transactions(company_id, id);
ALTER TABLE refunds ADD FOREIGN KEY (company_id, bank_transaction_id) REFERENCES bank_transactions(company_id, id);
ALTER TABLE purchases ADD FOREIGN KEY (company_id, bank_transaction_id) REFERENCES bank_transactions(company_id, id);

-- Bank transaction <-> ledger evidence links. A combined deposit may match
-- several payments; a transfer matches the counterpart bank transaction.
CREATE TABLE transaction_matches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id),
  bank_transaction_id   uuid NOT NULL,
  target_type           text NOT NULL CHECK (target_type IN ('journal_entry', 'payment', 'purchase', 'refund', 'bank_transaction')),
  target_id             uuid NOT NULL,
  amount                numeric(20, 6) NOT NULL,
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, bank_transaction_id, target_type, target_id),
  FOREIGN KEY (company_id, bank_transaction_id) REFERENCES bank_transactions(company_id, id) ON DELETE CASCADE
);
CREATE INDEX transaction_matches_target_idx ON transaction_matches (company_id, target_type, target_id);
SELECT app.enable_tenant_rls('transaction_matches');

CREATE TABLE categorization_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  name             text NOT NULL,
  priority         integer NOT NULL DEFAULT 100,
  bank_account_id  uuid,
  direction        text NOT NULL DEFAULT 'any' CHECK (direction IN ('any', 'in', 'out')),
  match_field      text NOT NULL DEFAULT 'description' CHECK (match_field IN ('description', 'payee', 'any')),
  match_type       text NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains', 'starts_with', 'equals', 'regex')),
  pattern          text NOT NULL CHECK (pattern <> ''),
  amount_min       numeric(20, 6),
  amount_max       numeric(20, 6),
  account_id       uuid NOT NULL,
  contact_id       uuid,
  memo             text,
  is_active        boolean NOT NULL DEFAULT true,
  hit_count        integer NOT NULL DEFAULT 0,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, bank_account_id) REFERENCES bank_accounts(company_id, id),
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id)
);
CREATE INDEX categorization_rules_company_idx ON categorization_rules (company_id, priority) WHERE is_active;
CREATE TRIGGER categorization_rules_touch BEFORE UPDATE ON categorization_rules FOR EACH ROW EXECUTE FUNCTION app.touch_row();
SELECT app.enable_tenant_rls('categorization_rules');

CREATE TABLE reconciliation_sessions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id),
  bank_account_id             uuid NOT NULL,
  statement_start_date        date NOT NULL,
  statement_end_date          date NOT NULL,
  statement_opening_balance   numeric(20, 6) NOT NULL,
  statement_closing_balance   numeric(20, 6) NOT NULL,
  status                      text NOT NULL DEFAULT 'in_progress'
                              CHECK (status IN ('in_progress', 'completed', 'flagged')),
  cleared_balance             numeric(20, 6),
  discrepancy                 numeric(20, 6),
  completed_at                timestamptz,
  completed_by                text,
  flagged_reason              text,
  flagged_at                  timestamptz,
  notes                       text,
  created_by                  text NOT NULL,
  version                     integer NOT NULL DEFAULT 1,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, bank_account_id) REFERENCES bank_accounts(company_id, id),
  CHECK (statement_start_date <= statement_end_date)
);
CREATE INDEX reconciliation_sessions_account_idx ON reconciliation_sessions (company_id, bank_account_id, statement_end_date DESC);
CREATE TRIGGER reconciliation_sessions_touch BEFORE UPDATE ON reconciliation_sessions FOR EACH ROW EXECUTE FUNCTION app.touch_row();
SELECT app.enable_tenant_rls('reconciliation_sessions');

CREATE TABLE reconciliation_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  session_id       uuid NOT NULL,
  journal_line_id  uuid NOT NULL,
  amount           numeric(20, 6) NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (session_id, journal_line_id),
  FOREIGN KEY (company_id, session_id) REFERENCES reconciliation_sessions(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, journal_line_id) REFERENCES journal_lines(company_id, id)
);
CREATE INDEX reconciliation_items_line_idx ON reconciliation_items (company_id, journal_line_id);
SELECT app.enable_tenant_rls('reconciliation_items');

SELECT app.grant_app_privileges();
