import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), wait: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@evenbooks/db', () => ({ connect: mocks.connect, waitForDatabase: mocks.wait, needsSsl: () => false }));
vi.mock('./env', () => ({ env: () => ({ databaseUrl: 'postgres://localhost/evenbooks_test' }) }));
vi.mock('./logger', () => ({ logger: { info: vi.fn() } }));

import { getReadyDb } from './db';

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.__evenbooksDb = undefined;
  globalThis.__evenbooksDbReady = undefined;
  mocks.connect.mockReturnValue({ pool: {}, db: {}, close: vi.fn() });
  mocks.wait.mockResolvedValue(undefined);
});

describe('web database readiness', () => {
  it('makes concurrent requests wait for one shared wake-up probe', async () => {
    let resolve!: () => void;
    mocks.wait.mockReturnValue(new Promise<void>((done) => { resolve = done; }));
    let returned = false;
    const first = getReadyDb().then((db) => { returned = true; return db; });
    const second = getReadyDb();
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(mocks.wait).toHaveBeenCalledTimes(1);
    resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });

  it('checks readiness again on a later visit after the database can have slept', async () => {
    const first = await getReadyDb();
    await getReadyDb();
    expect(mocks.wait).toHaveBeenCalledTimes(2);
    expect(mocks.wait).toHaveBeenLastCalledWith(first.pool, expect.objectContaining({ timeoutMs: 30_000 }));
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ connectionTimeoutMillis: 10_000 }));
  });

  it('allows a subsequent request to recover after a failed wake-up', async () => {
    const failure = new Error('Database still unavailable');
    mocks.wait.mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const first = getReadyDb();
    const second = getReadyDb();
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    await expect(getReadyDb()).resolves.toBe(globalThis.__evenbooksDb);
    expect(mocks.wait).toHaveBeenCalledTimes(2);
  });
});
