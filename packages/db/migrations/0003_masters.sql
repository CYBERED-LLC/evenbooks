-- 0003_masters
-- Contacts, items, tax rates, attachments (private object storage references).

CREATE TABLE contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  name            text NOT NULL CHECK (name <> ''),
  is_customer     boolean NOT NULL DEFAULT true,
  is_vendor       boolean NOT NULL DEFAULT false,
  email           text,
  phone           text,
  billing_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes           text,
  is_archived     boolean NOT NULL DEFAULT false,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  CHECK (is_customer OR is_vendor)
);
CREATE INDEX contacts_company_name_idx ON contacts (company_id, lower(name));
CREATE TRIGGER contacts_touch BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION app.touch_row();
SELECT app.enable_tenant_rls('contacts');

-- journal_lines.contact_id is a reporting dimension
ALTER TABLE journal_lines ADD FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id);

CREATE TABLE tax_rates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id),
  name                  text NOT NULL CHECK (name <> ''),
  rate                  numeric(9, 6) NOT NULL CHECK (rate >= 0 AND rate < 1),
  agency                text,
  liability_account_id  uuid NOT NULL,
  is_active             boolean NOT NULL DEFAULT true,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, name),
  FOREIGN KEY (company_id, liability_account_id) REFERENCES accounts(company_id, id)
);
CREATE TRIGGER tax_rates_touch BEFORE UPDATE ON tax_rates FOR EACH ROW EXECUTE FUNCTION app.touch_row();
SELECT app.enable_tenant_rls('tax_rates');

CREATE TABLE items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id),
  name               text NOT NULL CHECK (name <> ''),
  description        text,
  kind               text NOT NULL DEFAULT 'service' CHECK (kind IN ('service', 'product')),
  unit_price         numeric(20, 6) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  income_account_id  uuid NOT NULL,
  default_tax_rate_ids uuid[] NOT NULL DEFAULT '{}',
  is_active          boolean NOT NULL DEFAULT true,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, name),
  FOREIGN KEY (company_id, income_account_id) REFERENCES accounts(company_id, id)
);
CREATE TRIGGER items_touch BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION app.touch_row();
SELECT app.enable_tenant_rls('items');

-- ---------------------------------------------------------------------------
-- Attachments: private object storage references
-- ---------------------------------------------------------------------------
CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  kind          text NOT NULL CHECK (kind IN ('receipt', 'invoice_pdf', 'csv_import', 'other')),
  object_key    text NOT NULL UNIQUE,
  file_name     text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),
  sha256        text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded', 'deleted')),
  entity_type   text,
  entity_id     uuid,
  uploaded_by   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  deleted_at    timestamptz,
  UNIQUE (company_id, id),
  -- object keys are scoped to the company prefix
  CHECK (object_key LIKE 'companies/' || company_id::text || '/%')
);
CREATE INDEX attachments_entity_idx ON attachments (company_id, entity_type, entity_id);
CREATE INDEX attachments_pending_idx ON attachments (status, created_at) WHERE status = 'pending';
SELECT app.enable_tenant_rls_with_system_read('attachments');

SELECT app.grant_app_privileges();
