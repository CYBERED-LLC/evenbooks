# Evenbooks runbook

For existing installations, follow the [name upgrade guide](name-upgrade.md)
before changing database roles, environment variables, or deployment commands.

Operational notes for deploying, running, backing up and restoring Evenbooks. Everything here was exercised locally against PostgreSQL 15 with the local storage/email/SimpleFIN adapters; the Railway, SES and SimpleFIN *live* integrations have not been exercised from this repository (see `docs/verification.md`).

## 1. Components

| Service | Command | Notes |
| --- | --- | --- |
| `web` | `pnpm --filter @evenbooks/web start` (after `pnpm --filter @evenbooks/web build`) | Next.js 16 App Router. Health: `GET /api/health`. |
| `worker` | `pnpm --filter @evenbooks/worker start` (daemon) or `start:once` (one pass, for a cron) | pg-boss queue in schema `pgboss`; outbox dispatch, PDFs, email, recurring invoices, SimpleFIN sync, maintenance. Railway runs `start:once` every 5 minutes. |
| PostgreSQL 15+ | Railway Postgres or any managed instance | Extensions: `btree_gist`. |
| Object storage | Railway bucket (S3-compatible) or local disk | Receipts, invoice PDFs, CSV originals. Never public. |
| Amazon SES | existing verified sender | Invoice emails; delivery events via SNS → `/api/webhooks/ses`. |
| Clerk | Organizations enabled | One organization = one company. |

## 2. Environment variables

See `.env.example` for the full list with comments. Production must set:

- `APP_ENV=production` (refuses dev auth), `AUTH_MODE=clerk`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET` (optional but recommended).
- `DATABASE_URL` (role `evenbooks_app`), `DATABASE_OWNER_URL` (role `evenbooks_owner`, used only for migrations).
- `APP_ENCRYPTION_KEY` (32 random bytes, base64). Encrypts SimpleFIN access URLs and public-invoice tokens. **Keep a copy outside the database backups** (password manager / secrets vault). Losing it means every bank connection must be reconnected and public invoice links regenerated; nothing financial is lost.
- `PUBLIC_BASE_URL` (used in emails and public links).
- `STORAGE_DRIVER=s3` plus `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (Railway bucket variables map 1:1: `ENDPOINT`, `BUCKET`, `REGION`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`).
- `EMAIL_DRIVER=ses`, `SES_REGION`, `SES_FROM_ADDRESS`, `SES_REPLY_TO`, `SES_CONFIGURATION_SET`, AWS credentials, `SES_SNS_TOPIC_ARN`.
- `SIMPLEFIN_DRIVER=live`.
- `PAYMENTS_DRIVER=stripe`, `STRIPE_SECRET_KEY` (platform account, `sk_live_…`), `STRIPE_WEBHOOK_SECRET` (Connect endpoint for `/api/webhooks/stripe`), `STRIPE_CONNECT_CLIENT_ID` (Connect OAuth client id; without it only new accounts can be created), `STRIPE_OAUTH_SECRET_KEY` (full `sk_…` key used only to exchange OAuth codes; required when `STRIPE_SECRET_KEY` is a restricted key), optional all-in fee settings `PLATFORM_FEE_CARD_PERCENT` (5), `PLATFORM_FEE_ACH_PERCENT` (1) and Stripe's published schedule `PROCESSOR_CARD_FEE_PERCENT` (2.9), `PROCESSOR_CARD_FEE_FIXED` (0.30), `PROCESSOR_ACH_FEE_PERCENT` (0.8), `PROCESSOR_ACH_FEE_CAP` (5). `CLERK_PAID_PLAN_SLUGS` (default `paid,pro`) names the Clerk Billing organization plans that count as the paid tier. `PAYMENTS_DRIVER=fixture` is refused in production.

## 3. Database roles and first deployment

1. Create the database (Railway: `railway add --database postgres`).
2. Bootstrap roles once, as the superuser Railway provides (`DATABASE_URL` of the Postgres service):
   ```bash
   DATABASE_ADMIN_URL="postgres://postgres:...@host:port/railway" \
   EVENBOOKS_DB_NAME=railway EVENBOOKS_OWNER_PASSWORD=<strong> EVENBOOKS_APP_PASSWORD=<strong> \
   pnpm --filter @evenbooks/db bootstrap
   ```
   This creates `evenbooks_owner` (owns objects, `NOSUPERUSER`), `evenbooks_app` (`NOBYPASSRLS`, no DDL), hands `public` to the owner, creates the `pgboss` schema owned by `evenbooks_app`, and installs `btree_gist`.
3. Run migrations as the owner: `DATABASE_OWNER_URL=postgres://evenbooks_owner:...@host/railway pnpm --filter @evenbooks/db migrate`. Migrations are explicit SQL files applied in order; a modified historical file is refused. Run this on every deploy before starting `web`/`worker` (Railway: use a pre-deploy command on the web service).
4. Set `DATABASE_URL` for `web` and `worker` to the `evenbooks_app` connection string.

## 4. Railway layout

The hosted Evenbooks deployment keeps its project details (ids, environments, domains) in `docs/railway.md`, which is not part of the public source; its service settings live in the gitignored `.railway/railway.ts`.

Two services from the same repository (root directory `/`, builder Railpack), one Postgres, one bucket.

| Service | Build | Pre-deploy | Start | Health |
| --- | --- | --- | --- | --- |
| web | `pnpm install --frozen-lockfile && pnpm --filter @evenbooks/web build` | `pnpm --filter @evenbooks/db migrate` | `pnpm --filter @evenbooks/web start` | `/api/health` |
| worker | `pnpm install --frozen-lockfile` | — | `pnpm --filter @evenbooks/worker start:once` on cron `*/5 * * * *` (or `start` as an always-on service) | each run logs `run complete`; `/settings/jobs` shows the heartbeat |

Shared variables: `DATABASE_URL=${{Postgres.DATABASE_URL}}` **replaced** by the `evenbooks_app` URL after bootstrap; bucket variables via references (`${{bucket.ENDPOINT}}` etc.). Railway's config-as-code (`railway.json`) is deprecated as of 2026 with a hard cutoff on 2026-12-01; configure services in the dashboard or with `railway environment edit --service-config`. Example CLI sequence:

```bash
railway init
railway add --database postgres
railway bucket create evenbooks-files --region iad
railway add --service web --repo <owner>/<repo>
railway add --service worker --repo <owner>/<repo>
railway environment edit --service-config web build.buildCommand "pnpm install --frozen-lockfile && pnpm --filter @evenbooks/web build"
railway environment edit --service-config web deploy.preDeployCommand "pnpm --filter @evenbooks/db migrate"
railway environment edit --service-config web deploy.startCommand "pnpm --filter @evenbooks/web start"
railway environment edit --service-config web deploy.healthcheckPath "/api/health"
railway environment edit --service-config worker deploy.startCommand "pnpm --filter @evenbooks/worker start"
railway variable set APP_ENV=production AUTH_MODE=clerk ... -s web
railway variable set APP_ENV=production ... -s worker
railway domain -s web
```

Node 22+ is required (`engines` in `package.json`). `next build` needs the Clerk publishable key at build time in Clerk mode.

## 5. Clerk

- Enable Organizations; default roles `org:admin` → Evenbooks admin, everything else → member. Turn on forced organization selection as well (`clerk enable orgs`).
- Session token claim `org_name: {{org.name}}` (set on the dev instance with `clerk config patch --json '{"session":{"claims":{"org_name":"{{org.name}}"}}}'`; repeat with `--instance prod` for production). The app falls back to the Backend API when the claim is missing, so a new company is named after its organization either way.
- Everything above is scriptable with the Clerk CLI from `apps/web` (`clerk link --app …`, `clerk env pull`, `clerk config pull/patch`). Dev instance only so far; `clerk deploy` creates the production instance, which needs its own Google OAuth credentials (the dev instance uses Clerk's shared ones).
- Test accounts: any `*+clerk_test@example.com` address verifies with code `424242` on the dev instance. Bot protection (Turnstile) blocks headless sign-up; disable it temporarily with `clerk config patch --json '{"auth_attack_protection":{"bot_protection":{"captcha_enabled":false}}}'` and re-enable afterwards.
- Webhook endpoint: `POST https://<domain>/api/webhooks/clerk` subscribed to `organization.created` and `organization.updated` (signing secret in `CLERK_WEBHOOK_SIGNING_SECRET`). The app also provisions companies lazily on first visit, so the webhook is an optimization.
- Deleting an organization does **not** delete its books.

### Plans and team limits
Set up on 2026-09-25 on both instances (production and dev) through the instance config, and tested end to end on dev with Clerk's test card (subscribe → company `paid`, Clerk membership limit 20; end subscription → `free`, limit 1):

- Billing for organizations is on (`billing.organization_enabled`; production was enabled in the Dashboard, where the Stripe account is connected). Plans: `free_org` (default, $0) and `paid` ("Paid", $15.00/month, $150.00/year = 1250 cents annual_monthly_amount, payer `org`) with the features `team_members_20`, `no_platform_fee`, `email_support`. They are edited with `clerk config patch --instance <ins> --file billing.json` (`billing.plans.<slug>` and `billing.features.<slug>`; amounts in cents). On an instance where Billing is off, enable it in one patch and add plans in a second one (the free plan does not exist until then).
- Production `web`: `CLERK_PAID_PLAN_SLUGS=paid`, `CLERK_FREE_PLAN_MEMBERS=1`, `CLERK_PAID_PLAN_MEMBERS=20`.
- Admins subscribe, switch between monthly and annual, and cancel on **Settings → Plan and billing** (`/settings/billing`, Clerk's `<PricingTable for="organization">`). The app reads the plan on each signed-in request, so the change shows on the next page load. A subscription ended in Clerk moves the company back to free the same way.
- The instance default membership limit is 1 (the free tier) on both instances. To set it again: Dashboard (Organizations → Default membership limit) or
  ```bash
  curl -X PATCH -H "Authorization: Bearer $CLERK_SECRET_KEY" -H 'content-type: application/json' \
    -d '{"max_allowed_memberships":1}' https://api.clerk.com/v1/instance/organization_settings
  ```
- The app raises a company's limit to `CLERK_PAID_PLAN_MEMBERS` (20) when its plan becomes paid and lowers it again on downgrade. Existing members are never removed by a lower limit; further invitations are refused until the team shrinks or the plan is upgraded.
- If a limit sync fails (logged as `could not sync clerk membership limit`), set it by hand on the organization in the Dashboard.

## 6. SES

- Verified sender identity already exists; set `SES_FROM_ADDRESS` to it and `SES_REPLY_TO` to the mailbox that should receive replies.
- Follow [SES/SNS topic setup](../ops/email/sns-topic.md), including the topic policy and the ARN on both web and worker. The webhook fails closed with 503 when no topic is configured. Create a configuration set with an SNS event destination (Send, Delivery, Bounce, Complaint, Reject, DeliveryDelay) and an HTTPS subscription to `https://<domain>/api/webhooks/ses`. The endpoint confirms the subscription automatically and rejects messages whose `TopicArn` differs from `SES_SNS_TOPIC_ARN`.
- Permanent bounces and complaints add the address to the company's suppression list; sends to suppressed addresses are recorded as `suppressed` and never sent. Remove a suppression from the invoice's email history once the address is fixed.
- Ambiguous outcomes: a message stuck in `sending` for more than 10 minutes (crash between the SES call and recording the result) is flipped to `uncertain` by the maintenance job and shown on `/settings/jobs`. Check the SES console for the message before resending.

## 7. SimpleFIN

- Users paste a setup token from SimpleFIN Bridge; it is claimed once and only the access URL is stored, encrypted with `APP_ENCRYPTION_KEY`.
- Polling: every `syncIntervalMinutes` (default 6h), picked up by the first worker run at or after `next_sync_at` (the cron runs every 5 minutes), 5-day overlap, 89-day cap, never more than once per 15 minutes per connection. Bridge asks for ≤ 24 requests/day per access; the defaults use 4. The first sync after an account is linked pulls the full 60-day initial window even if the connection already synced (the worker usually polls before accounts are linked); windows longer than 45 days are fetched in 45-day chunks because Bridge warns above that.
- HTTP 403 → connection `revoked` (reconnect with a new token); 402 → payment required; 3 consecutive other failures → `error` with exponential backoff. All visible on `/banking` and `/settings/jobs`.
- Only hosts in `SIMPLEFIN_ALLOWED_HOSTS` over HTTPS are contacted; redirects are not followed.

## 8. Backups

**Database.** Two layers in production, both since 2026-09-25:

1. Railway volume snapshots of the production Postgres volume: daily (kept 6 days), weekly (27 days), monthly (89 days). Enabled through the GraphQL API (`volumeInstanceBackupScheduleUpdate(volumeInstanceId: "<volume instance id>", kinds: [DAILY, WEEKLY, MONTHLY])`); the CLI has no command for it. Restore from the Postgres service's Backups tab.
2. A nightly logical dump by the `db-backup` cron in production (private network only), stored in the bucket of the Railway environment `backup`, verified by a test restore on every run and kept 35 days daily + 400 days monthly in a bucket in another region. The job is `ops/backup/backup.sh`.

To take a dump by hand:

```bash
pg_dump --format=custom --no-owner --no-privileges --no-comments --exclude-schema=pgboss "$DATABASE_OWNER_URL" > evenbooks-$(date +%F).dump
```

**Objects.** The nightly job also copies the production bucket into the backup bucket. By hand, sync the bucket to a second bucket (or local disk) with the AWS CLI against the Railway endpoint:

```bash
AWS_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY \
aws s3 sync s3://$S3_BUCKET ./objects-backup --endpoint-url $S3_ENDPOINT
```

**Secrets.** `APP_ENCRYPTION_KEY`, Clerk keys, AWS keys and the two database role passwords live in the secrets manager, **not** in the dump.

## 9. Restore exercise (verified locally)

Script: `scripts/restore-exercise.sh` performs the following against a fresh database and a fresh storage directory and checks the ledger:

1. `pg_dump` the source database (custom format).
2. Create a new database, bootstrap roles, `pg_restore --no-owner --no-privileges` as `evenbooks_owner`.
3. Re-apply `GRANT`s: `select app.grant_app_privileges();` (roles are cluster-level and not part of the dump).
4. Copy the object store (local: `rsync`; S3: `aws s3 sync`).
5. Verify: every posted entry balances, `account_balances` sums to zero across the trial balance, attachment objects referenced by `attachments` exist, and a sample invoice PDF downloads through the app.

Run it: `./scripts/restore-exercise.sh` (needs `DATABASE_ADMIN_URL`). Output of the last local run is recorded in `docs/verification.md`.

## 10. Day-2 operations

- **Dead jobs**: `/settings/jobs` lists failed jobs (with output) for the company; pg-boss keeps them in `pgboss.job` (state `failed`) and moves exhausted retries to the `dead-letter` queue. Re-run by fixing the cause and re-queuing from psql (`select pgboss.send(...)`) or by re-triggering the user action (e.g. Resend email).
- **Stale sync**: connections without a success in 2 intervals are flagged on `/banking` and `/settings/jobs`.
- **Worker down**: heartbeat older than 15 minutes on `/settings/jobs` (the cron writes one per 5-minute run). Check the worker service's cron runs in Railway (a failed run exits non-zero and is not retried until the next tick); the outbox and queue are durable, nothing is lost. A run that exceeds its 4-minute budget logs `time budget spent` and the next tick continues.
- **Period close**: close periods after reconciliation; reopening is audited.
- **Cash recognition integrity**: `pnpm --filter @evenbooks/db exec tsx scripts/verify-recognition.ts` recomputes cash recognition totals from source documents and reports drift (see `docs/verification.md`).
- **Logs**: structured JSON (pino) from both services; secrets and tokens are redacted by path. Request ids are returned in API errors (`requestId`) and logged.

## 11. Stripe (online payments)

Design and accounting treatment: `docs/payments-plan.md`. Evenbooks is a Connect **platform**; each company connects its own **Standard** account and charges are made directly on it.

**One-time platform setup**
1. In the Stripe Dashboard enable Connect and complete the platform profile (software platform; users are US businesses collecting invoice payments; the platform does not hold funds; Standard accounts). Stripe may review the profile.
2. Create a **Connect** webhook endpoint (listen to events on connected accounts) pointing at `https://<host>/api/webhooks/stripe` with these events: `account.updated`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.updated` (Stripe attaches the fees here, seconds after the charge succeeds), `charge.refunded`, `charge.dispute.created`, `charge.dispute.funds_withdrawn`, `charge.dispute.closed`, `charge.dispute.funds_reinstated`, `payout.created`, `payout.updated`, `payout.paid`, `payout.failed`, `payout.canceled`, `account.application.deauthorized`. Copy its signing secret to `STRIPE_WEBHOOK_SECRET`.
3. Set `PAYMENTS_DRIVER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` on `web` (the worker references them). In production the driver rejects test-mode events.
4. To let businesses link a Stripe account they already have: Dashboard → Settings → Connect → Onboarding options → OAuth, turn on "OAuth for Stripe Dashboard accounts", add the redirect URI `https://<host>/api/processor/connection/link/callback`, and set `STRIPE_CONNECT_CLIENT_ID` to the client id shown there (test and live ids differ). If `STRIPE_SECRET_KEY` is restricted, also set `STRIPE_OAUTH_SECRET_KEY`.

**First live check (Stripe test mode first)**: connect from `/settings/payments` with `sk_test_…`, finish hosted onboarding with Stripe's test data, issue an invoice, open its public link, pay with card `4242 4242 4242 4242`, confirm the payment and fee entry in the books, refund part of it from the invoice page, then trigger a test payout from the Stripe dashboard and check `/settings/payments` shows the payout posted and the clearing balance at zero. Locally, `stripe listen --forward-to localhost:3000/api/webhooks/stripe` forwards events.

**Day 2**
- `/settings/jobs` lists provider events whose processing failed; the worker retries them up to 12 times. Fix the cause (usually a closed period or a missing bank account for payouts) and the next retry posts.
- A company with no payout bank account configured gets payouts recorded but not posted; set the account in `/settings/payments` and match the bank line by hand for older payouts.
- The clearing account (“Stripe balance”) should equal the balance shown in the company's Stripe dashboard after each payout; a difference points at an unprocessed event.
- Refunds must go through Evenbooks or the Stripe dashboard, never by voiding the payment in the books (blocked).
- Fee configuration changes (`PLATFORM_FEE_*`, `PROCESSOR_*`) apply to new checkouts only; the fee for each charge is fixed when the session is created. If Stripe changes its published rates, update the `PROCESSOR_*` values so the all-in promise holds.
- Plans: create the paid plan(s) in Clerk Billing for organizations and list their slugs in `CLERK_PAID_PLAN_SLUGS`; the tier syncs into the company on the next signed-in request. `/settings/payments` shows which tier the company is on.
