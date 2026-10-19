-- 0014_control_account_names
-- The receivable control account holds only invoices issued in Evenbooks
-- (invoices, payments and credit notes are the only writers), so its default
-- name now says so. Companies still on the untouched default are renamed;
-- anyone who already renamed it keeps their name. Control accounts without a
-- description get the one new companies receive. The migration role has no
-- RLS bypass, so forced row security is lifted for the two statements.

ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY;

UPDATE accounts
SET name = 'Accounts Receivable (Evenbooks invoices)'
WHERE role = 'accounts_receivable' AND name = 'Accounts Receivable';

UPDATE accounts
SET description = CASE role
  WHEN 'accounts_receivable' THEN 'Invoices issued in Evenbooks. Moves only through invoices, payments and credit notes. Track receivables you collect elsewhere in a separate asset account.'
  WHEN 'sales_tax_payable' THEN 'Tax collected on Evenbooks invoices. Moves only through invoices and credit notes.'
  WHEN 'customer_deposits' THEN 'Unapplied customer payments and credit notes. Moves only through payments and credit notes.'
END
WHERE role IN ('accounts_receivable', 'sales_tax_payable', 'customer_deposits')
  AND (description IS NULL OR description = '');

ALTER TABLE accounts FORCE ROW LEVEL SECURITY;

SELECT app.grant_app_privileges();
