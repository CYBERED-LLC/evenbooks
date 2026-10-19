# Evenbooks

**Bookkeeping that shows its work.**

Evenbooks is source-available double-entry bookkeeping for sole proprietors and
small businesses in the United States. Import bank transactions, send invoices,
accept payments, and prepare reports from the same ledger.

Read the code, run it for your own business, and export your reports as CSV.

## What you can do

- **Keep balanced books.** Manage your chart of accounts, opening balances,
  journal entries, and period locks, with an audit trail of changes.
- **Review and reconcile transactions.** Import CSV statements or connect
  SimpleFIN Bridge, review suggested categories, match existing records, and
  reconcile against your bank statement.
- **Invoice customers.** Send PDF invoices by email, schedule recurring invoices,
  issue credit notes, and track partial payments and outstanding balances.
- **Accept online payments.** Connect a Stripe account for card and bank transfer
  payments, with payments, fees, refunds, and payouts recorded in the books.
- **Prepare reports.** Export cash- and accrual-basis profit and loss, balance
  sheets, trial balances, general ledgers, outstanding invoices, and a Schedule C
  summary.
- **Bring your history and your bookkeeper.** Import general-ledger CSV exports,
  attach supporting documents, and work across companies with admin and member
  roles.

Evenbooks currently supports USD. Historical ledger imports create journal
entries rather than recreating old invoices or bills. Inventory accounting,
unpaid vendor bills, and tax filing are outside the current scope. The
[known limitations](docs/limitations.md) describe the remaining gaps.

## Run it locally

You'll need Node.js 22+, pnpm 10, and PostgreSQL 15+.

The [local setup guide](docs/local-setup.md) walks through configuring the
environment, creating a development database, and loading demo data. Local
development uses test users, sample bank transactions, logged emails, and disk
storage, so you can explore the app without external service credentials.

Once setup is complete, start the web app and background worker in separate
terminals:

```sh
pnpm dev
```

```sh
pnpm dev:worker
```

Open [localhost:3000](http://localhost:3000) and sign in at `/dev-login` to explore
the demo companies.

## Self-hosting

You can run Evenbooks for your own business under the terms of its license.
The [deployment and operations guide](docs/runbook.md) covers configuration,
backups, restores, and production setup.

Production integrations include Clerk for authentication, SimpleFIN Bridge for
bank feeds, Stripe Connect for online payments, Amazon SES for email, and
S3-compatible storage for attachments. These services require their own
configuration and, where applicable, subscriptions or approval. See the runbook
and [integration limitations](docs/limitations.md) before enabling them.

## Development

Evenbooks is a TypeScript monorepo built with Next.js, PostgreSQL, and a pg-boss
background worker. Workspace packages use the `@evenbooks/*` scope.

- `apps/web` — web interface and API.
- `apps/worker` — background jobs for PDFs, email, recurring invoices, and bank sync.
- `packages/` — accounting logic, database, shared contracts, business services,
  and external integrations.

The [local setup guide](docs/local-setup.md) includes development commands and
test prerequisites. To check a change:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Browser tests run with `pnpm test:e2e` while the development server is running.
For more context, see the [financial policy](docs/financial-policy.md),
[design decisions](docs/decisions.md), and [verification notes](docs/verification.md).

## License

Evenbooks is **source-available under Elastic License 2.0**, with an additional
sunset grant. You can read, modify, and self-host the software. The license
restricts offering it to third parties as a hosted or managed service.

If the official Evenbooks hosted service is permanently discontinued, versions
released under these terms by that date also become available under Apache
License 2.0.

See [LICENSE.md](LICENSE.md) for the full terms and
[LICENSE-APACHE](LICENSE-APACHE) for the Apache License text. Third-party material
retains its own license terms.
