-- 0005_purchases
-- Paid purchases (bank or credit card) and vendor refunds. No AP lifecycle.

CREATE TABLE purchases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id),
  contact_id            uuid,
  date                  date NOT NULL,
  currency              text NOT NULL REFERENCES currencies(code),
  -- 'outflow' = money paid out; 'inflow' = vendor refund received
  direction             text NOT NULL DEFAULT 'outflow' CHECK (direction IN ('outflow', 'inflow')),
  paid_from_account_id  uuid NOT NULL,
  reference             text,
  memo                  text,
  total                 numeric(20, 6) NOT NULL CHECK (total > 0),
  status                text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
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
  FOREIGN KEY (company_id, paid_from_account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id),
  FOREIGN KEY (company_id, void_journal_entry_id) REFERENCES journal_entries(company_id, id),
  CHECK ((status = 'void') = (void_journal_entry_id IS NOT NULL))
);
CREATE INDEX purchases_company_date_idx ON purchases (company_id, date);
CREATE INDEX purchases_contact_idx ON purchases (company_id, contact_id);
CREATE TRIGGER purchases_touch BEFORE UPDATE ON purchases FOR EACH ROW EXECUTE FUNCTION app.touch_row();
SELECT app.enable_tenant_rls('purchases');

CREATE TABLE purchase_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  purchase_id  uuid NOT NULL,
  line_no      integer NOT NULL CHECK (line_no > 0),
  account_id   uuid NOT NULL,
  description  text NOT NULL DEFAULT '',
  amount       numeric(20, 6) NOT NULL CHECK (amount > 0),
  UNIQUE (company_id, id),
  UNIQUE (purchase_id, line_no),
  FOREIGN KEY (company_id, purchase_id) REFERENCES purchases(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id)
);
SELECT app.enable_tenant_rls('purchase_lines');

SELECT app.grant_app_privileges();
