# Local setup

For existing installations, follow the [name upgrade guide](name-upgrade.md)
before changing database roles, environment variables, or deployment commands.

## Prerequisites
- Node 22+ (24 used in development), pnpm 10 (`corepack enable`).
- PostgreSQL 15+ running locally with a superuser you can connect as (Debian: `apt install postgresql-15`, then `sudo -u postgres createuser -s $USER`).
- No Clerk, AWS or SimpleFIN credentials are needed locally: the app runs with the dev auth adapter, the log email transport, the fixture bank feed and disk storage.

## First run
```bash
pnpm install
cp .env.example .env          # edit DATABASE_ADMIN_URL to your superuser; keep AUTH_MODE=dev
openssl rand -base64 32       # paste into APP_ENCRYPTION_KEY in .env
pnpm db:reset                 # creates roles evenbooks_owner/evenbooks_app, database `evenbooks`, runs migrations
pnpm db:seed                  # demo data for the two dev companies (SEED_SCALE=12000 for the performance dataset)
pnpm dev                      # web on http://localhost:3000 (dev sign-in page picks a user/company/role)
pnpm dev:worker               # background worker, long-running (PDFs, emails to the log, recurring, fixture bank sync)
# pnpm --filter @evenbooks/worker start:once   # one pass and exit, the mode Railway runs on a 5-minute cron
```

Sign in at `/dev-login`, choose *Alpha Consulting LLC* or *Beta Design Studio*; switch companies from the sidebar select. Admin and member roles are both available.

## Everyday commands
| Command | What it does |
| --- | --- |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm lint` | ESLint (TypeScript recommended + React hooks) |
| `pnpm test` | Vitest: domain unit tests, database/RLS tests, service integration tests, worker tests (each creates throwaway databases via `TEST_DATABASE_ADMIN_URL`) |
| `pnpm test:e2e` | Playwright against the running dev server (`pnpm dev` first) |
| `pnpm build` | Production build of the web app (`next build`) and typecheck of the worker |
| `pnpm db:migrate` | Apply pending SQL migrations as `evenbooks_owner` |
| `pnpm --filter @evenbooks/db exec tsx scripts/verify-recognition.ts` | Re-derive cash recognition and report drift |
| `./scripts/restore-exercise.sh` | Dump, restore into a fresh database, verify ledger + attachments |

## Layout
- `packages/domain` — money, ledger, invoice arithmetic, settlement allocation, schedules, CSV normalization (pure, no I/O).
- `packages/db` — SQL migrations, migration runner, roles bootstrap, tenant-scoped transactions, drizzle schema mirror, test database helpers, scripts (`reset`, `seed`, `migrate`, `verify-recognition`).
- `packages/contracts` — zod DTOs shared by API and UI.
- `packages/services` — all business behavior (posting, documents, settlements, imports, inbox, reconciliation, recurring, sync, reports, email). Route handlers and worker jobs call these; nothing else writes to the ledger.
- `packages/integrations` — storage (local/S3), email (log/SES), PDF (pdfkit), SimpleFIN (fixture/live), crypto.
- `apps/web` — Next.js 16 App Router UI + API routes; `apps/web/e2e` Playwright specs.
- `apps/worker` — pg-boss worker: outbox dispatch, PDFs, email, recurring issuance, bank sync, maintenance.
- `docs/` — decisions, financial policy, runbook, verification evidence, limitations, UI conventions.

## Tests in one line
`pnpm typecheck && pnpm lint && pnpm test && pnpm build` then, with the dev server running, `pnpm test:e2e`.
