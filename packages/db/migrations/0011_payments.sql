-- 0011_payments
-- Online payments through a payment processor (Stripe Connect, Standard
-- accounts, direct charges). Design: docs/payments-plan.md.
--
-- Enum values added here cannot be referenced by rows inserted in this same
-- transaction (PostgreSQL rule), so the processor clearing and fee accounts are
-- created by the application when a company connects a processor.

ALTER TYPE account_role ADD VALUE IF NOT EXISTS 'processor_clearing';
ALTER TYPE account_role ADD VALUE IF NOT EXISTS 'processor_fees';
ALTER TYPE journal_source ADD VALUE IF NOT EXISTS 'processor_fee';
ALTER TYPE journal_source ADD VALUE IF NOT EXISTS 'processor_payout';

-- The role/type guard must learn the new roles (asset clearing account, expense fee account).
CREATE OR REPLACE FUNCTION app.accounts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected account_type;
BEGIN
  IF NEW.role IS NOT NULL THEN
    expected := CASE NEW.role::text
      WHEN 'accounts_receivable' THEN 'asset'::account_type
      WHEN 'undeposited_funds' THEN 'asset'
      WHEN 'bank' THEN 'asset'
      WHEN 'processor_clearing' THEN 'asset'
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
      WHEN 'processor_fees' THEN 'expense'
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

-- Plan drives the platform application fee until Stripe Billing exists.
ALTER TABLE companies ADD COLUMN plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'paid'));

-- Per-invoice switch to hide the online pay button.
ALTER TABLE invoices ADD COLUMN online_payments_disabled boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Connections (one live connection per company)
-- ---------------------------------------------------------------------------
CREATE TABLE payment_processor_connections (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES companies(id),
  provider                 text NOT NULL CHECK (provider IN ('stripe')),
  provider_account_id      text NOT NULL,
  status                   text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'active', 'restricted', 'disconnected')),
  charges_enabled          boolean NOT NULL DEFAULT false,
  payouts_enabled          boolean NOT NULL DEFAULT false,
  details_submitted        boolean NOT NULL DEFAULT false,
  display_name             text,
  clearing_account_id      uuid NOT NULL,
  fee_account_id           uuid NOT NULL,
  payout_bank_account_id   uuid,
  allow_card               boolean NOT NULL DEFAULT true,
  allow_ach                boolean NOT NULL DEFAULT true,
  allow_partial            boolean NOT NULL DEFAULT true,
  minimum_payment          numeric(20, 6) NOT NULL DEFAULT 1 CHECK (minimum_payment >= 0),
  auto_post_payouts        boolean NOT NULL DEFAULT true,
  last_event_at            timestamptz,
  last_error               text,
  last_error_at            timestamptz,
  disconnected_at          timestamptz,
  created_by               text NOT NULL,
  version                  integer NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (provider, provider_account_id),
  FOREIGN KEY (company_id, clearing_account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, fee_account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, payout_bank_account_id) REFERENCES bank_accounts(company_id, id),
  CHECK (allow_card OR allow_ach)
);
CREATE UNIQUE INDEX payment_processor_connections_live_uq ON payment_processor_connections (company_id, provider)
  WHERE status <> 'disconnected';
CREATE TRIGGER payment_processor_connections_touch BEFORE UPDATE ON payment_processor_connections
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
SELECT app.enable_tenant_rls_with_system_read('payment_processor_connections');

-- ---------------------------------------------------------------------------
-- Raw provider events: stored before anything changes, processed idempotently.
-- Written in system context (the webhook has no session); readable per company.
-- ---------------------------------------------------------------------------
CREATE TABLE processor_events (
  id                   bigserial PRIMARY KEY,
  provider             text NOT NULL,
  provider_event_id    text NOT NULL,
  provider_account_id  text,
  event_type           text NOT NULL,
  payload              jsonb NOT NULL,
  occurred_at          timestamptz,
  received_at          timestamptz NOT NULL DEFAULT now(),
  company_id           uuid REFERENCES companies(id),
  connection_id        uuid,
  processed_at         timestamptz,
  attempts             integer NOT NULL DEFAULT 0,
  last_error           text,
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX processor_events_unprocessed_idx ON processor_events (received_at) WHERE processed_at IS NULL;
CREATE INDEX processor_events_company_idx ON processor_events (company_id, received_at DESC);
ALTER TABLE processor_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE processor_events FORCE ROW LEVEL SECURITY;
CREATE POLICY processor_events_tenant_read ON processor_events AS PERMISSIVE FOR SELECT
  USING (company_id = app.current_company_id() OR app.is_system());
CREATE POLICY processor_events_system_write ON processor_events AS PERMISSIVE FOR INSERT WITH CHECK (app.is_system());
CREATE POLICY processor_events_system_update ON processor_events AS PERMISSIVE FOR UPDATE
  USING (app.is_system()) WITH CHECK (app.is_system());

-- ---------------------------------------------------------------------------
-- Charges: one row per payment intent. `origin = beans` rows are created when
-- a checkout session is opened; `external` rows are created from events for
-- charges made outside Beans on the same connected account.
-- ---------------------------------------------------------------------------
CREATE TABLE processor_charges (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                      uuid NOT NULL REFERENCES companies(id),
  connection_id                   uuid NOT NULL,
  provider                        text NOT NULL,
  provider_payment_intent_id      text,
  provider_checkout_session_id    text,
  provider_charge_id              text,
  provider_balance_transaction_id text,
  invoice_id                      uuid,
  contact_id                      uuid,
  origin                          text NOT NULL CHECK (origin IN ('beans', 'external')),
  method                          text NOT NULL DEFAULT 'unknown' CHECK (method IN ('card', 'ach', 'unknown')),
  status                          text NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'canceled')),
  currency                        text NOT NULL REFERENCES currencies(code),
  amount                          numeric(20, 6) NOT NULL CHECK (amount > 0),
  processor_fee                   numeric(20, 6) NOT NULL DEFAULT 0 CHECK (processor_fee >= 0),
  platform_fee                    numeric(20, 6) NOT NULL DEFAULT 0 CHECK (platform_fee >= 0),
  platform_fee_refunded           numeric(20, 6) NOT NULL DEFAULT 0 CHECK (platform_fee_refunded >= 0),
  amount_refunded                 numeric(20, 6) NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0),
  amount_disputed                 numeric(20, 6) NOT NULL DEFAULT 0 CHECK (amount_disputed >= 0),
  payment_id                      uuid,
  fee_journal_entry_id            uuid,
  payer_email                     text,
  description                     text,
  failure_message                 text,
  succeeded_at                    timestamptz,
  expires_at                      timestamptz,
  created_by                      text NOT NULL,
  version                         integer NOT NULL DEFAULT 1,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, connection_id) REFERENCES payment_processor_connections(company_id, id),
  FOREIGN KEY (company_id, invoice_id) REFERENCES invoices(company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id),
  FOREIGN KEY (company_id, payment_id) REFERENCES payments(company_id, id),
  FOREIGN KEY (company_id, fee_journal_entry_id) REFERENCES journal_entries(company_id, id),
  CHECK (amount_refunded <= amount),
  CHECK (platform_fee_refunded <= platform_fee)
);
CREATE UNIQUE INDEX processor_charges_intent_uq ON processor_charges (provider, provider_payment_intent_id) WHERE provider_payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX processor_charges_session_uq ON processor_charges (provider, provider_checkout_session_id) WHERE provider_checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX processor_charges_payment_uq ON processor_charges (company_id, payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX processor_charges_invoice_idx ON processor_charges (company_id, invoice_id, created_at DESC);
CREATE INDEX processor_charges_open_idx ON processor_charges (company_id, status) WHERE status IN ('pending', 'processing');
CREATE TRIGGER processor_charges_touch BEFORE UPDATE ON processor_charges FOR EACH ROW EXECUTE FUNCTION app.touch_row();
SELECT app.enable_tenant_rls_with_system_read('processor_charges');

-- ---------------------------------------------------------------------------
-- Refunds and disputes (money leaving the processor balance back to the payer)
-- ---------------------------------------------------------------------------
CREATE TABLE processor_refunds (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id),
  charge_id             uuid NOT NULL,
  provider              text NOT NULL,
  provider_refund_id    text,
  provider_dispute_id   text,
  kind                  text NOT NULL CHECK (kind IN ('refund', 'dispute', 'dispute_reversal')),
  origin                text NOT NULL CHECK (origin IN ('beans', 'external')),
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled')),
  amount                numeric(20, 6) NOT NULL CHECK (amount > 0),
  fee_amount            numeric(20, 6) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  platform_fee_refunded numeric(20, 6) NOT NULL DEFAULT 0 CHECK (platform_fee_refunded >= 0),
  reason                text,
  dispute_status        text,
  refund_id             uuid,
  payment_id            uuid,
  fee_journal_entry_id  uuid,
  failure_message       text,
  requested_by          text NOT NULL,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, charge_id) REFERENCES processor_charges(company_id, id),
  FOREIGN KEY (company_id, refund_id) REFERENCES refunds(company_id, id),
  FOREIGN KEY (company_id, payment_id) REFERENCES payments(company_id, id),
  FOREIGN KEY (company_id, fee_journal_entry_id) REFERENCES journal_entries(company_id, id)
);
CREATE UNIQUE INDEX processor_refunds_provider_uq ON processor_refunds (provider, provider_refund_id) WHERE provider_refund_id IS NOT NULL;
CREATE UNIQUE INDEX processor_refunds_dispute_uq ON processor_refunds (provider, provider_dispute_id, kind) WHERE provider_dispute_id IS NOT NULL;
CREATE INDEX processor_refunds_charge_idx ON processor_refunds (company_id, charge_id, created_at DESC);
CREATE TRIGGER processor_refunds_touch BEFORE UPDATE ON processor_refunds FOR EACH ROW EXECUTE FUNCTION app.touch_row();
SELECT app.enable_tenant_rls_with_system_read('processor_refunds');

-- ---------------------------------------------------------------------------
-- Payouts (processor balance -> company bank account)
-- ---------------------------------------------------------------------------
CREATE TABLE processor_payouts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  connection_id        uuid NOT NULL,
  provider             text NOT NULL,
  provider_payout_id   text NOT NULL,
  status               text NOT NULL CHECK (status IN ('pending', 'in_transit', 'paid', 'failed', 'canceled')),
  currency             text NOT NULL REFERENCES currencies(code),
  amount               numeric(20, 6) NOT NULL CHECK (amount <> 0),
  arrival_date         date NOT NULL,
  description          text,
  bank_account_id      uuid,
  journal_entry_id     uuid,
  reversal_entry_id    uuid,
  failure_message      text,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (provider, provider_payout_id),
  FOREIGN KEY (company_id, connection_id) REFERENCES payment_processor_connections(company_id, id),
  FOREIGN KEY (company_id, bank_account_id) REFERENCES bank_accounts(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id),
  FOREIGN KEY (company_id, reversal_entry_id) REFERENCES journal_entries(company_id, id)
);
CREATE INDEX processor_payouts_company_idx ON processor_payouts (company_id, arrival_date DESC);
CREATE TRIGGER processor_payouts_touch BEFORE UPDATE ON processor_payouts FOR EACH ROW EXECUTE FUNCTION app.touch_row();
SELECT app.enable_tenant_rls_with_system_read('processor_payouts');

-- Bank lines may be matched to posted payouts.
ALTER TABLE transaction_matches DROP CONSTRAINT IF EXISTS transaction_matches_target_type_check;
ALTER TABLE transaction_matches ADD CONSTRAINT transaction_matches_target_type_check
  CHECK (target_type IN ('payment', 'purchase', 'refund', 'journal_entry', 'bank_transaction', 'processor_payout'));

SELECT app.grant_app_privileges();
