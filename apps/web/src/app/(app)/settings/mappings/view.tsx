'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Copy, Save, Search, Sparkles } from 'lucide-react';
import { Button, LinkButton } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Checkbox, Field, Input, Select } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useConfirm } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { EXCLUDED_LINE_CODE, type MappingAccount, type MappingEntry, type ScheduleCLineDef, useCopyMappings, useMappings, useSaveMappings } from '@/lib/queries/mappings';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';
import { useCompany } from '@/components/company-context';
import { capitalize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { taxYears } from '@/lib/tax-years';
import { suggestLine } from './suggest';

const TAX_YEARS = taxYears();
const UNMAPPED = '';

const DISCARD = {
  title: 'Discard unsaved changes?',
  confirmLabel: 'Discard changes',
  cancelLabel: 'Keep editing',
  tone: 'danger' as const,
};

export function MappingsView() {
  const { isAdmin } = useCompany();
  const router = useRouter();
  const sp = useSearchParams();
  const confirm = useConfirm();
  const currentYear = React.useMemo(() => new Date().getFullYear(), []);
  const yearParam = Number(sp.get('year'));
  const year = TAX_YEARS.includes(yearParam) ? yearParam : TAX_YEARS.includes(currentYear) ? currentYear : TAX_YEARS[TAX_YEARS.length - 1]!;

  const q = useMappings(year);
  const save = useSaveMappings(year);
  const copy = useCopyMappings(year);
  const toast = useToast();
  const onError = useMutationErrorHandler();

  // Unsaved edits keyed by account id; cleared when the year changes or a save lands.
  const [pending, setPending] = React.useState<Record<string, string | null>>({});
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [search, setSearch] = React.useState('');
  const [unmappedOnly, setUnmappedOnly] = React.useState(false);
  const [bulkLine, setBulkLine] = React.useState('');
  const [shownYear, setShownYear] = React.useState(year);
  if (shownYear !== year) {
    setShownYear(year);
    setPending({});
    setSelected(new Set());
  }

  const changed = React.useMemo(() => {
    if (!q.data) return [] as MappingEntry[];
    const byId = new Map(q.data.accounts.map((a) => [a.id, a.lineCode]));
    return Object.entries(pending)
      .filter(([id, code]) => byId.has(id) && (byId.get(id) ?? null) !== code)
      .map(([accountId, lineCode]) => ({ accountId, lineCode }));
  }, [pending, q.data]);
  const dirty = changed.length > 0;
  const guard = useUnsavedChanges(dirty);

  const valueFor = (a: MappingAccount) => (a.id in pending ? pending[a.id] : a.lineCode) ?? UNMAPPED;
  const dirtyIds = React.useMemo(() => new Set(changed.map((c) => c.accountId)), [changed]);

  const setYear = async (y: number) => {
    if (dirty && !(await confirm({ ...DISCARD, description: `Your ${changed.length} unsaved ${changed.length === 1 ? 'change' : 'changes'} for ${year} will be lost.` }))) return;
    guard.markSaved();
    const next = new URLSearchParams(sp.toString());
    next.set('year', String(y));
    router.replace(`/settings/mappings?${next.toString()}`);
  };

  const onSave = () => {
    if (!dirty) return;
    save.mutate(changed, {
      onSuccess: () => {
        setPending({});
        setSelected(new Set());
        toast.success('Mappings saved', `${changed.length} ${changed.length === 1 ? 'account' : 'accounts'} updated for ${year}.`);
      },
      onError: (e) => onError(e, 'Could not save mappings'),
    });
  };

  const onCopy = async () => {
    if (
      dirty &&
      !(await confirm({
        ...DISCARD,
        description: `Copying from ${year - 1} reloads the ${year} mappings, so your ${changed.length} unsaved ${changed.length === 1 ? 'change' : 'changes'} will be lost.`,
        confirmLabel: 'Discard and copy',
      }))
    )
      return;
    copy.mutate(year - 1, {
      onSuccess: (d) => {
        setPending({});
        toast.success(`Copied ${d.copied} ${d.copied === 1 ? 'mapping' : 'mappings'} from ${year - 1}`);
      },
      onError: (e) => onError(e, 'Could not copy mappings'),
    });
  };

  const accountsAll = React.useMemo(() => q.data?.accounts ?? [], [q.data]);
  const onSuggest = () => {
    const next: Record<string, string | null> = {};
    for (const a of accountsAll) {
      if (valueFor(a) !== UNMAPPED) continue;
      const code = suggestLine(a.name, a.type);
      if (code) next[a.id] = code;
    }
    const n = Object.keys(next).length;
    if (n === 0) {
      toast.info('No suggestions', 'No unmapped account name matched a Schedule C line.');
      return;
    }
    setPending((p) => ({ ...p, ...next }));
    toast.success(`Suggested lines for ${n} ${n === 1 ? 'account' : 'accounts'}`, 'Review the highlighted rows, then save.');
  };

  const lines = q.data?.lines ?? [];
  const incomeLines = lines.filter((l) => l.part === 'income');
  const expenseLines = lines.filter((l) => l.part === 'expense');
  const needle = search.trim().toLowerCase();
  const visible = (a: MappingAccount) =>
    (!needle || a.code.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle)) && (!unmappedOnly || valueFor(a) === UNMAPPED || dirtyIds.has(a.id));
  const incomeAccounts = accountsAll.filter((a) => a.type === 'income');
  const expenseAccounts = accountsAll.filter((a) => a.type === 'expense');
  const shownIncome = incomeAccounts.filter(visible);
  const shownExpense = expenseAccounts.filter(visible);
  const unmappedCount = accountsAll.filter((a) => a.isActive && valueFor(a) === UNMAPPED).length;
  const filtering = !!needle || unmappedOnly;
  const disabled = !isAdmin || save.isPending;

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const toggleAll = (ids: string[], on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      for (const id of ids) {
        if (on) n.add(id);
        else n.delete(id);
      }
      return n;
    });

  const assignSelected = () => {
    if (!bulkLine || selected.size === 0) return;
    const code = bulkLine === '__unmapped' ? null : bulkLine;
    const n = selected.size;
    setPending((p) => {
      const next = { ...p };
      for (const id of selected) next[id] = code;
      return next;
    });
    setSelected(new Set());
    setBulkLine('');
    toast.success(`Assigned ${n} ${n === 1 ? 'account' : 'accounts'}`, 'Save to keep the change.');
  };

  const onChange = (id: string, code: string | null) => setPending((p) => ({ ...p, [id]: code }));
  const tableProps = { valueFor, dirtyIds, disabled, onChange, selected, onToggle: toggle, onToggleAll: toggleAll };

  return (
    <>
      <PageHeader
        title="Schedule C mappings"
        description="Choose which tax-form line each category goes on. This only decides where totals are added up on the Schedule C summary; it doesn’t decide what is deductible."
        actions={
          <>
            <LinkButton href="/settings" variant="secondary">
              All settings
            </LinkButton>
            <LinkButton href={`/reports/schedule-c?taxYear=${year}`} variant="secondary">
              View summary
            </LinkButton>
          </>
        }
      />

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3 p-3">
          <Field label="Tax year" htmlFor="year">
            <Select id="year" value={String(year)} onChange={(e) => void setYear(Number(e.target.value))}>
              {TAX_YEARS.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Search accounts" htmlFor="mapping-search" className="min-w-56">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-stone-400" aria-hidden />
              <Input id="mapping-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Code or name" className="pl-8" />
            </div>
          </Field>
          <Checkbox label="Unmapped only" checked={unmappedOnly} onChange={(e) => setUnmappedOnly(e.target.checked)} className="h-9" />
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={onSuggest} disabled={disabled || !q.data || unmappedCount === 0} title={isAdmin ? 'Guess a line for each unmapped account from its name' : 'Administrator role required'}>
              <Sparkles className="size-4" aria-hidden /> Suggest lines
            </Button>
            <Button variant="secondary" onClick={() => void onCopy()} loading={copy.isPending} disabled={!isAdmin || !q.data} title={isAdmin ? undefined : 'Administrator role required'}>
              <Copy className="size-4" aria-hidden /> Copy from {year - 1}
            </Button>
          </div>
        </div>
        {!isAdmin && <CardBody className="border-t border-stone-200 text-sm text-stone-600">Only administrators can change tax lines. You can see where each category goes below.</CardBody>}
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-stone-200 bg-brand-50/40 px-3 py-2" role="group" aria-label="Bulk assign" data-testid="mappings-bulk">
            <span className="text-sm font-medium text-stone-800">
              {selected.size} selected
            </span>
            <Select aria-label="Line for selected accounts" value={bulkLine} onChange={(e) => setBulkLine(e.target.value)} disabled={disabled} className="w-72">
              <option value="">Assign selected to line…</option>
              <LineOptions income={incomeLines} expense={expenseLines} />
              <option value="__unmapped">— unmapped —</option>
            </Select>
            <Button size="sm" onClick={assignSelected} disabled={disabled || !bulkLine}>
              Assign
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        )}
      </Card>

      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.accounts.length === 0 && <EmptyState title="No income or expense categories" description="Add categories in the chart of accounts first." action={<LinkButton href="/accounts">Chart of accounts</LinkButton>} />}
      {q.data && q.data.accounts.length > 0 && (
        <div className={cn('space-y-4', q.isPlaceholderData && 'opacity-60 transition-opacity')} aria-busy={q.isPlaceholderData || undefined}>
          {unmappedCount > 0 && (
            <p className="text-sm text-stone-600" data-testid="mappings-unmapped-count">
              {unmappedCount} active {unmappedCount === 1 ? 'category has' : 'categories have'} no line for {year} yet; their totals are listed separately on the{' '}
              <Link href={`/reports/schedule-c?taxYear=${year}`} className="text-brand-700 underline">
                Schedule C summary
              </Link>
              .
            </p>
          )}
          {filtering && shownIncome.length === 0 && shownExpense.length === 0 && (
            <EmptyState title="No accounts match" description={unmappedOnly ? 'Every matching account is mapped.' : 'Try another search.'} />
          )}
          {(!filtering || shownIncome.length > 0) && (
            <MappingTable title="Income categories" total={incomeAccounts.length} accounts={shownIncome} primary={incomeLines} secondary={expenseLines} primaryLabel="Part I — Income" secondaryLabel="Part II — Expenses" {...tableProps} />
          )}
          {(!filtering || shownExpense.length > 0) && (
            <MappingTable title="Expense categories" total={expenseAccounts.length} accounts={shownExpense} primary={expenseLines} secondary={incomeLines} primaryLabel="Part II — Expenses" secondaryLabel="Part I — Income" {...tableProps} />
          )}
        </div>
      )}

      {/* Always in view at the bottom of the window while there is something to save. */}
      <div className="sticky bottom-0 z-20 mt-4 -mb-4 border-t border-stone-200 bg-white/95 py-3 backdrop-blur print:hidden" data-testid="mappings-save-bar">
        <div className="flex flex-wrap items-center justify-end gap-3">
          {dirty ? (
            <span data-testid="mappings-unsaved">
              <Badge tone="amber" className="whitespace-nowrap">
                {changed.length} unsaved {changed.length === 1 ? 'change' : 'changes'}
              </Badge>
            </span>
          ) : (
            <span className="text-sm text-stone-500">All changes saved</span>
          )}
          {dirty && (
            <Button variant="ghost" size="sm" onClick={() => setPending({})} disabled={save.isPending}>
              Discard
            </Button>
          )}
          <Button onClick={onSave} loading={save.isPending} disabled={!isAdmin || !dirty}>
            <Save className="size-4" aria-hidden /> Save
          </Button>
        </div>
      </div>
    </>
  );
}

function LineOptions({ income, expense }: { income: ScheduleCLineDef[]; expense: ScheduleCLineDef[] }) {
  return (
    <>
      <optgroup label="Part I — Income">
        {income.map((l) => (
          <option key={l.code} value={l.code}>
            {l.code} · {l.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="Part II — Expenses">
        {expense.map((l) => (
          <option key={l.code} value={l.code}>
            {l.code} · {l.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="Other">
        <option value={EXCLUDED_LINE_CODE}>Not on Schedule C</option>
      </optgroup>
    </>
  );
}

function MappingTable({
  title,
  total,
  accounts,
  primary,
  secondary,
  primaryLabel,
  secondaryLabel,
  valueFor,
  dirtyIds,
  disabled,
  onChange,
  selected,
  onToggle,
  onToggleAll,
}: {
  title: string;
  total: number;
  accounts: MappingAccount[];
  primary: ScheduleCLineDef[];
  secondary: ScheduleCLineDef[];
  primaryLabel: string;
  secondaryLabel: string;
  valueFor: (a: MappingAccount) => string;
  dirtyIds: Set<string>;
  disabled: boolean;
  onChange: (accountId: string, lineCode: string | null) => void;
  selected: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  onToggleAll: (ids: string[], on: boolean) => void;
}) {
  const ids = accounts.map((a) => a.id);
  const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
  const someOn = !allOn && ids.some((id) => selected.has(id));
  const headRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (headRef.current) headRef.current.indeterminate = someOn;
  }, [someOn]);
  return (
    <Card>
      <CardHeader title={title} description={accounts.length === total ? `${total} ${total === 1 ? 'account' : 'accounts'}` : `${accounts.length} of ${total} accounts shown`} />
      {accounts.length === 0 ? (
        <CardBody>
          <p className="text-sm text-stone-500">None.</p>
        </CardBody>
      ) : (
        <Table aria-label={title} stickyHeader>
          <THead>
            <TR>
              <TH className="w-10">
                <input
                  ref={headRef}
                  type="checkbox"
                  aria-label={`Select all ${title.toLowerCase()} shown`}
                  checked={allOn}
                  disabled={disabled}
                  onChange={(e) => onToggleAll(ids, e.target.checked)}
                  className="size-4 rounded border-stone-300 text-brand-600 focus:ring-brand-500"
                />
              </TH>
              <TH className="w-24">Code</TH>
              <TH>Category</TH>
              <TH className="w-80">Schedule C line</TH>
            </TR>
          </THead>
          <TBody>
            {accounts.map((a) => {
              const value = valueFor(a);
              const isDirty = dirtyIds.has(a.id);
              return (
                <TR key={a.id} className={cn(isDirty && 'bg-amber-50/60', !a.isActive && 'text-stone-400')} data-testid="mapping-row" data-dirty={isDirty || undefined}>
                  <TD>
                    <input
                      type="checkbox"
                      aria-label={`Select ${a.code} ${a.name}`}
                      checked={selected.has(a.id)}
                      disabled={disabled}
                      onChange={(e) => onToggle(a.id, e.target.checked)}
                      className="size-4 rounded border-stone-300 text-brand-600 focus:ring-brand-500"
                    />
                  </TD>
                  <TD className="font-mono text-xs text-stone-500">{a.code}</TD>
                  <TD>
                    {a.name}
                    {!a.isActive && (
                      <Badge tone="neutral" className="ml-2">
                        Archived
                      </Badge>
                    )}
                  </TD>
                  <TD>
                    <Select
                      aria-label={`Schedule C line for ${a.code} ${a.name}`}
                      value={value}
                      disabled={disabled}
                      onChange={(e) => onChange(a.id, e.target.value === UNMAPPED ? null : e.target.value)}
                      className={cn(value === UNMAPPED && 'text-stone-500')}
                    >
                      <option value={UNMAPPED}>— unmapped —</option>
                      <optgroup label={primaryLabel}>
                        {primary.map((l) => (
                          <option key={l.code} value={l.code}>
                            {l.code} · {l.label}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label={secondaryLabel}>
                        {secondary.map((l) => (
                          <option key={l.code} value={l.code}>
                            {l.code} · {l.label}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Other">
                        <option value={EXCLUDED_LINE_CODE}>Not on Schedule C</option>
                      </optgroup>
                    </Select>
                    {value === EXCLUDED_LINE_CODE && <p className="mt-1 text-xs text-stone-500">Left off every line; still counted in your other reports.</p>}
                    {!a.isActive && value === UNMAPPED && <p className="mt-1 text-xs text-stone-400">{capitalize(a.type)} account is archived.</p>}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
