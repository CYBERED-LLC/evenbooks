'use client';
import * as React from 'react';
import { AlertTriangle, Link2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { AccountDto, BankConnectionDto, DiscoveredAccountDto, LinkProviderAccountsInput, SyncResultDto } from '@evenbooks/contracts';
import { AccountPicker, suggestAccountCode } from '@/components/account-picker';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorNotice, Spinner } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useAccounts } from '@/lib/queries/accounts';
import { useBankAccounts } from '@/lib/queries/banking';
import {
  useConnectSimpleFin,
  useConnections,
  useDisconnectConnection,
  useDiscoverAccounts,
  useLinkProviderAccounts,
  useReconnectConnection,
  useSyncConnection,
  useUpdateConnection,
} from '@/lib/queries/connections';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { formatDateTime, formatMoney } from '@/lib/format';
import { compareDecimals, negateDecimal } from '@/lib/decimal';
import { useCompany } from '@/components/company-context';

type Kind = 'bank' | 'credit_card';
const KIND_LABEL: Record<Kind, string> = { bank: 'Bank', credit_card: 'Credit card' };
const STATUS_TONE: Record<BankConnectionDto['status'], 'green' | 'red' | 'neutral'> = { active: 'green', error: 'red', revoked: 'red', disabled: 'neutral' };
const INTERVALS = [
  { minutes: 60, label: 'Every hour' },
  { minutes: 180, label: 'Every 3 hours' },
  { minutes: 360, label: 'Every 6 hours' },
  { minutes: 720, label: 'Every 12 hours' },
  { minutes: 1440, label: 'Every 24 hours' },
];
const BRIDGE_URL = 'https://beta-bridge.simplefin.org/';
const TOKEN_HELP = 'Paste the setup token from SimpleFIN Bridge. It can be used only once and is never stored.';
const DEV_TOKEN_HINT = process.env.NODE_ENV !== 'production' ? ' In development the fixture driver accepts any token starting with "demo".' : '';

function intervalLabel(minutes: number): string {
  return INTERVALS.find((i) => i.minutes === minutes)?.label ?? `Every ${minutes} minutes`;
}

/** A balance as the bank reports it, in the owner's words: card providers report what is owed as a negative number. */
function providerBalance(kind: Kind, balance: string, currency: string): string {
  if (kind === 'bank') return formatMoney(balance, currency);
  return compareDecimals(balance, '0') > 0 ? `Credit ${formatMoney(balance, currency)}` : `Owed ${formatMoney(negateDecimal(balance), currency)}`;
}

const syncCounts = (r: SyncResultDto) => `${r.inserted} new, ${r.updated} updated, ${r.changed} changed`;

/**
 * How the automatic feed works, in three steps. SimpleFIN Bridge is a separate paid service, so
 * say so before anyone goes looking for a token.
 */
function SimpleFinSteps() {
  return (
    <div className="space-y-2 text-sm text-stone-700" data-testid="simplefin-steps">
      <p>Evenbooks reads your bank through SimpleFIN Bridge, a separate service you pay directly (about $1.50 a month).</p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>
          Create an account at{' '}
          <a href={BRIDGE_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-700 underline-offset-2 hover:underline">
            SimpleFIN Bridge
          </a>{' '}
          and add your bank there.
        </li>
        <li>Create a setup token.</li>
        <li>Paste it here.</li>
      </ol>
    </div>
  );
}

/** Toast for a sync result; a successful one links to the transactions inbox. */
function useSyncToast() {
  const toast = useToast();
  const router = useRouter();
  return React.useCallback(
    (r: SyncResultDto, nextSyncAt?: string | null) => {
      const review = { action: { label: 'Review transactions', onClick: () => router.push('/banking/inbox') } };
      const throttled = r.warnings.some((w) => w.startsWith('Throttled'));
      if (!r.ok) toast.error('Sync failed', r.error ?? undefined);
      else if (throttled) toast.info('Sync skipped', `${r.warnings.join(' ')}. Try again in a few minutes${nextSyncAt ? `, or wait for the automatic sync at ${formatDateTime(nextSyncAt)}` : ''}.`);
      else if (r.warnings.length) toast.info('Sync complete with warnings', `${syncCounts(r)}. ${r.warnings.join(' ')}`, review);
      else toast.success('Sync complete', syncCounts(r), review);
    },
    [toast, router],
  );
}

/** "Automatic bank feed" card for the bank accounts page: SimpleFIN connections, their linked accounts and sync health. */
export function BankConnections() {
  const { isAdmin } = useCompany();
  const q = useConnections();
  const [connecting, setConnecting] = React.useState(false);
  const [linking, setLinking] = React.useState<BankConnectionDto | null>(null);
  const [reconnecting, setReconnecting] = React.useState<BankConnectionDto | null>(null);
  const [disconnecting, setDisconnecting] = React.useState<BankConnectionDto | null>(null);

  return (
    <Card>
      <CardHeader
        title="Automatic bank feed"
        description="New transactions arrive by themselves. Importing a CSV keeps working alongside."
        actions={
          isAdmin ? (
            <Button size="sm" onClick={() => setConnecting(true)}>
              Connect your bank
            </Button>
          ) : undefined
        }
      />
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.length === 0 && (
        <CardBody className="space-y-3">
          <p className="text-sm font-medium text-stone-900">No bank connected yet</p>
          <SimpleFinSteps />
          {isAdmin && (
            <Button size="sm" onClick={() => setConnecting(true)}>
              Connect your bank
            </Button>
          )}
        </CardBody>
      )}
      {q.data && q.data.length > 0 && (
        <ul className="divide-y divide-stone-100" aria-label="Bank connections">
          {q.data.map((c) => (
            <ConnectionItem key={c.id} connection={c} onLink={() => setLinking(c)} onReconnect={() => setReconnecting(c)} onDisconnect={() => setDisconnecting(c)} />
          ))}
        </ul>
      )}
      <ConnectDialog open={connecting} onClose={() => setConnecting(false)} />
      <LinkAccountsDialog connection={linking} onClose={() => setLinking(null)} />
      <ReconnectDialog connection={reconnecting} onClose={() => setReconnecting(null)} />
      <DisconnectDialog connection={disconnecting} onClose={() => setDisconnecting(null)} />
    </Card>
  );
}

function ConnectionItem({ connection: c, onLink, onReconnect, onDisconnect }: { connection: BankConnectionDto; onLink: () => void; onReconnect: () => void; onDisconnect: () => void }) {
  const { company, isAdmin } = useCompany();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const sync = useSyncConnection();
  const update = useUpdateConnection();
  const syncToast = useSyncToast();
  const accounts = c.accounts ?? [];
  const canSync = c.status === 'active';

  const runSync = () =>
    sync.mutate(c.id, {
      onSuccess: (r) => syncToast(r, c.nextSyncAt),
      onError: (e) => onError(e, 'Sync failed'),
    });

  const setInterval = (syncIntervalMinutes: number) =>
    update.mutate(
      { id: c.id, input: { version: c.version, syncIntervalMinutes } },
      { onSuccess: () => toast.success('Sync interval updated', intervalLabel(syncIntervalMinutes)), onError: (e) => onError(e, 'Could not update sync interval') },
    );

  const setStatus = (status: 'active' | 'disabled') =>
    update.mutate(
      { id: c.id, input: { version: c.version, status } },
      { onSuccess: () => toast.success(status === 'active' ? 'Connection enabled' : 'Connection disabled'), onError: (e) => onError(e, 'Could not update connection') },
    );

  return (
    <li className="space-y-2 px-4 py-3" data-testid="bank-connection">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-stone-900">{c.name}</span>
        <Badge tone={STATUS_TONE[c.status]}>{c.status.charAt(0).toUpperCase() + c.status.slice(1)}</Badge>
        {c.isStale && (
          <Badge tone="amber">
            <AlertTriangle className="mr-1 size-3" aria-hidden /> Stale
          </Badge>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-stone-600">
        <dt className="text-stone-500">Syncs</dt>
        <dd className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {isAdmin ? (
            <select
              aria-label={`${c.name}: sync interval`}
              className="h-6 rounded border border-stone-300 bg-white px-1 text-xs text-stone-700 disabled:opacity-60"
              value={String(c.syncIntervalMinutes)}
              disabled={update.isPending}
              onChange={(e) => setInterval(Number(e.target.value))}
            >
              {INTERVALS.map((i) => (
                <option key={i.minutes} value={String(i.minutes)}>
                  {i.label}
                </option>
              ))}
            </select>
          ) : (
            <span>{intervalLabel(c.syncIntervalMinutes)}</span>
          )}
          {c.nextSyncAt && c.status === 'active' ? <span className="text-stone-500">next {formatDateTime(c.nextSyncAt)}</span> : null}
        </dd>
        <dt className="text-stone-500">Last success</dt>
        <dd>{c.lastSuccessAt ? formatDateTime(c.lastSuccessAt) : 'Never'}</dd>
        {c.lastError && (
          <>
            <dt className="text-stone-500">Last error</dt>
            <dd className="text-red-700" role={c.status === 'error' || c.status === 'revoked' ? 'alert' : undefined}>
              {c.lastError}
              {c.lastErrorAt ? ` (${formatDateTime(c.lastErrorAt)})` : ''}
              {c.consecutiveFailures > 1 ? ` · ${c.consecutiveFailures} failures in a row` : ''}
            </dd>
          </>
        )}
      </dl>
      {c.isStale && c.status !== 'disabled' && (
        <p className="text-xs text-amber-800">No successful sync in more than two intervals. Balances and transactions may be out of date.</p>
      )}
      {c.status === 'revoked' && <p className="text-xs text-red-700">Access was turned off at SimpleFIN Bridge. Reconnect with a new setup token to resume syncing.</p>}
      <div>
        <p className="text-xs font-medium text-stone-500">Linked accounts</p>
        {accounts.length === 0 ? (
          <p className="text-xs text-stone-500">None yet{isAdmin ? '. Use “Link accounts…” to choose which accounts at your bank to bring in.' : '.'}</p>
        ) : (
          <ul className="mt-1 space-y-0.5 text-sm">
            {accounts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span>
                  {a.name}
                  <span className="ml-1 text-xs text-stone-500">
                    {KIND_LABEL[a.kind]}
                    {a.providerOrgName ? ` · ${a.providerOrgName}` : ''}
                  </span>
                </span>
                <span className="tabular text-xs text-stone-600">
                  {a.lastBalance ? providerBalance(a.kind, a.lastBalance, company.baseCurrency) : 'Not synced'}
                  {a.lastSyncedAt ? ` · ${formatDateTime(a.lastSyncedAt)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        <Button variant="secondary" size="sm" onClick={runSync} loading={sync.isPending} disabled={!canSync} title={canSync ? undefined : 'Only active connections can sync'}>
          <RefreshCw className="size-4" /> Sync now
        </Button>
        {isAdmin && c.status !== 'revoked' && (
          <Button variant="secondary" size="sm" onClick={onLink}>
            <Link2 className="size-4" /> Link accounts…
          </Button>
        )}
        {isAdmin && (
          <Button variant="secondary" size="sm" onClick={onReconnect}>
            Reconnect…
          </Button>
        )}
        {isAdmin && (c.status === 'active' || c.status === 'error') && (
          <Button variant="ghost" size="sm" onClick={() => setStatus('disabled')} loading={update.isPending}>
            Disable
          </Button>
        )}
        {isAdmin && c.status === 'disabled' && (
          <Button variant="ghost" size="sm" onClick={() => setStatus('active')} loading={update.isPending}>
            Enable
          </Button>
        )}
        {isAdmin && c.status !== 'revoked' && (
          <Button variant="ghost" size="sm" className="text-red-700" onClick={onDisconnect}>
            Disconnect…
          </Button>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------
function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const connect = useConnectSimpleFin();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const [name, setName] = React.useState('');
  const [token, setToken] = React.useState('');
  const [interval, setInterval] = React.useState('360');
  React.useEffect(() => {
    if (open) {
      setName('');
      setToken('');
      setInterval('360');
    }
  }, [open]);
  const valid = name.trim().length > 0 && token.trim().length >= 16;
  const submit = () => {
    if (!valid || connect.isPending) return;
    connect.mutate(
      { name: name.trim(), setupToken: token.trim(), syncIntervalMinutes: Number(interval) },
      {
        onSuccess: () => {
          toast.success('Bank connected', 'Next, choose which accounts at your bank to bring in.');
          onClose();
        },
        onError: (e) => onError(e, 'Could not connect'),
      },
    );
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect your bank"
      description="SimpleFIN Bridge gives Evenbooks read-only access to your bank's transactions. Evenbooks stores only the access address, encrypted."
      onSubmit={submit}
      dirty={token.trim().length > 0 && !connect.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={connect.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid} loading={connect.isPending}>
            Connect
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <SimpleFinSteps />
        <Field label="Connection name" htmlFor="cx-name" required hint="e.g. the bank's name.">
          <Input id="cx-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Setup token" htmlFor="cx-token" required hint={TOKEN_HELP + DEV_TOKEN_HINT}>
          <Textarea id="cx-token" value={token} rows={3} autoComplete="off" spellCheck={false} className="font-mono text-xs" onChange={(e) => setToken(e.target.value)} />
        </Field>
        <Field label="Sync interval" htmlFor="cx-interval" required hint="Manual “Sync now” is always available (at most once every 15 minutes).">
          <Select id="cx-interval" value={interval} onChange={(e) => setInterval(e.target.value)}>
            {INTERVALS.map((i) => (
              <option key={i.minutes} value={String(i.minutes)}>
                {i.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Link accounts
// ---------------------------------------------------------------------------
interface LinkRow {
  mode: 'skip' | 'existing' | 'new';
  bankAccountId: string;
  name: string;
  kind: Kind;
  ledgerMode: 'new' | 'existing';
  ledgerAccountId: string;
  code: string;
  /** The user typed their own code; stop re-suggesting it. */
  codeTouched: boolean;
  ledgerName: string;
}

const guessKind = (name: string): Kind => (/card|credit|visa|mastercard|amex|discover/i.test(name) ? 'credit_card' : 'bank');

/**
 * Next free ledger code for a bank (asset) or card (liability) account: after
 * the highest code already used by that role, else by that type. `reserved`
 * holds codes other rows in the dialog already suggested.
 */
export function suggestLedgerCode(all: AccountDto[], kind: Kind, reserved: Iterable<string>): string {
  const type = kind === 'bank' ? 'asset' : 'liability';
  const sameRole = all.filter((a) => a.role === kind);
  const fakes = [...reserved].map((code) => ({ code, type, role: kind }) as AccountDto);
  let code = suggestAccountCode([...(sameRole.length ? sameRole : all), ...fakes], type);
  const taken = new Set([...all.map((a) => a.code), ...fakes.map((f) => f.code)]);
  while (taken.has(code) && /^\d+$/.test(code)) code = String(Number(code) + 1);
  return code;
}

/** Discovered accounts grouped by the institution SimpleFIN reports them under, in a stable order. */
function groupByOrg(accounts: DiscoveredAccountDto[]): { key: string; orgName: string; accounts: DiscoveredAccountDto[] }[] {
  const groups = new Map<string, DiscoveredAccountDto[]>();
  for (const a of accounts) {
    const name = a.orgName?.trim() || 'Other accounts';
    groups.set(name, [...(groups.get(name) ?? []), a]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([orgName, list], i) => ({ key: String(i), orgName, accounts: [...list].sort((x, y) => x.name.localeCompare(y.name)) }));
}

function LinkAccountsDialog({ connection, onClose }: { connection: BankConnectionDto | null; onClose: () => void }) {
  const { company } = useCompany();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const link = useLinkProviderAccounts();
  const sync = useSyncConnection();
  const syncToast = useSyncToast();
  const connectionId = connection?.id ?? null;
  const discover = useDiscoverAccounts(connectionId);
  const bankAccounts = useBankAccounts();
  const accounts = useAccounts({ includeArchived: true });
  const [rows, setRows] = React.useState<Record<string, LinkRow>>({});
  const [error, setError] = React.useState<string | null>(null);
  const uid = React.useId();

  // Fresh rows each time the dialog opens for a (different) connection.
  React.useEffect(() => {
    if (!connectionId) return;
    setRows({});
    setError(null);
  }, [connectionId]);
  // New provider accounts default to "create a new bank account" with a free ledger code.
  React.useEffect(() => {
    if (!discover.data || !accounts.data) return;
    const all = accounts.data;
    setRows((prev) => {
      const next = { ...prev };
      const reserved = Object.values(next).map((r) => r.code).filter(Boolean);
      for (const a of discover.data!) {
        if (a.bankAccountId || next[a.providerAccountId]) continue;
        const kind = guessKind(a.name);
        const code = suggestLedgerCode(all, kind, reserved);
        reserved.push(code);
        next[a.providerAccountId] = { mode: 'new', bankAccountId: '', name: a.name, kind, ledgerMode: 'new', ledgerAccountId: '', code, codeTouched: false, ledgerName: a.name };
      }
      return next;
    });
  }, [discover.data, accounts.data]);

  const bankAccountName = (id: string) => bankAccounts.data?.find((b) => b.id === id)?.name ?? 'a bank account';
  const unlinkedBankAccounts = (bankAccounts.data ?? []).filter((b) => b.isActive && !b.connectionId);
  const ledgerLinked = new Set((bankAccounts.data ?? []).map((b) => b.ledgerAccountId));
  const hasLedgerCandidates = (kind: Kind) => (accounts.data ?? []).some((a) => a.isActive && a.role === kind && !ledgerLinked.has(a.id));
  const setRow = (id: string, patch: Partial<LinkRow>) => setRows((r) => ({ ...r, [id]: { ...r[id]!, ...patch } }));
  const changeKind = (id: string, kind: Kind) =>
    setRows((all) => {
      const row = all[id]!;
      const patch: Partial<LinkRow> = { kind, ledgerAccountId: '' };
      if (!row.codeTouched && accounts.data) {
        const reserved = Object.entries(all)
          .filter(([k]) => k !== id)
          .map(([, r]) => r.code)
          .filter(Boolean);
        patch.code = suggestLedgerCode(accounts.data, kind, reserved);
      }
      return { ...all, [id]: { ...row, ...patch } };
    });
  const setAllModes = (mode: 'new' | 'skip') =>
    setRows((all) => Object.fromEntries(Object.entries(all).map(([k, r]) => [k, mode === 'skip' || r.mode === 'skip' ? { ...r, mode } : r])));

  const pending = Object.values(rows).filter((r) => r.mode !== 'skip');
  const skipped = Object.values(rows).filter((r) => r.mode === 'skip');
  const chosenExisting = pending.filter((r) => r.mode === 'existing').map((r) => r.bankAccountId);

  const submit = () => {
    if (!connection || link.isPending) return;
    const links: LinkProviderAccountsInput['links'] = [];
    for (const [providerAccountId, r] of Object.entries(rows)) {
      if (r.mode === 'skip') continue;
      const label = discover.data?.find((a) => a.providerAccountId === providerAccountId)?.name ?? providerAccountId;
      if (r.mode === 'existing') {
        if (!r.bankAccountId) return setError(`${label}: choose the bank account to link.`);
        links.push({ providerAccountId, bankAccountId: r.bankAccountId });
        continue;
      }
      if (!r.name.trim()) return setError(`${label}: bank account name is required.`);
      if (r.ledgerMode === 'existing') {
        if (!r.ledgerAccountId) return setError(`${label}: choose a ledger account.`);
        links.push({ providerAccountId, create: { name: r.name.trim(), kind: r.kind, ledgerAccountId: r.ledgerAccountId } });
      } else {
        if (!r.code.trim() || !r.ledgerName.trim()) return setError(`${label}: ledger account code and name are required.`);
        if ((accounts.data ?? []).some((a) => a.code === r.code.trim())) return setError(`${label}: ledger code ${r.code.trim()} is already used by another account.`);
        links.push({ providerAccountId, create: { name: r.name.trim(), kind: r.kind, newLedgerAccount: { code: r.code.trim(), name: r.ledgerName.trim() } } });
      }
    }
    if (new Set(chosenExisting).size !== chosenExisting.length) return setError('Each existing bank account can be linked to only one account at your bank.');
    const newCodes = pending.filter((r) => r.mode === 'new' && r.ledgerMode === 'new').map((r) => r.code.trim());
    if (new Set(newCodes).size !== newCodes.length) return setError('Each new ledger account needs its own code.');
    if (links.length === 0) return setError('Choose at least one account to link.');
    setError(null);
    const id = connection.id;
    const nextSyncAt = connection.nextSyncAt;
    link.mutate(
      { id, input: { version: connection.version, links } },
      {
        onSuccess: () => {
          toast.success(`${links.length === 1 ? '1 account' : `${links.length} accounts`} linked`, 'Fetching transactions now…');
          onClose();
          // Pull transactions straight away instead of waiting for the next worker tick.
          sync.mutate(id, { onSuccess: (r) => syncToast(r, nextSyncAt), onError: (e) => onError(e, 'Sync failed') });
        },
        onError: (e) => onError(e, 'Could not link accounts'),
      },
    );
  };

  const open = Boolean(connection);
  const rowCount = Object.keys(rows).length;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={connection ? `Link accounts · ${connection.name}` : 'Link accounts'}
      description="Choose which accounts at your bank to bring in, and which account in Evenbooks each one feeds. Accounts set to “Do not import” are ignored."
      onSubmit={submit}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={link.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={link.isPending} disabled={!discover.data || pending.length === 0}>
            {pending.length === 0 ? 'Link accounts' : `Link ${pending.length === 1 ? '1 account' : `${pending.length} accounts`}`}
          </Button>
        </>
      }
    >
      {open && discover.isPending && <Spinner label="Fetching the accounts at your bank" />}
      {open && discover.isError && <ErrorNotice error={discover.error} onRetry={() => discover.refetch()} />}
      {discover.data && discover.data.length === 0 && <EmptyState title="SimpleFIN found no accounts at your bank" description="Check that the bank is added at SimpleFIN Bridge." />}
      {discover.data && discover.data.length > 0 && (
        <div className="space-y-5">
          {rowCount > 1 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Button variant="secondary" size="sm" disabled={skipped.length === 0} onClick={() => setAllModes('new')}>
                Import all
              </Button>
              <Button variant="ghost" size="sm" disabled={pending.length === 0} onClick={() => setAllModes('skip')}>
                Skip all
              </Button>
              <span className="text-xs text-stone-500">
                {pending.length} of {rowCount} unlinked accounts will be imported
              </span>
            </div>
          )}
          {groupByOrg(discover.data).map((group) => (
            <section key={group.orgName} aria-labelledby={`${uid}-org-${group.key}`}>
              <h3 id={`${uid}-org-${group.key}`} className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-stone-800">
                {group.orgName}
                <span className="text-xs font-normal text-stone-500">
                  {group.accounts.length === 1 ? '1 account' : `${group.accounts.length} accounts`}
                </span>
              </h3>
              <ul className="space-y-3" aria-label={`${group.orgName} accounts`}>
                {group.accounts.map((a) => {
                  const r = rows[a.providerAccountId];
                  const p = a.name;
                  const fid = (name: string) => `${uid}-${name}-${a.providerAccountId}`;
                  return (
                    <li key={a.providerAccountId} className="rounded-md border border-stone-200 p-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <div>
                          <p className="font-medium text-stone-900">{a.name}</p>
                          <p className="text-xs text-stone-500">
                            {a.currency}
                            {a.balance ? ` · ${formatMoney(a.balance, company.baseCurrency)}` : ''}
                            {a.balanceDate ? ` as of ${formatDateTime(a.balanceDate)}` : ''}
                          </p>
                        </div>
                        {a.bankAccountId && <Badge tone="green">Linked to {bankAccountName(a.bankAccountId)}</Badge>}
                      </div>
                      {!a.bankAccountId && r && (
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <Field label="Link" htmlFor={fid('mode')} className="sm:col-span-2">
                            <Select id={fid('mode')} aria-label={`${p}: link`} value={r.mode} onChange={(e) => setRow(a.providerAccountId, { mode: e.target.value as LinkRow['mode'] })}>
                              <option value="new">Create a new bank account</option>
                              <option value="existing" disabled={unlinkedBankAccounts.length === 0}>
                                Link to an existing bank account{unlinkedBankAccounts.length === 0 ? ' (none unlinked)' : ''}
                              </option>
                              <option value="skip">Do not import</option>
                            </Select>
                          </Field>
                          {r.mode === 'existing' && (
                            <Field label="Existing bank account" htmlFor={fid('ba')} required className="sm:col-span-2">
                              <Select id={fid('ba')} aria-label={`${p}: existing bank account`} value={r.bankAccountId} onChange={(e) => setRow(a.providerAccountId, { bankAccountId: e.target.value })}>
                                <option value="">Select account…</option>
                                {unlinkedBankAccounts.map((b) => (
                                  <option key={b.id} value={b.id}>
                                    {b.name} ({KIND_LABEL[b.kind]})
                                  </option>
                                ))}
                              </Select>
                            </Field>
                          )}
                          {r.mode === 'new' && (
                            <>
                              <Field label="Bank account name" htmlFor={fid('name')} required>
                                <Input id={fid('name')} aria-label={`${p}: bank account name`} value={r.name} maxLength={120} onChange={(e) => setRow(a.providerAccountId, { name: e.target.value })} />
                              </Field>
                              <Field label="Type" htmlFor={fid('kind')} required>
                                <Select id={fid('kind')} aria-label={`${p}: kind`} value={r.kind} onChange={(e) => changeKind(a.providerAccountId, e.target.value as Kind)}>
                                  <option value="bank">Bank account</option>
                                  <option value="credit_card">Credit card</option>
                                </Select>
                              </Field>
                              <Field label="Ledger account" htmlFor={fid('lmode')} required className="sm:col-span-2">
                                <Select id={fid('lmode')} aria-label={`${p}: ledger account`} value={r.ledgerMode} onChange={(e) => setRow(a.providerAccountId, { ledgerMode: e.target.value as LinkRow['ledgerMode'] })}>
                                  <option value="new">Create a new ledger account</option>
                                  <option value="existing">Link an existing ledger account</option>
                                </Select>
                              </Field>
                              {r.ledgerMode === 'existing' ? (
                                <Field
                                  label="Existing ledger account"
                                  htmlFor={fid('ledger')}
                                  required
                                  className="sm:col-span-2"
                                  hint={hasLedgerCandidates(r.kind) ? undefined : `No unlinked accounts with the ${KIND_LABEL[r.kind].toLowerCase()} role.`}
                                >
                                  <AccountPicker
                                    id={fid('ledger')}
                                    aria-label={`${p}: existing ledger account`}
                                    value={r.ledgerAccountId || null}
                                    onChange={(v) => setRow(a.providerAccountId, { ledgerAccountId: v ?? '' })}
                                    allow={(la) => la.role === r.kind && !ledgerLinked.has(la.id)}
                                    createType={false}
                                  />
                                </Field>
                              ) : (
                                <>
                                  <Field label="Ledger account code" htmlFor={fid('code')} required hint="Next free code, suggested.">
                                    <Input
                                      id={fid('code')}
                                      aria-label={`${p}: ledger account code`}
                                      value={r.code}
                                      maxLength={20}
                                      onChange={(e) => setRow(a.providerAccountId, { code: e.target.value, codeTouched: true })}
                                    />
                                  </Field>
                                  <Field label="Ledger account name" htmlFor={fid('lname')} required>
                                    <Input id={fid('lname')} aria-label={`${p}: ledger account name`} value={r.ledgerName} maxLength={120} onChange={(e) => setRow(a.providerAccountId, { ledgerName: e.target.value })} />
                                  </Field>
                                </>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Reconnect / disconnect
// ---------------------------------------------------------------------------
function ReconnectDialog({ connection, onClose }: { connection: BankConnectionDto | null; onClose: () => void }) {
  const reconnect = useReconnectConnection();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const [token, setToken] = React.useState('');
  React.useEffect(() => {
    if (connection) setToken('');
  }, [connection]);
  const valid = token.trim().length >= 16;
  const submit = () => {
    if (!connection || !valid || reconnect.isPending) return;
    reconnect.mutate(
      { id: connection.id, input: { version: connection.version, setupToken: token.trim() } },
      {
        onSuccess: () => {
          toast.success('Connection reconnected');
          onClose();
        },
        onError: (e) => onError(e, 'Could not reconnect'),
      },
    );
  };
  return (
    <Dialog
      open={Boolean(connection)}
      onClose={onClose}
      title={connection ? `Reconnect ${connection.name}` : 'Reconnect'}
      description="Paste a new setup token from SimpleFIN Bridge. Linked accounts and imported transactions are kept."
      onSubmit={submit}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={reconnect.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid} loading={reconnect.isPending}>
            Reconnect
          </Button>
        </>
      }
    >
      <Field label="New setup token" htmlFor="rc-token" required hint={TOKEN_HELP + DEV_TOKEN_HINT}>
        <Textarea id="rc-token" value={token} rows={3} autoComplete="off" spellCheck={false} className="font-mono text-xs" onChange={(e) => setToken(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function DisconnectDialog({ connection, onClose }: { connection: BankConnectionDto | null; onClose: () => void }) {
  const disconnect = useDisconnectConnection();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  return (
    <Dialog
      open={Boolean(connection)}
      onClose={onClose}
      title={connection ? `Disconnect ${connection.name}?` : 'Disconnect'}
      description="Syncing stops and Evenbooks forgets its access to your bank. Imported transactions, bank accounts and reconciliations are kept. To resume later, reconnect with a new setup token."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={disconnect.isPending}>
            Keep connection
          </Button>
          <Button
            variant="danger"
            loading={disconnect.isPending}
            onClick={() =>
              connection &&
              disconnect.mutate(
                { id: connection.id, version: connection.version },
                {
                  onSuccess: () => {
                    toast.success('Connection disconnected', 'Imported transactions were kept.');
                    onClose();
                  },
                  onError: (e) => onError(e, 'Could not disconnect'),
                },
              )
            }
          >
            Disconnect
          </Button>
        </>
      }
    >
      <p className="text-sm text-stone-700">You can also revoke access from the SimpleFIN Bridge dashboard.</p>
    </Dialog>
  );
}
