CREATE TABLE invoice_presentation_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  version integer NOT NULL CHECK (version > 0),
  presentation jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, version)
);
SELECT app.enable_tenant_rls('invoice_presentation_versions');
CREATE TABLE company_email_senders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  domain text NOT NULL,
  from_email text NOT NULL,
  from_name text NOT NULL,
  proof_token text NOT NULL,
  dkim_tokens jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','failed','disabled')),
  active boolean NOT NULL DEFAULT false,
  checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, domain)
);
CREATE UNIQUE INDEX company_email_senders_active ON company_email_senders(company_id) WHERE active;
SELECT app.enable_tenant_rls_with_system_read('company_email_senders');
ALTER TABLE invoices ADD COLUMN design_snapshot jsonb;
ALTER TABLE email_messages ADD COLUMN content_snapshot jsonb, ADD COLUMN template_version integer;
ALTER TABLE email_messages DROP CONSTRAINT email_messages_kind_check;
ALTER TABLE email_messages ADD CHECK (kind IN ('invoice','invoice_test'));
-- Backfill historical issuer/design once; existing PDFs are never overwritten.
UPDATE invoices i SET design_snapshot = jsonb_build_object(
  'issuer', jsonb_build_object('name', c.name, 'email', c.email, 'phone', c.phone, 'address', c.address),
  'branding', jsonb_build_object('layout','classic','accentColor','#1d4ed8','paperSize','LETTER','logo',null,'defaultFooter',null,'defaultNotes',null,'paymentInstructions',null),
  'templateVersion', 0
) FROM companies c WHERE i.company_id = c.id AND i.status <> 'draft';
SELECT app.grant_app_privileges();
