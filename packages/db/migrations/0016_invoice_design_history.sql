-- Migration owner has NOBYPASSRLS. Lift forced RLS transactionally for the
-- historical issuer backfill, then restore it before commit.
ALTER TABLE companies NO FORCE ROW LEVEL SECURITY;
ALTER TABLE invoices NO FORCE ROW LEVEL SECURITY;
UPDATE invoices i SET design_snapshot = jsonb_build_object(
  'issuer', jsonb_build_object('name', c.name, 'email', c.email, 'phone', c.phone, 'address', c.address),
  'branding', jsonb_build_object('layout','classic','accentColor','#1d4ed8','paperSize','LETTER','logo',null,'defaultFooter',null,'defaultNotes',null,'paymentInstructions',null),
  'templateVersion', 0
) FROM companies c
WHERE i.company_id = c.id AND i.status <> 'draft' AND i.design_snapshot IS NULL;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;

-- Brand/layout changes may create a new PDF. The historical issuer stays fixed.
CREATE FUNCTION app.invoice_issuer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND OLD.design_snapshot IS NOT NULL
     AND NEW.design_snapshot->'issuer' IS DISTINCT FROM OLD.design_snapshot->'issuer' THEN
    RAISE EXCEPTION 'Issued invoice issuer details are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER invoice_issuer_guard BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION app.invoice_issuer_guard();
CREATE TRIGGER invoice_presentation_append_only BEFORE UPDATE OR DELETE ON invoice_presentation_versions
  FOR EACH ROW EXECUTE FUNCTION app.forbid_change();
SELECT app.grant_app_privileges();
