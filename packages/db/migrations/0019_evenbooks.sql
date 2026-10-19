-- Keep earlier migrations intact: installed databases verify their hashes.
-- Role renames are a separate administrator step; see docs/name-upgrade.md.

CREATE OR REPLACE FUNCTION app.grant_app_privileges() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'evenbooks_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public, app TO evenbooks_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO evenbooks_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO evenbooks_app';
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO evenbooks_app';
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO evenbooks_app';
  END IF;
END
$$;

ALTER TABLE processor_charges DROP CONSTRAINT processor_charges_origin_check;
ALTER TABLE processor_refunds DROP CONSTRAINT processor_refunds_origin_check;

-- The owner is subject to FORCE RLS too. Visit each company with tenant context
-- rather than disabling its policies or granting the owner a bypass.
DO $$
DECLARE
  company uuid;
  previous_system text := current_setting('app.system', true);
  previous_company text := current_setting('app.company_id', true);
BEGIN
  PERFORM set_config('app.system', 'on', true);
  FOR company IN SELECT id FROM companies LOOP
    PERFORM set_config('app.company_id', company::text, true);
    UPDATE processor_charges SET origin = 'evenbooks' WHERE origin = 'beans';
    UPDATE processor_refunds SET origin = 'evenbooks' WHERE origin = 'beans';
    UPDATE accounts
       SET description = 'Card and bank-debit processing fees (Stripe) and Evenbooks platform fees on online payments.'
     WHERE role = 'processor_fees'
       AND description = 'Card and bank-debit processing fees (Stripe) and Beans platform fees on online payments.';
  END LOOP;
  PERFORM set_config('app.company_id', COALESCE(previous_company, ''), true);
  PERFORM set_config('app.system', COALESCE(previous_system, ''), true);
END
$$;

ALTER TABLE processor_charges ADD CONSTRAINT processor_charges_origin_check
  CHECK (origin IN ('evenbooks', 'external'));
ALTER TABLE processor_refunds ADD CONSTRAINT processor_refunds_origin_check
  CHECK (origin IN ('evenbooks', 'external'));

SELECT app.grant_app_privileges();
