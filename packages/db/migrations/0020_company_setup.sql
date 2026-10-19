-- Setup answers asked on a company's first visit (docs/novice-ux-plan.md, Phase 2).
-- All nullable: null means "not answered yet", and existing companies keep today's defaults.
ALTER TABLE companies ADD COLUMN business_type text
  CHECK (business_type IN ('sole_proprietor', 'single_member_llc', 'partnership', 's_corp', 'c_corp', 'nonprofit', 'other'));
-- How the owner reports income tax; reports open on this basis.
ALTER TABLE companies ADD COLUMN tax_basis text CHECK (tax_basis IN ('cash', 'accrual'));
-- The first day the owner keeps their books in Evenbooks; starting balances are as of the day before.
ALTER TABLE companies ADD COLUMN books_start_date date;
-- The dashboard's "Set up your books" checklist was dismissed.
ALTER TABLE companies ADD COLUMN setup_dismissed_at timestamptz;
