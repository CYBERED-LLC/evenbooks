import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForDatabase } from '../src/wake';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const connectionError = (code: string) => Object.assign(new Error('Database unavailable'), { code });
const probePool = (query: ReturnType<typeof vi.fn>) => ({ query }) as unknown as Pool;

describe('database wake-up', () => {
  it('recovers from the parallel IPv6 timeout and IPv4 refusal seen on a cold Railway database', async () => {
    const failure = new AggregateError([connectionError('ETIMEDOUT'), connectionError('ECONNREFUSED')]);
    const query = vi.fn().mockRejectedValueOnce(failure).mockRejectedValueOnce(connectionError('57P03')).mockResolvedValue({ rows: [] });
    const ready = waitForDatabase(probePool(query));
    await vi.runAllTimersAsync();
    await ready;
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.every(([sql]) => sql === 'select 1')).toBe(true);
  });

  it.each([
    new Error('Connection terminated due to connection timeout'),
    new Error('timeout exceeded when trying to connect'),
    new Error('Connection terminated unexpectedly'),
    new Error('Wrapped connection failure', { cause: connectionError('ECONNRESET') }),
  ])('recovers when pg reports %s', async (failure) => {
    const query = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ rows: [] });
    const ready = waitForDatabase(probePool(query));
    await vi.runAllTimersAsync();
    await ready;
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each(['28P01', '42501', '57014'])('fails immediately for authentication, permission or statement errors (%s)', async (code) => {
    const failure = connectionError(code);
    const query = vi.fn().mockRejectedValue(failure);
    await expect(waitForDatabase(probePool(query))).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops at the retry deadline when the database stays unavailable', async () => {
    const failure = connectionError('ECONNREFUSED');
    const query = vi.fn().mockRejectedValue(failure);
    const start = Date.now();
    const result = expect(waitForDatabase(probePool(query), { timeoutMs: 2500 })).rejects.toBe(failure);
    await vi.runAllTimersAsync();
    await result;
    expect(Date.now() - start).toBe(2500);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
