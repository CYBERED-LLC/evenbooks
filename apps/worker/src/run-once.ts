import { logger } from './logger';
import { runOnce } from './once';
import { createRuntime } from './runtime';

/**
 * Cron entrypoint: do one pass of the worker's duties and exit. Railway runs
 * this every 5 minutes (`deploy.cronSchedule` in `.railway/railway.ts`) and
 * skips a tick while the previous run is still active, so the run keeps a
 * time budget well under the interval.
 */
async function main() {
  const rt = await createRuntime({ schedule: false });
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'run interrupted; finishing active jobs');
    await rt.close({ graceful: true, timeout: 20_000 }).catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  const maxMs = Number(process.env.WORKER_RUN_BUDGET_MS ?? 4 * 60_000);
  try {
    await runOnce(rt.deps, { maxMs, concurrency: rt.env.concurrency });
  } finally {
    if (!stopping) await rt.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.fatal({ err }, 'worker run failed');
    process.exit(1);
  });
