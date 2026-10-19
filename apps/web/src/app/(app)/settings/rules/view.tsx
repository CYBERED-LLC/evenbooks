'use client';
import * as React from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import type { CreateRuleInput, RuleDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { MoneyInput } from '@/components/ui/money-input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { AccountPicker } from '@/components/account-picker';
import { ContactPicker } from '@/components/contact-picker';
import { useBankAccountsForInbox } from '@/lib/queries/inbox';
import { useCreateRule, useDeleteRule, useRules, useToggleRule, useUpdateRule } from '@/lib/queries/rules';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { capitalize, formatMoney } from '@/lib/format';
import { compareDecimals, isValidDecimal } from '@/lib/decimal';
import { useCompany } from '@/components/company-context';
import { useListParams } from '@/lib/use-list-params';
import { useHotkeys } from '@/lib/use-hotkeys';

const MATCH_TYPES: RuleDto['matchType'][] = ['contains', 'starts_with', 'equals'];
const MATCH_FIELDS: RuleDto['matchField'][] = ['description', 'payee', 'any'];
const DIRECTIONS: { v: RuleDto['direction']; l: string }[] = [
  { v: 'any', l: 'Money in or out' },
  { v: 'out', l: 'Money out' },
  { v: 'in', l: 'Money in' },
];

const HELP = 'Rules only suggest an account; every imported transaction is still reviewed before posting.';

export function RulesView() {
  const { company } = useCompany();
  const q = useRules();
  const lp = useListParams();
  const bankAccounts = useBankAccountsForInbox();
  const toggle = useToggleRule();
  const del = useDeleteRule();
  const confirm = useConfirm();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<RuleDto | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  useHotkeys({ n: () => setCreating(true), '/': () => searchRef.current?.focus() });

  const bankName = (id: string | null) => (id ? ((bankAccounts.data ?? []).find((b) => b.id === id)?.name ?? '…') : 'Any account');
  const range = (r: RuleDto) => {
    if (r.amountMin && r.amountMax) return `${formatMoney(r.amountMin, company.baseCurrency)} – ${formatMoney(r.amountMax, company.baseCurrency)}`;
    if (r.amountMin) return `≥ ${formatMoney(r.amountMin, company.baseCurrency)}`;
    if (r.amountMax) return `≤ ${formatMoney(r.amountMax, company.baseCurrency)}`;
    return 'Any amount';
  };

  const needle = (lp.get('q') ?? '').toLowerCase();
  const rows = (q.data ?? []).filter(
    (r) => !needle || r.name.toLowerCase().includes(needle) || r.pattern.toLowerCase().includes(needle) || (r.accountName ?? '').toLowerCase().includes(needle),
  );

  const remove = async (r: RuleDto) => {
    const ok = await confirm({
      title: 'Delete rule?',
      description: `“${r.name}” will stop suggesting accounts. Transactions already categorized are not affected. This cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    del.mutate(r.id, { onSuccess: () => toast.success('Rule deleted'), onError: (e) => onError(e, 'Could not delete rule') });
  };

  return (
    <>
      <PageHeader title="Categorization rules" description={HELP} actions={<Button onClick={() => setCreating(true)}>New rule</Button>} />
      {q.data && q.data.length > 0 && (
        <div className="relative mb-3 max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-stone-400" aria-hidden />
          <Input
            ref={searchRef}
            type="search"
            aria-label="Search rules"
            placeholder="Search name, pattern or account…"
            className="pl-8"
            value={lp.search}
            onChange={(e) => lp.setSearch(e.target.value)}
          />
        </div>
      )}
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.length === 0 && (
        <EmptyState
          title="No rules yet"
          description="Create a rule here, or tick “Create a rule” while categorizing a transaction in the review inbox."
          action={<Button onClick={() => setCreating(true)}>New rule</Button>}
        />
      )}
      {q.data && q.data.length > 0 && rows.length === 0 && <EmptyState title="No rules match" description="Try a different search." />}
      {rows.length > 0 && (
        <Card>
          <Table aria-label="Categorization rules">
            <THead>
              <TR>
                <TH className="w-16">Priority</TH>
                <TH>Rule</TH>
                <TH className="hidden md:table-cell">Applies to</TH>
                <TH>Suggests</TH>
                <TH numeric className="hidden sm:table-cell">
                  Hits
                </TH>
                <TH className="w-20">Active</TH>
                <TH className="w-32">
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.id} className={!r.isActive ? 'text-stone-500' : undefined}>
                  <TD className="tabular">{r.priority}</TD>
                  <TD>
                    <span className="font-medium">{r.name}</span>
                    {!r.isActive && (
                      <Badge tone="neutral" className="ml-2">
                        Inactive
                      </Badge>
                    )}
                    <p className="text-xs text-stone-500">
                      {capitalize(r.matchField)} {r.matchType.replace('_', ' ')} <code className="rounded bg-stone-100 px-1">{r.pattern}</code>
                    </p>
                    {r.matchType !== 'regex' && (
                      <Link href={`/banking/inbox?q=${encodeURIComponent(r.pattern)}`} className="text-xs font-medium text-brand-700 hover:underline">
                        Show matching transactions
                      </Link>
                    )}
                  </TD>
                  <TD className="hidden text-stone-600 md:table-cell">
                    {DIRECTIONS.find((d) => d.v === r.direction)?.l} · {bankName(r.bankAccountId)} · {range(r)}
                  </TD>
                  <TD>{r.accountName ?? r.accountId}</TD>
                  <TD numeric className="hidden sm:table-cell">
                    {r.hitCount}
                  </TD>
                  <TD>
                    <ActiveSwitch
                      checked={r.isActive}
                      label={`Active: ${r.name}`}
                      onChange={(isActive) =>
                        toggle.mutate(
                          { rule: r, isActive },
                          { onSuccess: () => toast.success(isActive ? 'Rule turned on' : 'Rule turned off'), onError: (e) => onError(e, 'Could not update rule') },
                        )
                      }
                    />
                  </TD>
                  <TD>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(r)} aria-label={`Edit rule ${r.name}`}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void remove(r)} aria-label={`Delete rule ${r.name}`}>
                        Delete
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      <RuleDialog open={creating || Boolean(editing)} rule={editing} onClose={() => (editing ? setEditing(null) : setCreating(false))} />
    </>
  );
}

function ActiveSwitch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-brand-600' : 'bg-stone-300'}`}
    >
      <span className={`inline-block size-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </button>
  );
}

interface RuleForm {
  name: string;
  priority: string;
  bankAccountId: string;
  direction: RuleDto['direction'];
  matchField: RuleDto['matchField'];
  matchType: RuleDto['matchType'];
  pattern: string;
  amountMin: string;
  amountMax: string;
  accountId: string;
  contactId: string | null;
  memo: string;
  isActive: boolean;
}

const blank = (): RuleForm => ({
  name: '',
  priority: '100',
  bankAccountId: '',
  direction: 'any',
  matchField: 'description',
  matchType: 'contains',
  pattern: '',
  amountMin: '',
  amountMax: '',
  accountId: '',
  contactId: null,
  memo: '',
  isActive: true,
});

/** "BLUE COFFEE" → "Blue Coffee": a readable default name for a new rule. */
const nameFromPattern = (p: string) => p.trim().toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());

function RuleDialog({ open, rule, onClose }: { open: boolean; rule: RuleDto | null; onClose: () => void }) {
  const create = useCreateRule();
  const update = useUpdateRule();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const bankAccounts = useBankAccountsForInbox();
  const [form, setForm] = React.useState<RuleForm>(blank());
  const [initial, setInitial] = React.useState<RuleForm>(blank());
  const [nameTouched, setNameTouched] = React.useState(false);
  const [error, setError] = React.useState<{ field?: string; message: string } | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    const next: RuleForm = rule
      ? {
          name: rule.name,
          priority: String(rule.priority),
          bankAccountId: rule.bankAccountId ?? '',
          direction: rule.direction,
          matchField: rule.matchField,
          matchType: rule.matchType,
          pattern: rule.pattern,
          amountMin: rule.amountMin ?? '',
          amountMax: rule.amountMax ?? '',
          accountId: rule.accountId,
          contactId: rule.contactId ?? null,
          memo: rule.memo ?? '',
          isActive: rule.isActive,
        }
      : blank();
    setForm(next);
    setInitial(next);
    setNameTouched(Boolean(rule));
  }, [open, rule]);

  const set = <K extends keyof RuleForm>(k: K, v: RuleForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setPattern = (pattern: string) => setForm((f) => ({ ...f, pattern, name: nameTouched ? f.name : nameFromPattern(pattern) }));
  const pending = create.isPending || update.isPending;
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) && !pending;

  const fail = (field: string, message: string) => {
    setError({ field, message });
    document.getElementById(field)?.focus();
  };

  const submit = () => {
    setError(null);
    if (!form.pattern.trim()) return fail('rule-pattern', 'Pattern is required.');
    if (form.matchType === 'regex') return fail('rule-type', 'Choose a text match; regular expression rules are no longer supported.');
    const name = form.name.trim() || nameFromPattern(form.pattern);
    if (!form.accountId) return fail('rule-account', 'Choose the account to suggest.');
    const priority = Number(form.priority);
    if (!Number.isInteger(priority) || priority < 1 || priority > 10000) return fail('rule-priority', 'Priority must be a whole number from 1 to 10000.');
    if (form.amountMin && (!isValidDecimal(form.amountMin) || compareDecimals(form.amountMin, '0') <= 0)) return fail('rule-min', 'Minimum amount must be a positive amount.');
    if (form.amountMax && (!isValidDecimal(form.amountMax) || compareDecimals(form.amountMax, '0') <= 0)) return fail('rule-max', 'Maximum amount must be a positive amount.');
    if (form.amountMin && form.amountMax && compareDecimals(form.amountMin, form.amountMax) > 0) return fail('rule-max', 'Maximum must be at least the minimum.');
    const input: CreateRuleInput = {
      name,
      priority,
      bankAccountId: form.bankAccountId || null,
      direction: form.direction,
      matchField: form.matchField,
      matchType: form.matchType,
      pattern: form.pattern.trim(),
      amountMin: form.amountMin.trim() || null,
      amountMax: form.amountMax.trim() || null,
      accountId: form.accountId,
      contactId: form.contactId || null,
      memo: form.memo.trim() || null,
    };
    if (rule) {
      update.mutate(
        { id: rule.id, input: { ...input, version: rule.version, isActive: form.isActive } },
        {
          onSuccess: () => {
            toast.success('Rule updated');
            onClose();
          },
          onError: (e) => onError(e, 'Could not update rule'),
        },
      );
    } else {
      create.mutate(input, {
        onSuccess: () => {
          toast.success('Rule created');
          onClose();
        },
        onError: (e) => onError(e, 'Could not create rule'),
      });
    }
  };

  const err = (field: string) => (error?.field === field ? error.message : undefined);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={rule ? `Edit rule: ${rule.name}` : 'New rule'}
      description={HELP}
      onSubmit={submit}
      dirty={dirty}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            {rule ? 'Save' : 'Create rule'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Match field" htmlFor="rule-field">
          <Select id="rule-field" value={form.matchField} onChange={(e) => set('matchField', e.target.value as RuleDto['matchField'])}>
            {MATCH_FIELDS.map((f) => (
              <option key={f} value={f}>
                {f === 'any' ? 'Description or payee' : capitalize(f)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Match type" htmlFor="rule-type">
          <Select id="rule-type" value={form.matchType} onChange={(e) => set('matchType', e.target.value as RuleDto['matchType'])}>
            {form.matchType === 'regex' && <option value="regex" disabled>Unsupported regex — choose text matching</option>}
            {MATCH_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace('_', ' ')}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Pattern"
          htmlFor="rule-pattern"
          required
          className="sm:col-span-2"
          error={err('rule-pattern')}
          hint={
            <>
              {form.matchType === 'regex' ? 'Legacy regular expression is disabled. Choose a text match.' : 'Case-insensitive text match.'}
              {form.pattern.trim() && form.matchType !== 'regex' && (
                <>
                  {' '}
                  <Link href={`/banking/inbox?q=${encodeURIComponent(form.pattern.trim())}`} target="_blank" className="font-medium text-brand-700 hover:underline">
                    Show matching transactions
                  </Link>
                </>
              )}
            </>
          }
        >
          <Input id="rule-pattern" data-autofocus value={form.pattern} aria-invalid={err('rule-pattern') ? true : undefined} onChange={(e) => setPattern(e.target.value)} placeholder="COFFEE" />
        </Field>
        <Field label="Name" htmlFor="rule-name" required className="sm:col-span-2" hint={!nameTouched ? 'Filled in from the pattern; change it if you like.' : undefined}>
          <Input
            id="rule-name"
            value={form.name}
            onChange={(e) => {
              setNameTouched(true);
              set('name', e.target.value);
            }}
            placeholder="Coffee shops"
          />
        </Field>
        <Field label="Direction" htmlFor="rule-direction">
          <Select id="rule-direction" value={form.direction} onChange={(e) => set('direction', e.target.value as RuleDto['direction'])}>
            {DIRECTIONS.map((d) => (
              <option key={d.v} value={d.v}>
                {d.l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Bank account" htmlFor="rule-bank">
          <Select id="rule-bank" value={form.bankAccountId} onChange={(e) => set('bankAccountId', e.target.value)}>
            <option value="">Any account</option>
            {(bankAccounts.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Minimum amount" htmlFor="rule-min" hint="Absolute amount; leave blank for no minimum." error={err('rule-min')}>
          <MoneyInput id="rule-min" value={form.amountMin} onChange={(v) => set('amountMin', v)} />
        </Field>
        <Field label="Maximum amount" htmlFor="rule-max" error={err('rule-max')}>
          <MoneyInput id="rule-max" value={form.amountMax} onChange={(v) => set('amountMax', v)} />
        </Field>
        <Field label="Suggest account" htmlFor="rule-account" required className="sm:col-span-2" error={err('rule-account')}>
          <AccountPicker
            id="rule-account"
            value={form.accountId}
            onChange={(id) => set('accountId', id ?? '')}
            prefer={form.direction === 'in' ? (a) => a.type === 'income' : form.direction === 'out' ? (a) => a.type === 'expense' : undefined}
            preferLabel={form.direction === 'in' ? 'Income' : 'Expenses'}
            recentKey="rule-account"
            invalid={!!err('rule-account')}
          />
        </Field>
        <ContactPicker label="Contact" id="rule-contact" value={form.contactId} onChange={(id) => set('contactId', id)} clearable placeholder="None" />
        <Field label="Priority" htmlFor="rule-priority" hint="Lower numbers are checked first." error={err('rule-priority')}>
          <Input id="rule-priority" inputMode="numeric" value={form.priority} onChange={(e) => set('priority', e.target.value)} />
        </Field>
        <Field label="Memo" htmlFor="rule-memo" className="sm:col-span-2">
          <Textarea id="rule-memo" rows={2} value={form.memo} onChange={(e) => set('memo', e.target.value)} />
        </Field>
        {rule && (
          <div className="flex items-center gap-2 text-sm sm:col-span-2">
            <ActiveSwitch checked={form.isActive} label="Active" onChange={(v) => set('isActive', v)} />
            <span>{form.isActive ? 'Active' : 'Inactive'}</span>
          </div>
        )}
      </div>
    </Dialog>
  );
}
