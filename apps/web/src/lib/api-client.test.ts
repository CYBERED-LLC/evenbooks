import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiClientError } from './api-client';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauthenticated = () => json(401, { error: { code: 'unauthenticated', message: 'Sign in required' } });

function stubClerk(getToken: () => Promise<string | null>) {
  vi.stubGlobal('window', { Clerk: { session: { getToken: vi.fn(getToken) } } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api: expired session token', () => {
  it('refreshes the Clerk token once and retries with it', async () => {
    stubClerk(async () => 'fresh-token');
    const fetch = vi.fn().mockResolvedValueOnce(unauthenticated()).mockResolvedValueOnce(json(200, { ok: true }));
    vi.stubGlobal('fetch', fetch);
    await expect(api('/api/things', { companyId: 'c1' })).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![1].headers.authorization).toBe('Bearer fresh-token');
  });

  it('shares one refresh between requests that fail together', async () => {
    let calls = 0;
    stubClerk(async () => `token-${++calls}`);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => ((init.headers as Record<string, string>).authorization ? json(200, {}) : unauthenticated())));
    await Promise.all([api('/a', { companyId: 'c1' }), api('/b', { companyId: 'c1' }), api('/c', { companyId: 'c1' })]);
    expect(calls).toBe(1);
  });

  it('keeps the 401 when there is no session to refresh', async () => {
    stubClerk(async () => null);
    const fetch = vi.fn().mockResolvedValue(unauthenticated());
    vi.stubGlobal('fetch', fetch);
    await expect(api('/api/things', { companyId: 'c1' })).rejects.toMatchObject({ status: 401, code: 'unauthenticated' } satisfies Partial<ApiClientError>);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry without Clerk (dev auth)', async () => {
    const fetch = vi.fn().mockResolvedValue(unauthenticated());
    vi.stubGlobal('fetch', fetch);
    await expect(api('/api/things', { companyId: 'c1' })).rejects.toBeInstanceOf(ApiClientError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
