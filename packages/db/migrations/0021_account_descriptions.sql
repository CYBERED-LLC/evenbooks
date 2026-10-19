-- 0021_account_descriptions
-- Starter accounts gain one-line descriptions in plain words (docs/novice-ux-plan.md 1.4/4.10).
-- New companies get them from DEFAULT_CHART; existing companies get them only on
-- defaults nobody has touched: the name and type still match the default, and the
-- description is empty or still the wording an earlier release wrote. Anything
-- an owner renamed or described themselves is left alone.
--
-- The owner is subject to FORCE RLS too, so each company is visited with tenant
-- context (as in 0019) rather than lifting row security.

DO $$
DECLARE
  company uuid;
  previous_system text := current_setting('app.system', true);
  previous_company text := current_setting('app.company_id', true);
BEGIN
  PERFORM set_config('app.system', 'on', true);
  FOR company IN SELECT id FROM companies LOOP
    PERFORM set_config('app.company_id', company::text, true);
    UPDATE accounts a
       SET description = d.description
      FROM (VALUES
      ('Checking Account', 'asset', 'Your main business bank account.', NULL),
      ('Undeposited Funds', 'asset', 'Checks and cash received but not yet deposited.', NULL),
      ('Accounts Receivable (Evenbooks invoices)', 'asset', 'Invoices issued in Evenbooks that customers haven''t paid yet. Changes only through invoices, payments and credit notes.', 'Invoices issued in Evenbooks. Moves only through invoices, payments and credit notes. Track receivables you collect elsewhere in a separate asset account.'),
      ('Equipment', 'asset', 'Computers, tools, vehicles and other things the business owns and uses for years.', NULL),
      ('Accumulated Depreciation', 'asset', 'How much of your equipment''s cost has been written off as depreciation so far. Shown as a negative amount.', NULL),
      ('Credit Card', 'liability', 'What you owe on the business credit card.', NULL),
      ('Sales Tax Payable', 'liability', 'Sales tax you collected on invoices and still need to pay to the state. Changes only through invoices and credit notes.', 'Tax collected on Evenbooks invoices. Moves only through invoices and credit notes.'),
      ('Customer Deposits and Credits', 'liability', 'Money customers paid you ahead of time, and credits you owe them. Changes only through payments and credit notes.', 'Unapplied customer payments and credit notes. Moves only through payments and credit notes.'),
      ('Loans Payable', 'liability', 'What the business still owes on loans.', NULL),
      ('Owner''s Equity', 'equity', 'Money you put into the business from your own pocket.', NULL),
      ('Owner''s Draws', 'equity', 'Money you took out of the business for yourself.', NULL),
      ('Retained Earnings', 'equity', 'Profit from earlier years that stayed in the business.', NULL),
      ('Opening Balance Equity', 'equity', 'Balancing amount from your starting balances.', NULL),
      ('Sales', 'income', 'Money from selling products.', NULL),
      ('Service Revenue', 'income', 'Money from the services you provide.', NULL),
      ('Sales Discounts', 'income', 'Discounts and write-offs that lower what customers pay you.', NULL),
      ('Other Income', 'income', 'Income that isn''t from your main business, such as interest.', NULL),
      ('Advance Customer Payments', 'income', 'Customer payments not yet applied to an invoice. Used on cash-basis reports only.', 'Cash-basis only: unapplied customer funds received. Reclassified when applied to invoices.'),
      ('Uncategorized Income', 'income', 'Money in that hasn''t been sorted into a category yet.', NULL),
      ('Advertising', 'expense', 'Ads, marketing and promotion.', NULL),
      ('Car and Truck Expenses', 'expense', 'Fuel, parking, tolls and other costs of driving for the business.', NULL),
      ('Commissions and Fees', 'expense', 'Commissions and fees paid to others, such as marketplace fees.', NULL),
      ('Contract Labor', 'expense', 'Payments to freelancers and contractors who aren''t employees.', NULL),
      ('Depreciation', 'expense', 'The yearly write-off of equipment you own.', NULL),
      ('Insurance', 'expense', 'Business insurance, other than health insurance.', NULL),
      ('Interest Expense', 'expense', 'Interest on business loans and credit cards.', NULL),
      ('Legal and Professional Services', 'expense', 'Accountants, lawyers and other professional help.', NULL),
      ('Office Expense', 'expense', 'Postage, printing and small office costs.', NULL),
      ('Rent or Lease', 'expense', 'Rent for your office, shop or equipment.', NULL),
      ('Repairs and Maintenance', 'expense', 'Fixing and maintaining equipment or your workplace.', NULL),
      ('Supplies', 'expense', 'Materials and supplies you use up in the business.', NULL),
      ('Taxes and Licenses', 'expense', 'Business licenses, permits and business taxes (not income tax).', NULL),
      ('Travel', 'expense', 'Airfare, hotels and other costs of business trips.', NULL),
      ('Meals', 'expense', 'Business meals. Usually only half is deductible.', NULL),
      ('Utilities', 'expense', 'Phone, internet, electricity and water for the business.', NULL),
      ('Software and Subscriptions', 'expense', 'Software and online services you pay for.', NULL),
      ('Bank Fees', 'expense', 'Fees your bank or payment processor charges.', NULL),
      ('Bad Debt', 'expense', 'Invoices you have given up on collecting.', NULL),
      ('Other Expenses', 'expense', 'Business costs that don''t fit another category.', NULL),
      ('Rounding Differences', 'expense', 'Cent differences from rounding.', NULL),
      ('Uncategorized Expense', 'expense', 'Money out that hasn''t been sorted into a category yet.', NULL)
      ) AS d(name, type, description, previous)
     WHERE a.company_id = company
       AND a.name = d.name
       AND a.type::text = d.type
       AND (a.description IS NULL OR a.description = '' OR a.description = d.previous);
  END LOOP;
  PERFORM set_config('app.company_id', COALESCE(previous_company, ''), true);
  PERFORM set_config('app.system', COALESCE(previous_system, ''), true);
END
$$;

SELECT app.grant_app_privileges();
