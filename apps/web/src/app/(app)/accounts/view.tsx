'use client';
import * as React from 'react';
import Link from 'next/link';
import type { AccountDto, AccountType } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/input';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useAccounts, useUpdateAccount } from '@/lib/queries/accounts';
import { useMappings, EXCLUDED_LINE_CODE } from '@/lib/queries/mappings';
import { scheduleCApplies } from '@/lib/queries/reports';
import { CreateAccountDialog } from '@/components/account-picker';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { formatMoney, capitalize } from '@/lib/format';
import { useCompany, useToday } from '@/components/company-context';
import { useListParams } from '@/lib/use-list-params';
import { useHotkeys } from '@/lib/use-hotkeys';
import { cn } from '@/lib/utils';

const TYPES: AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense'];
/** Roles that move only through Evenbooks documents (mirrors PROTECTED_CONTROL_ROLES). */
const DOCUMENT_ROLES = new Set<NonNullable<AccountDto['role']>>(['accounts_receivable', 'customer_deposits', 'sales_tax_payable']);
const isDocumentDriven = (a: AccountDto) => a.role !== null && DOCUMENT_ROLES.has(a.role);
const INTERACTIVE = 'a, button, input, select, textarea, label';

/** Parents first, each followed by its children (sorted by code), with nesting depth. */
function treeOrder(rows: AccountDto[]): { account: AccountDto; depth: number }[] {
  const byParent = new Map<string | null, AccountDto[]>();
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    const parent = r.parentId && ids.has(r.parentId) ? r.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), r]);
  }
  const out: { account: AccountDto; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const a of (byParent.get(parent) ?? []).sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }))) {
      out.push({ account: a, depth });
      if (depth < 6) walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function AccountsView() {
  const { company } = useCompany();
  const list = useListParams();
  const filterRef = React.useRef<HTMLInputElement>(null);
  const archivedParam = list.get('archived') === '1';
  const [includeArchived, setIncludeArchived] = React.useState(archivedParam);
  React.useEffect(() => setIncludeArchived(archivedParam), [archivedParam]);
  const typeParam = list.get('type') as AccountType | undefined;
  const typeFilter = typeParam && TYPES.includes(typeParam) ? typeParam : undefined;
  const q = useAccounts({ includeArchived, withBalances: true });
  const [editing, setEditing] = React.useState<AccountDto | null>(null);
  const [creating, setCreating] = React.useState(false);
  // Roles are bookkeeping detail; owners see them only when they ask.
  const details = list.get('details') === '1';
  // Each income and expense category shows the Schedule C line it lands on this tax year.
  const taxYear = Number(useToday().slice(0, 4));
  const showTaxLines = scheduleCApplies(company.businessType);
  const mappings = useMappings(taxYear, showTaxLines);
  const lineFor = React.useMemo(() => {
    const labels = new Map((mappings.data?.lines ?? []).map((l) => [l.code, l.label]));
    return new Map((mappings.data?.accounts ?? []).map((a) => [a.id, a.lineCode ? { code: a.lineCode, label: labels.get(a.lineCode) ?? '' } : null]));
  }, [mappings.data]);

  useHotkeys({
    n: () => setCreating(true),
    '/': () => filterRef.current?.focus(),
  });

  // Filter-as-you-type on the local list; the URL catches up after a pause.
  const needle = list.search.trim().toLowerCase();
  const matches = (a: AccountDto) => !needle || a.code.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle);
  const counts = React.useMemo(() => {
    const c: Partial<Record<AccountType, number>> = {};
    for (const a of q.data ?? []) if (matches(a)) c[a.type] = (c[a.type] ?? 0) + 1;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, needle]);
  const shownTypes = TYPES.filter((t) => !typeFilter || t === typeFilter);
  const anyShown = shownTypes.some((t) => (counts[t] ?? 0) > 0);

  return (
    <>
      <PageHeader
        title="Chart of accounts"
        description="Your categories, plus your bank, card and loan accounts. Built-in ones can be renamed; ones you’ve used can be archived."
        actions={
          <>
            <Checkbox label="Show details" checked={details} onChange={(e) => list.set('details', e.target.checked ? '1' : null)} />
            <Checkbox
              label="Show archived"
              checked={includeArchived}
              onChange={(e) => {
                setIncludeArchived(e.target.checked);
                list.set('archived', e.target.checked ? '1' : null);
              }}
            />
            <Button onClick={() => setCreating(true)} title="New account (N)">
              New account
            </Button>
          </>
        }
      />
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3 p-3">
          <Input
            ref={filterRef}
            type="search"
            aria-label="Filter accounts by code or name"
            placeholder="Filter by code or name…"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            className="w-full sm:w-72"
          />
          <div role="group" aria-label="Account type" className="flex flex-wrap gap-1">
            <TypeChip label="All types" active={!typeFilter} onClick={() => list.set('type', null)} />
            {TYPES.map((t) => (
              <TypeChip key={t} label={capitalize(t)} count={counts[t] ?? 0} active={typeFilter === t} onClick={() => list.set('type', typeFilter === t ? null : t)} />
            ))}
          </div>
        </div>
      </Card>
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.length === 0 && <EmptyState title="No accounts" />}
      {q.data && q.data.length > 0 && !anyShown && (
        <EmptyState
          title="No accounts match"
          description="Try a different code, name or type."
          action={
            <Button variant="secondary" onClick={() => list.clear(['q', 'type'])}>
              Clear filters
            </Button>
          }
        />
      )}
      {q.data &&
        shownTypes.map((type) => {
          const all = q.data.filter((a) => a.type === type);
          const ordered = treeOrder(all).filter((r) => matches(r.account));
          if (ordered.length === 0) return null;
          return (
            <Card key={type} className="mb-4">
              <Table aria-label={`${capitalize(type)} accounts`}>
                <THead>
                  <TR>
                    <TH className="w-24">Code</TH>
                    <TH>{capitalize(type)} accounts</TH>
                    {details && <TH className="hidden md:table-cell">Role</TH>}
                    <TH numeric>Balance</TH>
                    <TH className="w-20">
                      <span className="sr-only">Actions</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {ordered.map(({ account: a, depth }) => (
                    <TR
                      key={a.id}
                      className={cn('cursor-pointer', !a.isActive && 'opacity-60')}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest(INTERACTIVE) || window.getSelection()?.toString()) return;
                        setEditing(a);
                      }}
                    >
                      <TD className="font-mono text-xs">{a.code}</TD>
                      <TD>
                        <div style={depth ? { paddingLeft: `${depth * 1.25}rem` } : undefined} className={cn(depth > 0 && 'border-l border-stone-200')}>
                          <span className={cn('font-medium', depth > 0 && 'pl-2')}>{a.name}</span>
                          {!a.isActive && (
                            <Badge tone="neutral" className="ml-2">
                              Archived
                            </Badge>
                          )}
                          {details && isDocumentDriven(a) && (
                            <Badge tone="purple" className="ml-2">
                              Evenbooks documents only
                            </Badge>
                          )}
                          {a.description && <p className={cn('text-xs text-stone-500', depth > 0 && 'pl-2')}>{a.description}</p>}
                          {showTaxLines && (a.type === 'income' || a.type === 'expense') && mappings.data && (
                            <TaxLineNote line={lineFor.get(a.id) ?? null} year={taxYear} indent={depth > 0} />
                          )}
                        </div>
                      </TD>
                      {details && <TD className="hidden md:table-cell">{a.role ? <Badge tone={a.isSystem ? 'purple' : 'blue'}>{capitalize(a.role)}</Badge> : null}</TD>}
                      <TD numeric>
                        <Link href={`/reports/general-ledger?accountId=${a.id}`} className="text-stone-800 hover:text-brand-700 hover:underline" title={`General ledger for ${a.code} ${a.name}`}>
                          {formatMoney(a.balance ?? '0', company.baseCurrency)}
                        </Link>
                      </TD>
                      <TD>
                        <Button variant="ghost" size="sm" onClick={() => setEditing(a)} aria-label={`Edit account ${a.code}`} title={`Edit ${a.code} ${a.name}`}>
                          Edit
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
          );
        })}
      <CreateAccountDialog open={creating} onClose={() => setCreating(false)} />
      <EditAccountDialog account={editing} onClose={() => setEditing(null)} />
    </>
  );
}

/** "Schedule C: line 18 Office expense" under an income or expense category, or a nudge to choose one. */
function TaxLineNote({ line, year, indent }: { line: { code: string; label: string } | null; year: number; indent: boolean }) {
  const cls = cn('text-xs', indent && 'pl-2');
  if (line?.code === EXCLUDED_LINE_CODE) return <p className={cn(cls, 'text-stone-500')} data-testid="account-tax-line">Not on Schedule C</p>;
  if (line)
    return (
      <p className={cn(cls, 'text-stone-500')} data-testid="account-tax-line">
        Schedule C: line {line.code} {line.label}
      </p>
    );
  return (
    <p className={cn(cls, 'text-amber-700')} data-testid="account-tax-line">
      No Schedule C line for {year} yet.{' '}
      <Link href={`/settings/mappings?year=${year}`} className="underline">
        Choose one
      </Link>
    </p>
  );
}

function TypeChip({ label, count, active, onClick }: { label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3 text-sm sm:min-h-8',
        active ? 'border-brand-600 bg-brand-600 text-white' : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50',
      )}
    >
      {label}
      {count !== undefined && <span className={cn('text-xs tabular', active ? 'text-white/80' : 'text-stone-500')}>{count}</span>}
    </button>
  );
}

function EditAccountDialog({ account, onClose }: { account: AccountDto | null; onClose: () => void }) {
  const update = useUpdateAccount();
  const toast = useToast();
  const confirm = useConfirm();
  const onError = useMutationErrorHandler();
  const [form, setForm] = React.useState({ code: '', name: '', description: '' });
  const [errors, setErrors] = React.useState<{ code?: string; name?: string }>({});
  React.useEffect(() => {
    if (account) {
      setForm({ code: account.code, name: account.name, description: account.description ?? '' });
      setErrors({});
    }
  }, [account]);
  if (!account) return <Dialog open={false} onClose={onClose} title="Edit account">{null}</Dialog>;
  const dirty = form.code !== account.code || form.name !== account.name || form.description !== (account.description ?? '');

  const save = (extra: Partial<{ isActive: boolean }> = {}) =>
    update.mutate(
      { id: account.id, input: { version: account.version, code: form.code.trim(), name: form.name.trim(), description: form.description.trim() || null, ...extra } },
      {
        onSuccess: () => {
          toast.success(extra.isActive === false ? 'Account archived' : extra.isActive === true ? 'Account restored' : 'Account updated');
          onClose();
        },
        onError: (e) => onError(e, 'Could not update account'),
      },
    );

  const submit = () => {
    const next: typeof errors = {};
    if (!form.code.trim()) next.code = 'Code is required';
    if (!form.name.trim()) next.name = 'Name is required';
    setErrors(next);
    if (next.code) return void document.getElementById('ecode')?.focus();
    if (next.name) return void document.getElementById('ename')?.focus();
    save();
  };

  const archive = async () => {
    const ok = await confirm({
      title: `Archive ${account.code} ${account.name}?`,
      description: 'It stays in reports and history but no longer appears when you pick a category or account. You can restore it any time with "Show archived".',
      confirmLabel: 'Archive',
      tone: 'danger',
    });
    if (ok) save({ isActive: false });
  };
  const restore = async () => {
    const ok = await confirm({ title: `Restore ${account.code} ${account.name}?`, description: 'It will show up again when you pick a category or account.', confirmLabel: 'Restore' });
    if (ok) save({ isActive: true });
  };

  return (
    <Dialog
      open={Boolean(account)}
      onClose={onClose}
      onSubmit={submit}
      dirty={dirty && !update.isPending}
      title={`Edit ${account.code} ${account.name}`}
      description={
        isDocumentDriven(account)
          ? 'Only invoices, payments and credit notes you record in Evenbooks change this account, so its balance always matches them. You can rename or renumber it, but not archive it. Track money owed to you outside Evenbooks in an account of its own.'
          : account.isSystem
            ? 'Built-in account: you can rename or renumber it, but not archive it.'
            : undefined
      }
      footer={
        <>
          {!account.isSystem && account.isActive && (
            <Button variant="danger" className="sm:mr-auto" onClick={() => void archive()} disabled={update.isPending}>
              Archive
            </Button>
          )}
          {!account.isActive && (
            <Button variant="secondary" className="sm:mr-auto" onClick={() => void restore()} disabled={update.isPending}>
              Restore
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={update.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Code" htmlFor="ecode" required error={errors.code}>
          <Input id="ecode" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} aria-invalid={errors.code ? true : undefined} data-autofocus />
        </Field>
        <Field label="Name" htmlFor="ename" required error={errors.name}>
          <Input id="ename" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-invalid={errors.name ? true : undefined} />
        </Field>
        <Field label="Description" htmlFor="edesc">
          <Textarea id="edesc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}
