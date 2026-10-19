-- 0013_processor_linking
-- A company can connect a Stripe account it already has (Stripe Connect OAuth)
-- instead of creating a new one through hosted onboarding. `origin` records
-- which path created the connection; `linked_balance` is the Stripe balance the
-- account already held when it was linked, which the books never saw and which
-- the next payouts will include.

ALTER TABLE payment_processor_connections
  ADD COLUMN origin text NOT NULL DEFAULT 'created' CHECK (origin IN ('created', 'linked')),
  ADD COLUMN linked_balance numeric(20, 6),
  ADD COLUMN linked_at timestamptz;
