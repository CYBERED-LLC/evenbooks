import { PgBoss } from 'pg-boss';
import { connect, needsSsl, waitForDatabase, type DbHandle } from '@evenbooks/db';
import { createEmailSenderFromEnv, createEmailIdentityManagerFromEnv, createPaymentProcessorFromEnv, createSimpleFinClientFromEnv, createStorageFromEnv, emailConfigFromEnv } from '@evenbooks/integrations';
import { platformFeeConfigFromEnv } from '@evenbooks/domain';
import { workerEnv, type WorkerEnv } from './env';
import { logger } from './logger';
import { ensureQueues } from './queues';
import type { WorkerDeps } from './jobs';

export interface WorkerRuntime {
  env: WorkerEnv;
  handle: DbHandle;
  boss: PgBoss;
  deps: WorkerDeps;
  /** Stop pg-boss (waiting for active jobs) and close the database pool. */
  close: (opts?: { graceful?: boolean; timeout?: number }) => Promise<void>;
}

/**
 * Everything the worker needs, wired from the environment: database handle,
 * pg-boss instance and integration clients. Shared by the long-running
 * process (`main.ts`) and the one-shot cron entrypoint (`run-once.ts`).
 *
 * `schedule` controls pg-boss's own cron scheduler; the one-shot mode drives
 * the ticks itself and leaves it off.
 */
export async function createRuntime(opts: { schedule: boolean }): Promise<WorkerRuntime> {
  const env = workerEnv();
  const ssl = needsSsl(env.databaseUrl) ? { rejectUnauthorized: false } : undefined;
  const handle = connect({ connectionString: env.databaseUrl, applicationName: 'evenbooks-worker', max: Math.max(4, env.concurrency + 2), ssl });
  // A serverless database (dev sleeps when idle) refuses the first connections while it wakes.
  await waitForDatabase(handle.pool, { log: (m) => logger.info(m) });
  const boss = new PgBoss({ connectionString: env.databaseUrl, schema: 'pgboss', application_name: 'evenbooks-worker-boss', ssl, schedule: opts.schedule } as ConstructorParameters<typeof PgBoss>[0]);
  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
  await boss.start();
  await ensureQueues(boss);

  const storage = createStorageFromEnv();
  const sender = createEmailSenderFromEnv(process.env, (msg, meta) => logger.info(meta, msg));
  const simplefin = createSimpleFinClientFromEnv();
  const processor = createPaymentProcessorFromEnv();
  logger.info({ storage: storage.driver, email: sender.driver, simplefin: simplefin.driver, payments: processor.driver, concurrency: env.concurrency, mode: opts.schedule ? 'daemon' : 'once' }, 'worker starting');

  const deps: WorkerDeps = { db: handle.db, boss, storage, sender, emailConfig: emailConfigFromEnv(), identities: await createEmailIdentityManagerFromEnv(), simplefin, processor, feeConfig: platformFeeConfigFromEnv(), publicBaseUrl: env.publicBaseUrl };
  return {
    env,
    handle,
    boss,
    deps,
    close: async ({ graceful = true, timeout = 30_000 } = {}) => {
      await boss.stop({ graceful, timeout, close: true });
      await handle.close();
    },
  };
}
