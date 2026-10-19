-- 0008_import_rows
-- Row-level provenance for CSV imports (preview -> commit).

CREATE TABLE import_rows (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  batch_id             uuid NOT NULL,
  row_no               integer NOT NULL CHECK (row_no > 0),
  raw                  jsonb NOT NULL,
  normalized           jsonb,
  fingerprint          text,
  status               text NOT NULL CHECK (status IN ('ok', 'duplicate', 'error')),
  error                text,
  duplicate_of         uuid,
  bank_transaction_id  uuid,
  UNIQUE (company_id, id),
  UNIQUE (batch_id, row_no),
  FOREIGN KEY (company_id, batch_id) REFERENCES import_batches(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, bank_transaction_id) REFERENCES bank_transactions(company_id, id)
);
CREATE INDEX import_rows_batch_idx ON import_rows (batch_id, row_no);
SELECT app.enable_tenant_rls('import_rows');

SELECT app.grant_app_privileges();
