# Upgrading an existing installation to the Evenbooks names

Fresh installations use `@evenbooks/*` packages, the `evenbooks` development
database, and `evenbooks_owner` / `evenbooks_app` database roles. Follow the
[local setup guide](local-setup.md) for a new installation.

Existing installations need the following steps before starting the renamed
application. These changes are prepared in the repository; they do not rename
hosted resources or change a running database automatically.

1. Back up the database and attachments using the [runbook](runbook.md), then
   stop the web application and worker, including scheduled worker runs.
2. As a database administrator, rename the existing roles. PostgreSQL roles are
   cluster-wide, so coordinate this with any other installation using them.
   Renaming retains ownership and grants; creating replacement roles does not.

   ```sql
   BEGIN;
   ALTER ROLE beans_owner RENAME TO evenbooks_owner;
   ALTER ROLE beans_app RENAME TO evenbooks_app;
   COMMIT;
   ```

   If either destination role already exists, resolve that conflict before
   continuing. Keep the existing passwords.
3. Rename configuration keys without changing their values:

   | Previous key | New key |
   | --- | --- |
   | `BEANS_DB_NAME` | `EVENBOOKS_DB_NAME` |
   | `BEANS_OWNER_PASSWORD` | `EVENBOOKS_OWNER_PASSWORD` |
   | `BEANS_APP_PASSWORD` | `EVENBOOKS_APP_PASSWORD` |
   | `BEANS_SYNC_NO_THROTTLE` (test override) | `EVENBOOKS_SYNC_NO_THROTTLE` |

   Update the usernames in `DATABASE_URL` and `DATABASE_OWNER_URL`, along with
   any references to the old password variables in deployment configuration.
   Keep the database name and password values unchanged. In particular, set
   `EVENBOOKS_DB_NAME` to the existing database name rather than accepting the new
   default. Never run `db:reset` as an upgrade: it deletes the database.
4. Update deployment commands to use `@evenbooks/web`, `@evenbooks/worker`, and
   `@evenbooks/db`. Install the renamed workspace and apply migrations as the
   owner:

   ```sh
   pnpm install --frozen-lockfile
   pnpm db:migrate
   pnpm build
   ```

   Migration `0019_evenbooks.sql` updates the application grants and existing
   payment origins, with tenant isolation kept in place. Earlier SQL migration
   files are unchanged so their recorded checksums remain valid.
5. Start the web application and worker, then check sign-in, reports, invoice
   checkout, and background jobs. Local development users must sign in again
   because the development session cookie has been renamed.

Existing Stripe checkouts and refunds may still send the original metadata
keys. The webhook handler accepts those keys as well as the new `evenbooks_*`
keys, so pending payments and retries can finish. Historical audit events and
provider payloads retain their original contents.

Database names, bucket identifiers, domains, and backup filenames can stay as
they are. Update documentation and service configuration if you rename them;
changing a string in this repository does not rename the resource itself.
