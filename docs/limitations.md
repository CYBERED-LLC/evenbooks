# Known limitations and follow-ups

Honest list of what the MVP does not do, or does only partially, as of 2026-09-17.

## Not exercised live
- **Clerk, SES, SimpleFIN Bridge, Railway buckets and Railway deployment were not exercised from this repository.** The code paths exist and are unit/integration tested against local adapters (dev auth, log email transport, fixture SimpleFIN client, local disk storage). Activation requires credentials and a deliberate production go-live (see `docs/runbook.md`). Nothing in the automated tests sends a real email or contacts a real bank.
- The SES SNS webhook verifies signatures with `sns-validator`; the parsing of SES event JSON follows the documented shape but has not been tested against real SNS traffic.

## Online payments (Stripe Connect, added 2026-09-21)
- **Not exercised against Stripe.** The Stripe driver is written against the official SDK (22.6) but was not run with real keys from this repository: no live Checkout, webhook signature, refund or payout has been observed. The fixture driver covers the ledger path; the first live run should follow `docs/runbook.md` §11 in Stripe test mode.
- **Linked accounts start with a blind spot.** Charges, refunds and disputes from before the link are not imported. Refunds or disputes of those old charges are ignored (no charge in the books to reverse), and the balance the account held at link time is shown for the user to record by hand. Both show up as a clearing-account difference after the next payouts.
- **Stripe platform approval** (Connect platform profile) and a public website/terms are prerequisites for live use.
- **Partial application-fee refunds** call `applicationFees.createRefund` on the platform account after the customer refund; a failure there is logged and swallowed so the customer refund is never hidden. Reconcile platform-fee refunds in the Stripe dashboard if that call ever fails.
- **Disputes** post on `charge.dispute.created` and reverse on `won`; `lost` leaves the withdrawal in place and only updates the status. Partial dispute amounts are handled; evidence submission happens in the Stripe dashboard.
- **External charges** (dashboard, Payment Links) post as unapplied customer funds with no contact; they must be allocated or refunded by hand.
- **No saved payment methods, no auto-charge for recurring invoices, no customer receipts from Stripe, no surcharging**, and one processor connection per company (Stripe only).
- The public checkout endpoint has no rate limiting beyond what the rest of the app has.
- **The all-in fee assumes Stripe's standard US schedule.** Evenbooks' share is fixed when the checkout opens, from the published rates; if Stripe's actual fee is higher (international cards, currency conversion, disputes) the business pays the difference above the advertised 5 or 1 percent. The recorded fee entry always shows what Stripe actually took and what Evenbooks took.
- **Team limits** are pushed to Clerk best-effort when a plan changes; there is no periodic true-up, so a failed API call leaves the organization on its previous limit until the next plan change or a manual fix in the Dashboard.
- **Plan detection** relies on Clerk Billing plan slugs (or an `org_plan` session claim) and is refreshed on signed-in requests; a plan change made in Clerk takes effect the next time someone from the company loads the app, or immediately for organization webhooks carrying `public_metadata.plan`.

## Importing history from another app (added 2026-09-25)
- **Journal-level only.** A general-ledger export becomes balanced journal entries (source `import`). Invoices, bills, payments, customers and vendors are not recreated as documents, so imported sales cannot be collected or credited in Evenbooks, and the AR aging only shows invoices issued here.
- **Control accounts are off limits**, as for manual journals: "Accounts Receivable (Evenbooks invoices)", customer deposits and sales tax payable accept postings only from documents issued in Evenbooks. The old app's receivables and sales-tax accounts must be matched to ordinary accounts (the importer suggests "… (previous system)"), invoices collected outside Evenbooks stay in that separate account, and the sales-tax report does not include imported tax. The built-in accounts can be renamed and renumbered.
- **Cash basis requires settlement review.** General-ledger exports do not reliably link old invoices to their payments. Entries moving money against another balance-sheet account require explicit income/expense amounts in the import preview (including any fees). No income/expense is recorded for an explicitly reviewed transfer or loan. Existing imported settlements without review block cash reports and identify the journal entry to review. Admins can correct those amounts from the imported journal entry with a reason; closed periods, including linked reversal periods, must first be reopened. The accrual ledger is unchanged, and cash recognition rebuilds and reversals retain the reviewed amounts. Imported sales-tax amounts remain outside the sales-tax report.
- **Posting is synchronous** in one request and one transaction (10 MB file limit). Tens of thousands of lines may take a minute; very large histories should be split by year.
- **No bulk undo.** Imported entries are reversed one at a time from the journal. Re-importing an overlapping export skips entries already imported (matched by date, accounts and amounts), but an entry edited in the old app after the first import comes in again as new.
- **Wave's General Ledger report is read as exported** (Reports → Account Transactions (General Ledger) → Export CSV): its per-account sections, balance rows and currency symbols are handled, and lines are matched by date and description, with an invoice's "Customer - 12" receivable line absorbing its "Customer - 12 - Product" sales lines. Verified against a real export. Two unrelated unbalanced groups on the same day that happen to net to zero are combined into one entry (the description lists both); genuinely unbalanced days are reported per group. Wave's "Export accounting transactions" CSV (with a Transaction ID column) also works.
- Imported entries that post to bank accounts are not linked to bank transactions; reconcile from a date after the imported history, or expect those lines to appear as uncleared.

## Functional gaps (by design for MVP)
- **Single currency (USD).** Base currency and document currency columns exist, but posting rejects anything other than the company currency and there is no FX handling.
- **No accounts payable lifecycle.** Purchases are recorded when paid. Unpaid vendor bills, purchase orders and bill payment scheduling are out of scope.
- **No inventory / COGS automation.**
- **No estimates, receipt OCR, email-to-receipt ingestion, automated overdue reminders.** Online payments exist through Stripe Connect (see above); the optional external payment URL on invoices remains a link only and is never treated as proof of payment.
- **Refunds are recorded against unapplied payment funds or credit notes only.** Refunding a fully applied payment requires reversing the allocation first (the UI explains this). Vendor refunds are purchases with direction `inflow`.
- **Categorizing money-in bank lines as customer payments** must go through Payments (record payment → match the bank line); the inbox refuses to post income to the AR/deposits control accounts.
- **Bank matching to existing records** links evidence and posts fee/deposit entries; it does not reconcile card-processor payout batches beyond "several payments + one fee".
- **Reconciliation** supports one in-progress session per bank account and clears whole journal lines; there is no partial clearing.
- **Schedule C summary** groups book categories by mapping and shows meals at 100 percent; it does not apply limitations or produce a filing.
- **Reports** are accrual-only for balance sheet, trial balance and general ledger, as stated on screen. Cash-basis reports derive from the recognition layer; manual journals must declare their cash treatment.
- **Prepaid expenses / depreciation** are manual journals (with explicit cash treatment); there is no fixed-asset register.
- **Sales tax** is manual rates only; no jurisdiction lookup, no seller-imposed gross-up option, no filing export beyond the tax lines on reports.

- **Printing** the general ledger or transactions report prints only the lines already loaded; use the CSV for the full range.
- **List sorting**: names sort case-insensitively without an index (fine at small-business scale); a contact renamed while someone pages may shift that pass. Document numbers sort as text, so INV-10000 sorts before INV-9999. CSV export pages through the API (up to 20,000 rows).
- **Job retry** re-runs a failed job once through the outbox. An email that turns "uncertain" between the retry request and the worker run is still guarded by the sender's claim, but check the provider before resending uncertain mail. Retrying the single-invoice Send with the same idempotency key after a first send is treated as a conflict; use the bulk Send or Resend.
- **Keyboard shortcuts** (single keys and g-sequences) are off while typing in a field or while a dialog is open; Cmd/Ctrl+K and Cmd/Ctrl+Enter always work.

- **Permanent deletion** (added 2026-10-12) leaves gaps in invoice, credit note and journal numbering. A customer who already received a deleted invoice keeps their copy; its link stops working. Deleting an imported journal entry frees its import key, so importing the same rows again posts them again. Idempotent replays of earlier requests can return a record that no longer exists. Deleting a payment or credit note does not cascade to its refunds, and a reversed allocation still blocks deleting its invoice until the payment is deleted. Attachments of deleted records are detached and removed by the orphan-cleanup job rather than at once.

## Operational
- **Dev authentication** exists for local development and browser tests. It is refused when `APP_ENV=production` unless explicitly overridden; do not override.
- **Worker cron schedules are UTC**; recurring invoices are issued at 06:00 company-local time by computing the instant per schedule.
- **Categorization rules** use contains, starts-with or exact text matches. Legacy regex rules are disabled by migration and never executed; choose a text match to reuse one.
- **Rate limits**: no per-user API rate limiting; the app is intended for a handful of trusted users. The one quota is on invoice email (`EMAIL_QUOTAS`, per company, per plan), because that endpoint sends from the platform's own identity.
- **Public invoice PDFs** are served through the app (local storage) or via short-lived presigned URLs (S3). Old PDF versions remain downloadable to the company but the public link only exposes the current version.
- **Performance** was checked at ~12,000 bank transactions in one company (warm API responses 10–60 ms on the dev server). Reports aggregate in SQL; the general ledger and transactions report page in memory after a range query and would need keyset pagination beyond a few hundred thousand lines.
- **ESLint** runs with the TypeScript recommended rules; `eslint-config-next` is not wired in (Next 16 removed `next lint`).

## Data model notes
- Deleting a Clerk organization does not delete its company; there is no company deletion flow.
- `cash_recognitions` is append-only for updates but is fully rebuildable (`verify-recognition.ts`); rebuilt rows lose per-event provenance (`event_type = 'rebuild'`), so a permanent delete in a rebuilt company rebuilds the layer again.
