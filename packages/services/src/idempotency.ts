import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { ServiceError } from './errors';
import type { ServiceContext } from './context';

/**
 * Idempotent financial commands. The first call with a key executes `fn` and
 * stores its result; later calls with the same key and payload return the
 * stored result. A different payload under the same key is rejected.
 *
 * Runs inside the caller's transaction: the key row and the financial change
 * commit together, so a retry after a crash re-executes cleanly.
 */
export async function idempotent<T>(
  s: ServiceContext,
  key: string | undefined,
  payload: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  if (!key) return fn();
  const requestHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const [existing] = await s.tx
    .select()
    .from(schema.idempotencyKeys)
    .where(and(eq(schema.idempotencyKeys.companyId, s.ctx.companyId), eq(schema.idempotencyKeys.key, key)))
    .limit(1)
    .for('update');
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new ServiceError('conflict', 'This was already submitted with different details. Reload the page and try again.');
    }
    if (existing.status === 'completed') return existing.response as T;
    // in_progress within a committed row means a previous attempt crashed after
    // inserting the key but before completing; that cannot happen because both
    // are in one transaction — treat as replay-safe re-execution.
  } else {
    await s.tx.insert(schema.idempotencyKeys).values({ companyId: s.ctx.companyId, key, requestHash, status: 'in_progress' });
  }
  const result = await fn();
  await s.tx
    .update(schema.idempotencyKeys)
    .set({ status: 'completed', response: result as never })
    .where(and(eq(schema.idempotencyKeys.companyId, s.ctx.companyId), eq(schema.idempotencyKeys.key, key)));
  return result;
}
