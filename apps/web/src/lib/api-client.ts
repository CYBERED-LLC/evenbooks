export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** The company the caller believes is active; server rejects a mismatch. */
  companyId: string;
  signal?: AbortSignal;
  query?: Record<string, string | number | boolean | undefined | null>;
}

function buildUrl(path: string, query?: ApiOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

interface ClerkGlobal {
  session?: { getToken(opts?: { skipCache?: boolean }): Promise<string | null> } | null;
}

let refreshing: Promise<string | null> | null = null;

/**
 * A fresh Clerk session token, or null without a Clerk session (dev auth, signed out).
 * Clerk's tokens live about a minute and are renewed by a timer that browsers pause
 * in background tabs, so a tab coming back can send an expired cookie. Concurrent
 * callers (every query refetching on focus) share one refresh.
 */
function refreshSessionToken(): Promise<string | null> {
  const clerk = typeof window === 'undefined' ? undefined : (window as unknown as { Clerk?: ClerkGlobal }).Clerk;
  if (!clerk?.session) return Promise.resolve(null);
  refreshing ??= clerk.session
    .getToken({ skipCache: true })
    .catch(() => null)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function api<T>(path: string, opts: ApiOptions): Promise<T> {
  const send = (token?: string) =>
    fetch(buildUrl(path, opts.query), {
      method: opts.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        'x-company-id': opts.companyId,
        // The refreshed token also updates the cookie; sending it as well avoids racing that write.
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
      credentials: 'same-origin',
    });
  let res = await send();
  // An expired session token is rejected before the handler runs, so one retry is safe for writes too.
  if (res.status === 401) {
    const token = await refreshSessionToken();
    if (token) res = await send(token);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as { error?: { code: string; message: string; details?: unknown; requestId?: string } }) : undefined;
  if (!res.ok) {
    const e = data?.error;
    throw new ApiClientError(res.status, e?.code ?? 'http_error', e?.message ?? res.statusText, e?.details, e?.requestId);
  }
  return data as T;
}

/** Generate a client-side idempotency key for a financial command. */
export function idempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
