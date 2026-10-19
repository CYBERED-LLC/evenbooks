import http from 'node:http';
import { logger } from './logger';
import { registerJobs, scheduleTicks } from './jobs';
import { QUEUES } from './queues';
import { dispatchOutbox } from './dispatcher';
import { createRuntime } from './runtime';

/**
 * Evenbooks background worker, long-running mode: outbox dispatch, invoice PDFs,
 * invoice emails, recurring invoice issuance, SimpleFIN sync, maintenance. One
 * process, one PostgreSQL-backed queue (pg-boss), no Redis. Used for local
 * development (`pnpm dev:worker`); production runs `run-once.ts` on a cron.
 */
async function main() {
  const rt = await createRuntime({ schedule: true });
  const { boss, handle, deps } = rt;

  registerJobs(deps);
  await scheduleTicks(boss);

  // Fast outbox loop (every 10s) in addition to the cron safety net.
  const loop = setInterval(() => {
    dispatchOutbox(handle.db, boss).catch((err) => logger.error({ err }, 'outbox loop failed'));
  }, 10_000);
  await dispatchOutbox(handle.db, boss).catch((err) => logger.error({ err }, 'initial outbox dispatch failed'));
  // Kick the ticks once at startup so a restart catches up immediately.
  await boss.send(QUEUES.recurringTick, {}, { singletonKey: 'startup' });
  await boss.send(QUEUES.bankSyncTick, {}, { singletonKey: 'startup' });

  // Liveness endpoint for platform health checks (no company data).
  const port = Number(process.env.PORT ?? 8080);
  const health = http.createServer((req, res) => {
    if (req.url === '/api/health' || req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'evenbooks-worker', storage: deps.storage.driver, email: deps.sender.driver, simplefin: deps.simplefin.driver }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  health.listen(port, () => logger.info({ port }, 'health endpoint listening'));

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    clearInterval(loop);
    health.close();
    await rt.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  logger.info('worker ready');
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
