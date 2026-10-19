import type { Pool } from 'pg';

const RETRYABLE = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '57P03' /* server shutting down or starting */]);
const CONNECTION_MESSAGES = new Set([
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
]);

function retryable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string; errors?: unknown[]; cause?: unknown };
  if (e.code && RETRYABLE.has(e.code)) return true;
  if (!e.code && e.message && CONNECTION_MESSAGES.has(e.message)) return true;
  // pg-pool wraps parallel connection attempts (IPv6 + IPv4) in an AggregateError
  return (Array.isArray(e.errors) && e.errors.some(retryable)) || retryable(e.cause);
}

/**
 * Wait until the database accepts connections. Serverless databases (Railway
 * "sleep when idle") wake on the first packet but take several seconds; the
 * first attempts time out or are refused. Call this before application work;
 * only the read-only probe is retried, never a business query or transaction.
 * Pools should also set connectionTimeoutMillis to bound each attempt.
 */
export async function waitForDatabase(pool: Pool, opts: { timeoutMs?: number; log?: (msg: string) => void } = {}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await pool.query('select 1');
      if (attempt > 1) opts.log?.(`database reachable after ${attempt} attempts`);
      return;
    } catch (err) {
      const remaining = deadline - Date.now();
      if (!retryable(err) || remaining <= 0) throw err;
      const wait = Math.min(1000 * attempt, 5000, remaining);
      opts.log?.(`database not reachable yet (${(err as { code?: string }).code ?? 'error'}); retrying in ${wait} ms`);
      await new Promise((r) => setTimeout(r, wait));
      if (Date.now() >= deadline) throw err;
    }
  }
}
