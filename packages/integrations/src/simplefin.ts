/**
 * SimpleFIN client (protocol v1/v2, beta-bridge.simplefin.org).
 *
 * Security notes:
 *  - Setup tokens are base64 claim URLs; we decode, validate the host against an
 *    allowlist, POST once, and keep only the returned access URL (encrypted by
 *    the caller). Claims cannot be repeated.
 *  - All requests: HTTPS only, allowlisted hosts, redirects disabled, timeouts.
 *  - Amounts are kept as decimal strings; `posted` is unix seconds (0 = pending).
 */
export interface SimpleFinTransaction {
  id: string;
  /** YYYY-MM-DD in UTC of the posted timestamp; pending items use transacted_at or today. */
  date: string;
  postedAt: number | null;
  transactedAt: number | null;
  amount: string;
  description: string;
  payee: string | null;
  memo: string | null;
  pending: boolean;
  raw: Record<string, unknown>;
}

export interface SimpleFinAccount {
  id: string;
  name: string;
  orgName: string | null;
  orgDomain: string | null;
  currency: string;
  balance: string | null;
  availableBalance: string | null;
  balanceDate: number | null;
  transactions: SimpleFinTransaction[];
}

export interface SimpleFinAccountsResponse {
  accounts: SimpleFinAccount[];
  errors: string[];
}

export class SimpleFinError extends Error {
  constructor(
    message: string,
    public readonly kind: 'invalid_token' | 'claim_failed' | 'auth_revoked' | 'payment_required' | 'rate_limited' | 'network' | 'protocol' | 'unsafe_url',
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'SimpleFinError';
  }
}

export interface SimpleFinClient {
  readonly driver: 'live' | 'fixture';
  claimSetupToken(setupToken: string): Promise<string>;
  fetchAccounts(accessUrl: string, opts: { startDate?: Date; endDate?: Date; pending?: boolean; accountIds?: string[] }): Promise<SimpleFinAccountsResponse>;
}

const DEFAULT_ALLOWED_HOSTS = ['beta-bridge.simplefin.org', 'bridge.simplefin.org'];

export function allowedHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.SIMPLEFIN_ALLOWED_HOSTS ?? DEFAULT_ALLOWED_HOSTS.join(',')).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

function assertSafeUrl(raw: string, allowedHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SimpleFinError('Malformed URL', 'unsafe_url');
  }
  if (url.protocol !== 'https:') throw new SimpleFinError('Only https URLs are allowed', 'unsafe_url');
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.includes(host)) throw new SimpleFinError(`Host ${host} is not an allowed SimpleFIN host`, 'unsafe_url');
  if (/^(\d+\.){3}\d+$/.test(host) || host === 'localhost' || host.endsWith('.local')) throw new SimpleFinError('Private or numeric hosts are not allowed', 'unsafe_url');
  return url;
}

function toDateString(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function parseAccounts(json: unknown): SimpleFinAccountsResponse {
  const root = (json ?? {}) as Record<string, unknown>;
  const errors = Array.isArray(root.errors) ? (root.errors as unknown[]).map(String) : [];
  const errlist = Array.isArray(root.errlist) ? (root.errlist as { msg?: string; code?: string }[]).map((e) => `${e.code ?? 'err'}: ${e.msg ?? ''}`) : [];
  const accountsRaw = Array.isArray(root.accounts) ? (root.accounts as Record<string, unknown>[]) : [];
  const connections = Array.isArray(root.connections) ? (root.connections as { conn_id?: string; name?: string }[]) : [];
  const connName = new Map(connections.map((c) => [String(c.conn_id ?? ''), c.name ?? null]));
  const accounts: SimpleFinAccount[] = accountsRaw.map((a) => {
    const org = (a.org ?? {}) as { name?: string; domain?: string };
    const txns = Array.isArray(a.transactions) ? (a.transactions as Record<string, unknown>[]) : [];
    return {
      id: String(a.id ?? ''),
      name: String(a.name ?? 'Account'),
      orgName: org.name ?? (a.conn_id ? connName.get(String(a.conn_id)) ?? null : null),
      orgDomain: org.domain ?? null,
      currency: String(a.currency ?? 'USD'),
      balance: a.balance !== undefined && a.balance !== null ? String(a.balance) : null,
      availableBalance: a['available-balance'] !== undefined && a['available-balance'] !== null ? String(a['available-balance']) : null,
      balanceDate: typeof a['balance-date'] === 'number' ? (a['balance-date'] as number) : null,
      transactions: txns
        .filter((t) => t.id !== undefined && t.amount !== undefined)
        .map((t) => {
          const posted = typeof t.posted === 'number' ? (t.posted as number) : Number(t.posted ?? 0) || 0;
          const transacted = typeof t.transacted_at === 'number' ? (t.transacted_at as number) : null;
          const pending = Boolean(t.pending) || posted === 0;
          const when = posted > 0 ? posted : transacted ?? Math.floor(Date.now() / 1000);
          return {
            id: String(t.id),
            date: toDateString(when),
            postedAt: posted > 0 ? posted : null,
            transactedAt: transacted,
            amount: String(t.amount),
            description: String(t.description ?? t.payee ?? ''),
            payee: t.payee !== undefined ? String(t.payee) : null,
            memo: t.memo !== undefined ? String(t.memo) : null,
            pending,
            raw: t,
          };
        }),
    };
  });
  return { accounts, errors: [...errors, ...errlist] };
}

export class LiveSimpleFinClient implements SimpleFinClient {
  readonly driver = 'live' as const;
  constructor(
    private readonly allowedHosts: string[] = DEFAULT_ALLOWED_HOSTS,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async claimSetupToken(setupToken: string): Promise<string> {
    let claimUrl: string;
    try {
      claimUrl = Buffer.from(setupToken.trim(), 'base64').toString('utf8').trim();
    } catch {
      throw new SimpleFinError('Setup token is not valid base64', 'invalid_token');
    }
    const url = assertSafeUrl(claimUrl, this.allowedHosts);
    const res = await this.request(url, { method: 'POST', headers: { 'Content-Length': '0' } });
    if (res.status === 403) throw new SimpleFinError('Setup token was already used or does not exist. Generate a new token in SimpleFIN Bridge.', 'claim_failed', 403);
    if (!res.ok) throw new SimpleFinError(`Claim failed with HTTP ${res.status}`, 'claim_failed', res.status);
    const accessUrl = (await res.text()).trim();
    const parsed = assertSafeUrl(accessUrl, this.allowedHosts);
    if (!parsed.username) throw new SimpleFinError('Access URL is missing credentials', 'protocol');
    return accessUrl;
  }

  async fetchAccounts(accessUrl: string, opts: { startDate?: Date; endDate?: Date; pending?: boolean; accountIds?: string[] } = {}): Promise<SimpleFinAccountsResponse> {
    const base = assertSafeUrl(accessUrl, this.allowedHosts);
    const url = new URL(`${base.origin}${base.pathname.replace(/\/$/, '')}/accounts`);
    if (opts.startDate) url.searchParams.set('start-date', String(Math.floor(opts.startDate.getTime() / 1000)));
    if (opts.endDate) url.searchParams.set('end-date', String(Math.floor(opts.endDate.getTime() / 1000)));
    if (opts.pending) url.searchParams.set('pending', '1');
    for (const id of opts.accountIds ?? []) url.searchParams.append('account', id);
    const auth = Buffer.from(`${decodeURIComponent(base.username)}:${decodeURIComponent(base.password)}`).toString('base64');
    const res = await this.request(url, { method: 'GET', headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } });
    if (res.status === 403) throw new SimpleFinError('SimpleFIN access was revoked or the credentials are invalid. Reconnect with a new setup token.', 'auth_revoked', 403);
    if (res.status === 402) throw new SimpleFinError('SimpleFIN Bridge subscription requires payment.', 'payment_required', 402);
    if (res.status === 429) throw new SimpleFinError('SimpleFIN rate limit reached; try again later.', 'rate_limited', 429);
    if (!res.ok) throw new SimpleFinError(`SimpleFIN responded with HTTP ${res.status}`, 'protocol', res.status);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new SimpleFinError('SimpleFIN returned a non-JSON response', 'protocol');
    }
    return parseAccounts(json);
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'manual', signal: controller.signal });
    } catch (err) {
      throw new SimpleFinError(`Network error talking to SimpleFIN: ${(err as Error).message}`, 'network');
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Fixture client for local development and tests. Deterministic accounts and
 * transactions relative to `now`, with hooks to simulate pending → posted
 * transitions and provider-side changes.
 */
export class FixtureSimpleFinClient implements SimpleFinClient {
  readonly driver = 'fixture' as const;
  claimed = new Set<string>();
  /** Transactions keyed by account id; tests mutate these between syncs. */
  accounts: SimpleFinAccount[];
  errors: string[] = [];
  failNext: SimpleFinError | null = null;
  calls: { startDate?: Date; endDate?: Date }[] = [];

  constructor(now = new Date()) {
    this.accounts = FixtureSimpleFinClient.defaultAccounts(now);
  }

  static defaultAccounts(now: Date): SimpleFinAccount[] {
    const day = 86_400;
    const t0 = Math.floor(now.getTime() / 1000);
    const mk = (id: string, daysAgo: number, amount: string, description: string, pending = false): SimpleFinTransaction => {
      const ts = t0 - daysAgo * day;
      return { id, date: toDateString(ts), postedAt: pending ? null : ts, transactedAt: ts, amount, description, payee: description.split(' ')[0] ?? null, memo: null, pending, raw: { id, posted: pending ? 0 : ts, amount, description } };
    };
    return [
      {
        id: 'demo-checking',
        name: 'Demo Checking',
        orgName: 'Demo Bank',
        orgDomain: 'demobank.example',
        currency: 'USD',
        balance: '5230.12',
        availableBalance: '5230.12',
        balanceDate: t0,
        transactions: [
          mk('chk-1', 9, '-42.10', 'COFFEE ROASTERS'),
          mk('chk-2', 8, '2500.00', 'CLIENT PAYMENT ACH'),
          mk('chk-3', 6, '-1200.00', 'RENT PAYMENT'),
          mk('chk-4', 3, '-300.00', 'TRANSFER TO CARD'),
          mk('chk-5', 1, '-18.99', 'STREAMING SERVICE', true),
        ],
      },
      {
        id: 'demo-card',
        name: 'Demo Visa',
        orgName: 'Demo Bank',
        orgDomain: 'demobank.example',
        currency: 'USD',
        balance: '-412.50',
        availableBalance: null,
        balanceDate: t0,
        transactions: [mk('card-1', 5, '-89.10', 'ONLINE STORE'), mk('card-2', 3, '300.00', 'PAYMENT THANK YOU'), mk('card-3', 2, '-23.40', 'GAS STATION')],
      },
    ];
  }

  async claimSetupToken(setupToken: string): Promise<string> {
    if (this.claimed.has(setupToken)) throw new SimpleFinError('Setup token was already used', 'claim_failed', 403);
    if (!setupToken.startsWith('demo')) throw new SimpleFinError('Fixture driver accepts tokens starting with "demo"', 'invalid_token');
    this.claimed.add(setupToken);
    return `https://demo:${Buffer.from(setupToken).toString('hex').slice(0, 16)}@beta-bridge.simplefin.org/simplefin`;
  }

  async fetchAccounts(_accessUrl: string, opts: { startDate?: Date; endDate?: Date; pending?: boolean } = {}): Promise<SimpleFinAccountsResponse> {
    this.calls.push({ startDate: opts.startDate, endDate: opts.endDate });
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const start = opts.startDate ? Math.floor(opts.startDate.getTime() / 1000) : 0;
    const end = opts.endDate ? Math.floor(opts.endDate.getTime() / 1000) : Number.MAX_SAFE_INTEGER;
    return {
      errors: [...this.errors],
      accounts: this.accounts.map((a) => ({
        ...a,
        transactions: a.transactions.filter((t) => {
          if (t.pending && !opts.pending) return false;
          const when = t.postedAt ?? t.transactedAt ?? 0;
          return when >= start && when < end;
        }),
      })),
    };
  }
}

export function createSimpleFinClientFromEnv(env: NodeJS.ProcessEnv = process.env): SimpleFinClient {
  if ((env.SIMPLEFIN_DRIVER ?? 'fixture') === 'live') return new LiveSimpleFinClient(allowedHostsFromEnv(env));
  return new FixtureSimpleFinClient();
}

export { parseAccounts as parseSimpleFinAccounts, assertSafeUrl as assertSafeSimpleFinUrl };
