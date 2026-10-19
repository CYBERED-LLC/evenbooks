-- 0007_automation
-- Recurring invoices, email delivery, outbox, tax-form mappings.

CREATE TABLE recurring_schedules (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid NOT NULL REFERENCES companies(id),
  contact_id                uuid NOT NULL,
  name                      text NOT NULL,
  status                    text NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'paused', 'cancelled', 'completed')),
  frequency                 text NOT NULL
                            CHECK (frequency IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'semiannually', 'yearly')),
  anchor_date               date NOT NULL,
  end_date                  date,
  terms_days                integer NOT NULL DEFAULT 30 CHECK (terms_days >= 0),
  send_email                boolean NOT NULL DEFAULT false,
  email_to                  text,
  template_version          integer NOT NULL DEFAULT 1,
  template                  jsonb NOT NULL,
  last_issued_index         integer,
  last_issued_at            timestamptz,
  next_occurrence_date      date,
  next_run_at               timestamptz,
  paused_at                 timestamptz,
  -- occurrences skipped when resuming after a long pause (catch-up choice)
  resume_from_index         integer,
  created_from_invoice_id   uuid,
  created_by                text NOT NULL,
  version                   integer NOT NULL DEFAULT 1,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id),
  FOREIGN KEY (company_id, created_from_invoice_id) REFERENCES invoices(company_id, id),
  CHECK (end_date IS NULL OR end_date >= anchor_date)
);
CREATE INDEX recurring_schedules_due_idx ON recurring_schedules (next_run_at) WHERE status = 'active';
CREATE TRIGGER recurring_schedules_touch BEFORE UPDATE ON recurring_schedules FOR EACH ROW EXECUTE FUNCTION app.touch_row();
SELECT app.enable_tenant_rls_with_system_read('recurring_schedules');

ALTER TABLE invoices ADD FOREIGN KEY (company_id, recurring_schedule_id) REFERENCES recurring_schedules(company_id, id);

CREATE TABLE recurring_template_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  schedule_id  uuid NOT NULL,
  version      integer NOT NULL,
  template     jsonb NOT NULL,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, schedule_id, version),
  FOREIGN KEY (company_id, schedule_id) REFERENCES recurring_schedules(company_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls_with_system_read('recurring_template_versions');

-- ---------------------------------------------------------------------------
-- Email delivery (separate from invoice status)
-- ---------------------------------------------------------------------------
CREATE TABLE email_messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id),
  kind                  text NOT NULL CHECK (kind IN ('invoice')),
  invoice_id            uuid,
  to_email              text NOT NULL,
  reply_to              text,
  subject               text NOT NULL,
  status                text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'uncertain', 'suppressed')),
  provider              text NOT NULL DEFAULT 'ses',
  provider_message_id   text,
  attempts              integer NOT NULL DEFAULT 0,
  last_error            text,
  is_resend             boolean NOT NULL DEFAULT false,
  requested_by          text NOT NULL,
  pdf_attachment_id     uuid,
  dedupe_key            text,
  queued_at             timestamptz NOT NULL DEFAULT now(),
  sent_at               timestamptz,
  delivered_at          timestamptz,
  failed_at             timestamptz,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, dedupe_key),
  FOREIGN KEY (company_id, invoice_id) REFERENCES invoices(company_id, id),
  FOREIGN KEY (company_id, pdf_attachment_id) REFERENCES attachments(company_id, id)
);
CREATE UNIQUE INDEX email_messages_provider_uq ON email_messages (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX email_messages_invoice_idx ON email_messages (company_id, invoice_id, created_at DESC);
CREATE TRIGGER email_messages_touch BEFORE UPDATE ON email_messages FOR EACH ROW EXECUTE FUNCTION app.touch_row();
SELECT app.enable_tenant_rls_with_system_read('email_messages');

-- Provider events are ingested in system context (message id -> company).
CREATE TABLE email_events (
  id                 bigserial PRIMARY KEY,
  company_id         uuid REFERENCES companies(id),
  email_message_id   uuid,
  provider           text NOT NULL,
  provider_message_id text,
  event_type         text NOT NULL,
  payload            jsonb NOT NULL,
  occurred_at        timestamptz,
  received_at        timestamptz NOT NULL DEFAULT now(),
  provider_event_id  text
);
CREATE UNIQUE INDEX email_events_provider_event_uq ON email_events (provider, provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX email_events_message_idx ON email_events (email_message_id);
ALTER TABLE email_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_events FORCE ROW LEVEL SECURITY;
CREATE POLICY email_events_tenant ON email_events AS PERMISSIVE FOR SELECT
  USING (company_id = app.current_company_id() OR app.is_system());
CREATE POLICY email_events_system_write ON email_events AS PERMISSIVE FOR INSERT WITH CHECK (app.is_system());

CREATE TABLE email_suppressions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  email       text NOT NULL,
  reason      text NOT NULL,
  source      text NOT NULL DEFAULT 'provider',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX email_suppressions_email_uq ON email_suppressions (company_id, lower(email));
ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_suppressions FORCE ROW LEVEL SECURITY;
CREATE POLICY email_suppressions_tenant ON email_suppressions AS PERMISSIVE FOR ALL
  USING (company_id = app.current_company_id() OR app.is_system())
  WITH CHECK (company_id = app.current_company_id() OR app.is_system());

-- ---------------------------------------------------------------------------
-- Outbox: written in the same transaction as the financial change, drained by
-- the worker dispatcher (system context). Dispatch is at-least-once; jobs carry
-- dedupe keys.
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_events (
  id             bigserial PRIMARY KEY,
  company_id     uuid NOT NULL REFERENCES companies(id),
  event_type     text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key     text NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  dispatched_at  timestamptz,
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text
);
CREATE INDEX outbox_events_pending_idx ON outbox_events (id) WHERE dispatched_at IS NULL;
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_tenant_insert ON outbox_events AS PERMISSIVE FOR INSERT
  WITH CHECK (company_id = app.current_company_id() OR app.is_system());
CREATE POLICY outbox_tenant_select ON outbox_events AS PERMISSIVE FOR SELECT
  USING (company_id = app.current_company_id() OR app.is_system());
CREATE POLICY outbox_system_update ON outbox_events AS PERMISSIVE FOR UPDATE
  USING (app.is_system()) WITH CHECK (app.is_system());

-- ---------------------------------------------------------------------------
-- Schedule-C-style mappings, per company and tax year
-- ---------------------------------------------------------------------------
CREATE TABLE tax_form_mappings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  form        text NOT NULL DEFAULT 'schedule_c',
  tax_year    integer NOT NULL CHECK (tax_year BETWEEN 2000 AND 2100),
  account_id  uuid NOT NULL,
  line_code   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, form, tax_year, account_id),
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id)
);
SELECT app.enable_tenant_rls('tax_form_mappings');

SELECT app.grant_app_privileges();
