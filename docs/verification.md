# Verification evidence

What was run, where, and what it showed. Local environment: Debian 12, Node 24.21, pnpm 10.34, PostgreSQL 15.19 on localhost. All figures below are from runs on 2026-09-17; re-run the commands to refresh them.

## Automated suites

| Suite | Command | Scope | Result |
| --- | --- | --- | --- |
| Domain | `pnpm --filter @evenbooks/domain test` | money/rounding/allocation, ledger validation, invoice arithmetic, settlement allocation (plan fixture $1,000 + $100 tax / $550 → $500 + $50), plain dates, recurring schedules (month-end clamping, leap years, catch-up), CSV normalization | 44 passed |
| Database | `pnpm --filter @evenbooks/db test` | migrations apply and are idempotent; drizzle schema has no drift vs `information_schema`; every company table has RLS **forced**; app role cannot bypass RLS or run DDL | 4 passed |
| Services | `pnpm --filter @evenbooks/services test` | posting invariants (service + direct DB), period locks, reversals, idempotency, two-company isolation (RLS, composite FKs, owner FORCE RLS, pool reuse), purchases/receipts/CSV replay/inbox/reconciliation, invoices/payments/credits/refunds/deposits on both bases, PDF snapshot immutability, email states, recurring concurrency + restart, SimpleFIN overlap/pending/changes/reconnect, cash recognition reproducibility | 56 passed |
| Services (M6, 2026-09-21) | `pnpm --filter @evenbooks/services test` (`processor.test.ts`) | connect + system accounts + isolation; card checkout → payment allocated + fee entry + clearing/fee balances; duplicate and re-sent events; partial card then ACH (processing blocks re-pay, settles later); failed ACH; manual payment racing an online one leaves excess unapplied; external charge → unapplied funds; unknown account ignored, failing event visible and retried; refund from Evenbooks (proportional fee refund, only the refunded part reopens, provider echo is a no-op, over-refund rejected); dashboard refund; dispute withdraw + win restores clearing and fees; payout auto-posts, bank line matches it, clearing returns to zero; failed payout reversed; cash recognition re-derives; paid plan pays no platform fee | 16 passed |
| Worker | `pnpm --filter @evenbooks/worker test` | outbox → pg-boss dispatch, PDF + email jobs end to end with the log transport, duplicate job harmless, permanent failure visible, ticks + heartbeat | 2 passed |
| Browser (Playwright) | `pnpm --filter @evenbooks/web test:e2e` | see below | 30 passed across 10 specs (3.0 min against the dev server) |

Browser coverage (each spec is re-runnable with unique names):

- `m1-ledger`: dev login; account + posted journal + reversal; **company switching shows no prior-company data**, direct API access to the other company's entry is 404, stale `x-company-id` is 409; member permissions; period close blocks posting, reopen is audited.
- `m2-masters`, `m2-purchases-banking`, `m2-inbox`, `m2-reconcile`: contacts/items/tax rates; purchase with receipts and void; CSV wizard preview/remap/commit; inbox categorize/split/transfer/exclude/undo and rule creation; reconciliation to zero and completion.
- `m3-invoices`: form with live server totals → issue → public link renders → email queued → void; credit note applied to the invoice reduces its balance (**invoice-to-payment via credit**).
- `m3-payments`: **invoice → payment** (prefill from invoice, overpayment held as unapplied, refund, reverse allocation), P&L cash vs accrual page.
- `m4-automation`: recurring schedule create → issue due (8 month-end occurrences) → pause → resume with catch-up preview → SimpleFIN connect/link/sync (fixture) → jobs page (**recurring recovery path**).
- `m5-import-to-reconcile`: **import → review → reconcile** in one flow with ledger assertions.
- `m6-payments` (2026-09-21): connect Stripe through the fixture onboarding → issue invoice → customer pays $300 of $800 by card from the public page in a separate browser context → public balance shows $500 after the redirect → charge shows Stripe's 2.9% + 0.30 fee and a Evenbooks fee that brings the total to exactly 5% → refund $100 from the invoice page reopens exactly $100 → payment page shows “Paid online” and blocks Void → hiding the Pay button removes it from the public page → payout posts, clearing balance $0.00, entry linked → jobs page clean; webhook route ignores unknown accounts and rejects malformed bodies.
- `m5-reports`: every report page renders with its basis note and CSV link; trial balance debits = credits; balance sheet difference $0.00; Schedule C mapping change persists.

## Financial reconciliation across views

`packages/services/test/sales.test.ts` asserts, on the same dataset, that: AR equals Σ open invoice balances; the customer-deposits liability equals Σ unapplied payments + Σ open credits; accrual income equals issued net revenue while cash income follows settlements (plan fixture); credit application nets to zero cash income; cash refunds of credits are negative income; and `verifyCashRecognition` re-derives every recognition row from documents with zero diffs, before and after a rebuild.

`scripts/restore-exercise.sh` (see below) additionally checks in the restored copy that every posted entry balances, the trial balance nets to zero per company, and invoice settled amounts equal active allocations.

## Performance (12k transactions)

Seeded with `SEED_SCALE=12000 pnpm db:seed`: Alpha Consulting has 12,134 bank transactions, 393 journal entries, 816 lines, 66 invoices; Beta Design Studio is a separate, isolated company. Warm response times against the **development** server (Turbopack, no caching), 3 samples each:

| Endpoint | ms |
| --- | --- |
| `GET /api/banking/transactions?limit=50` | 29 / 32 / 36 |
| `GET /api/banking/transactions?limit=50&status=unreviewed&q=COFFEE` | 60 / 52 / 55 |
| `GET /api/journal?limit=50` | 22 / 17 / 18 |
| `GET /api/reports/profit-and-loss` (accrual) | 12 / 17 / 13 |
| `GET /api/reports/profit-and-loss` (cash) | 12 / 13 / 13 |
| `GET /api/reports/balance-sheet` | 26 / 22 / 25 |
| `GET /api/reports/trial-balance` | 14 / 15 / 27 |
| `GET /api/reports/transactions?limit=200` | 26 / 22 / 17 |
| `GET /api/reports/outstanding-invoices` | 15 / 18 / 21 |
| `GET /api/invoices?limit=50` | 21 / 13 / 15 |
| `GET /api/accounts?withBalances=true` | 16 / 16 / 16 |

## Backup and restore exercise

`./scripts/restore-exercise.sh` on 2026-09-17 (after seeding):

```
Dumped the database, restored it with bootstrapped roles, and copied attachment objects.
Restored ledger checks:
  posted entries that do not balance: 0
  trial balance difference per company: 0.000000 / 0.000000
  invoices whose balance disagrees with allocations: 0
  counts: companies 2, entries 393, invoices 66, attachments 32
  attachment objects present in the restored store: checked 32, missing 0
  application-role access through RLS without context: 0 rows
RESTORE EXERCISE OK
```

The first run of this exercise caught a real bug: `STORAGE_LOCAL_DIR` was resolved against each process's working directory, so web, worker and scripts wrote to different folders. Relative paths are now resolved against the repository root (`resolveLocalDir`).

## Static checks

- `pnpm typecheck`: clean in all six packages.
- `pnpm lint` (ESLint 10, typescript-eslint recommended, react-hooks): 0 errors.
- `pnpm build`: `next build` succeeds with every route dynamic (`ƒ`), standalone output.

## Live integrations — NOT exercised

**Stripe (added 2026-09-21)** was not exercised live either: the Stripe driver is untested against real keys. The fixture driver and the tests above cover the ledger path; see `docs/runbook.md` §11 for the first live check.

Railway itself has now been exercised (see the table). The following were **not** exercised against real services and are therefore unverified beyond unit/integration tests with local adapters and contract fixtures:

| Integration | Local adapter used in tests | What a live check would need |
| --- | --- | --- |
| Clerk authentication/organizations | `AUTH_MODE=dev` cookie adapter | Clerk keys; sign-in, org switch, webhook `organization.created` |
| Amazon SES sending + SNS events | `LogEmailSender`; SNS route tested only via unit-level parsing | Verified sender, configuration set, SNS HTTPS subscription confirmation, a real bounce |
| SimpleFIN Bridge | `FixtureSimpleFinClient` | A real setup token; verify `errors[]`/`errlist` shapes and rate limits |
| Railway Postgres / buckets / deploy | **Exercised on 2026-09-17**: project created via CLI, Postgres 18 + bucket provisioned, web + worker deployed, role bootstrap and migrations ran in pre-deploy, PDF stored in the bucket and downloaded via presigned URL, public URL smoke-tested (`docs/railway.md`) | — |

No customer email was sent by any automated test; the email transport in tests records messages in memory.

## Evenbooks package rename (2026-10-12)

- Frozen-lockfile install, typecheck, lint, all package tests, and production build passed locally.
- Added database upgrade coverage for two tenants, preserving amounts and runtime RLS, plus checkout/refund webhook coverage for original metadata keys.
- Railway dev: both package scopes and database roles updated; migration 0019 applied with prior migration checksums intact. Financial record counts and ledger invariants passed after the upgrade.
- Hosted smoke checks: health and public pages passed, the browser demo responded, and the background worker completed a manual run. See [Railway deployment notes](railway.md).

## Production rename rollout (2026-10-12)

- Deployed revision `61e8a63` to production web and worker, plus the updated backup image.
- Backed up the database and roles before the pre-deploy role switch; migration 0019 applied after the existing 18 migrations.
- Preserved financial record counts and verified ledger balance, invoice allocations, migrated payment origins, restricted database roles, and runtime tenant isolation.
- Hosted health and public routes passed; unauthenticated account access returned 401. Browser checks confirmed the interactive demo and production Clerk sign-in form.
- The worker completed its scheduled 19:30 UTC run successfully with no remaining jobs. Its five-minute cron and the backup job's nightly cron were retained; dev deployment IDs stayed unchanged.
