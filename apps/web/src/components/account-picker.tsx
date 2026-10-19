'use client';
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AccountDto, AccountType } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useCompany, useToday } from '@/components/company-context';
import { accountsOptions, useAccounts, useCreateAccount } from '@/lib/queries/accounts';
import { EXCLUDED_LINE_CODE, useMappings } from '@/lib/queries/mappings';
import { scheduleCApplies } from '@/lib/queries/reports';
import { suggestLine } from '@/app/(app)/settings/mappings/suggest';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { useRecent } from '@/lib/use-recent';
import { capitalize } from '@/lib/format';

export const ACCOUNT_TYPES: AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense'];
const TYPE_GROUP: Record<AccountType, string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', expense: 'Expenses' };

export const accountLabel = (a: Pick<AccountDto, 'code' | 'name'>) => `${a.code} ${a.name}`;

/** One line per account type, in plain words, shown under the Type field. */
export const ACCOUNT_TYPE_HELP: Record<AccountType, string> = {
  asset: 'Asset: something the business has, such as a bank account, equipment, or money customers owe you.',
  liability: 'Liability: something the business owes, such as a credit card balance or a loan.',
  equity: 'Equity: money you put in or took out, and profit kept in the business.',
  income: 'Income: money you earn, such as sales or fees from customers.',
  expense: 'Expense: something you spend money on to run the business.',
};

export interface AccountPickerProps {
  id?: string;
  value: string | null | undefined;
  onChange(id: string | null, account: AccountDto | null): void;
  /** Hard limit: only these accounts are offered. */
  allow?: (a: AccountDto) => boolean;
  /** Soft preference: listed first under `preferLabel`; every other allowed account follows by type. */
  prefer?: (a: AccountDto) => boolean;
  preferLabel?: string;
  /** Remembers the last few picks under this key (per company) and lists them first. */
  recentKey?: string;
  /** Offer "+ New account" with this type preselected; `false` hides it. Defaults to the preferred type. */
  createType?: AccountType | false;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  clearable?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'data-autofocus'?: boolean;
  autoFocus?: boolean;
}

/**
 * Searchable account picker: matches on code or name, groups by type, lists
 * recent and likely accounts first, and can create an account inline. The
 * selected account always shows, even if it is archived or outside `allow`.
 */
export function AccountPicker({
  id,
  value,
  onChange,
  allow,
  prefer,
  preferLabel = 'Suggested',
  recentKey,
  createType,
  placeholder = 'Search accounts…',
  disabled,
  required,
  invalid,
  clearable,
  className,
  autoFocus,
  ...aria
}: AccountPickerProps) {
  const { company } = useCompany();
  const accounts = useAccounts();
  const all = React.useMemo(() => accounts.data ?? [], [accounts.data]);
  const known = value ? all.find((a) => a.id === value) : undefined;
  // An archived selection is not in the active list; look it up so its name still shows.
  const archived = useQuery({ ...accountsOptions(company.id, { includeArchived: true }), enabled: !!value && accounts.isSuccess && !known });
  const selectedAccount = known ?? archived.data?.find((a) => a.id === value);
  const recent = useRecent(recentKey);
  const [creating, setCreating] = React.useState<{ query: string } | null>(null);

  const allowed = React.useMemo(() => all.filter((a) => a.isActive && (!allow || allow(a))), [all, allow]);

  const options = React.useMemo(() => {
    const byId = new Map(allowed.map((a) => [a.id, a]));
    const used = new Set<string>();
    const out: ComboboxOption[] = [];
    const opt = (a: AccountDto, group: string, showType: boolean): ComboboxOption => ({
      value: a.id,
      label: accountLabel(a),
      group,
      hint: showType ? TYPE_GROUP[a.type] : undefined,
      description: a.description ?? undefined,
      keywords: `${a.type} ${TYPE_GROUP[a.type]} ${a.role ?? ''}`,
    });
    for (const rid of recent.ids) {
      const a = byId.get(rid);
      if (a && !used.has(a.id)) {
        out.push(opt(a, 'Recent', true));
        used.add(a.id);
      }
    }
    if (prefer) {
      for (const a of allowed) if (!used.has(a.id) && prefer(a)) {
        out.push(opt(a, preferLabel, true));
        used.add(a.id);
      }
    }
    for (const t of ACCOUNT_TYPES) {
      for (const a of allowed) if (a.type === t && !used.has(a.id)) {
        out.push(opt(a, TYPE_GROUP[t], false));
        used.add(a.id);
      }
    }
    if (selectedAccount && !used.has(selectedAccount.id)) {
      out.unshift({ value: selectedAccount.id, label: accountLabel(selectedAccount), hint: selectedAccount.isActive ? TYPE_GROUP[selectedAccount.type] : 'Archived', group: 'Current' });
    }
    return out;
  }, [allowed, prefer, preferLabel, recent.ids, selectedAccount]);

  const defaultType: AccountType | undefined =
    createType === false ? undefined : (createType ?? (prefer ? allowed.find(prefer)?.type : undefined) ?? (allow ? allowed[0]?.type : undefined) ?? 'expense');

  const pick = (a: AccountDto | null) => {
    if (a) recent.push(a.id);
    onChange(a?.id ?? null, a);
  };

  return (
    <>
      <Combobox
        id={id}
        className={className}
        value={value}
        options={options}
        selectedLabel={selectedAccount ? accountLabel(selectedAccount) : value ? '(unknown account)' : undefined}
        onChange={(v) => pick(v ? (all.find((a) => a.id === v) ?? selectedAccount ?? null) : null)}
        loading={accounts.isPending}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        invalid={invalid}
        clearable={clearable}
        autoFocus={autoFocus}
        emptyText="No account matches"
        onCreate={defaultType ? (q) => setCreating({ query: q }) : undefined}
        createLabel={(q) => (q ? `New account “${q}”` : 'New account…')}
        {...aria}
      />
      {defaultType && (
        <CreateAccountDialog
          open={!!creating}
          onClose={() => setCreating(null)}
          defaultType={defaultType}
          defaultText={creating?.query}
          onCreated={pick}
        />
      )}
    </>
  );
}

/**
 * Next unused numeric code for an account type: 10 past the highest code of that type,
 * else the first free multiple of 10 in the type's block, else any free code in it.
 * Codes stay inside the type's thousand block (expenses may run on to 9999) so an
 * income code never lands among expenses.
 */
export function suggestAccountCode(accounts: AccountDto[], type: AccountType): string {
  const taken = new Set(accounts.map((a) => a.code));
  const base = { asset: 1000, liability: 2000, equity: 3000, income: 4000, expense: 5000 }[type];
  const top = type === 'expense' ? 9999 : base + 999;
  const codes = accounts.filter((a) => a.type === type && /^\d+$/.test(a.code)).map((a) => Number(a.code)).filter((n) => n >= base && n <= top);
  const isFree = (n: number) => n >= base && n <= top && !taken.has(String(n));
  if (codes.length) {
    const next = Math.floor(Math.max(...codes) / 10) * 10 + 10;
    if (isFree(next)) return String(next);
  }
  for (const step of [10, 1]) for (let n = base; n <= top; n += step) if (isFree(n)) return String(n);
  return String(base);
}

export interface CreateAccountDialogProps {
  open: boolean;
  onClose(): void;
  onCreated?(account: AccountDto): void;
  defaultType?: AccountType;
  /** What was typed in a picker: a number becomes the code, anything else the name. */
  defaultText?: string;
}

/** New-account form used by the chart of accounts and by every AccountPicker's "New account" row. */
export function CreateAccountDialog({ open, onClose, onCreated, defaultType = 'expense', defaultText }: CreateAccountDialogProps) {
  const create = useCreateAccount();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const uid = React.useId();
  const accounts = useAccounts({ includeArchived: true });
  const { company } = useCompany();
  const taxYear = Number(useToday().slice(0, 4));
  const [form, setForm] = React.useState({ code: '', name: '', type: defaultType, role: '', description: '', parentId: '', taxLine: '' });
  const [codeTouched, setCodeTouched] = React.useState(false);
  const [lineTouched, setLineTouched] = React.useState(false);
  const [errors, setErrors] = React.useState<{ code?: string; name?: string }>({});

  React.useEffect(() => {
    if (!open) return;
    const text = defaultText?.trim() ?? '';
    const isCode = /^\d+$/.test(text);
    setForm({ code: isCode ? text : '', name: isCode ? '' : text, type: defaultType, role: '', description: '', parentId: '', taxLine: '' });
    setCodeTouched(isCode);
    setLineTouched(false);
    setErrors({});
  }, [open, defaultType, defaultText]);

  // Income and expense categories pick their Schedule C line here, so the summary never shows them unmapped.
  const asksTaxLine = (form.type === 'income' || form.type === 'expense') && scheduleCApplies(company.businessType);
  const mappings = useMappings(taxYear, open && asksTaxLine);
  const taxLines = (mappings.data?.lines ?? []).filter((l) => l.part === form.type);
  const suggestedLine = asksTaxLine ? suggestLine(form.name, form.type) : null;
  const taxLine = lineTouched ? form.taxLine : (suggestedLine ?? '');

  // Suggest a free code for the chosen type until the user types their own.
  const all = accounts.data;
  React.useEffect(() => {
    if (!open || codeTouched || !all) return;
    setForm((f) => ({ ...f, code: suggestAccountCode(all, f.type) }));
  }, [open, codeTouched, all, form.type]);

  const parents = (all ?? []).filter((a) => a.type === form.type && a.isActive);
  const roleOptions =
    form.type === 'asset'
      ? [{ v: 'bank', l: 'Bank account' }]
      : form.type === 'liability'
        ? [{ v: 'credit_card', l: 'Credit card' }]
        : form.type === 'equity'
          ? [
              { v: 'owner_equity', l: 'Owner equity' },
              { v: 'owner_draws', l: 'Owner draws' },
            ]
          : [];

  const submit = () => {
    const next: typeof errors = {};
    if (!form.code.trim()) next.code = 'Code is required';
    else if ((all ?? []).some((a) => a.code === form.code.trim())) next.code = 'Another account already uses this code';
    if (!form.name.trim()) next.name = 'Name is required';
    setErrors(next);
    if (Object.keys(next).length) return;
    create.mutate(
      {
        code: form.code.trim(),
        name: form.name.trim(),
        type: form.type,
        role: (form.role || null) as never,
        parentId: form.parentId || null,
        description: form.description.trim() || null,
        scheduleCLine: asksTaxLine && taxLine ? taxLine : null,
      },
      {
        onSuccess: (a) => {
          toast.success('Account created', accountLabel(a));
          onCreated?.(a);
          onClose();
        },
        onError: (e) => onError(e, 'Could not create account'),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New account"
      onSubmit={submit}
      dirty={!!form.name.trim() && !create.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" htmlFor={`${uid}-type`} required hint={ACCOUNT_TYPE_HELP[form.type]}>
          <Select id={`${uid}-type`} value={form.type} onChange={(e) => {
              setForm({ ...form, type: e.target.value as AccountType, role: '', parentId: '', taxLine: '' });
              setLineTouched(false);
            }}>
            {ACCOUNT_TYPES.map((t) => (
              <option key={t} value={t}>
                {capitalize(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Code" htmlFor={`${uid}-code`} required error={errors.code} hint={!codeTouched ? 'Suggested from your chart; change it if you like.' : undefined}>
          <Input
            id={`${uid}-code`}
            value={form.code}
            aria-invalid={errors.code ? true : undefined}
            onChange={(e) => {
              setCodeTouched(true);
              setForm({ ...form, code: e.target.value });
              setErrors((er) => ({ ...er, code: undefined }));
            }}
          />
        </Field>
        <Field label="Name" htmlFor={`${uid}-name`} required error={errors.name} className="sm:col-span-2">
          <Input
            id={`${uid}-name`}
            data-autofocus
            value={form.name}
            aria-invalid={errors.name ? true : undefined}
            onChange={(e) => {
              setForm({ ...form, name: e.target.value });
              setErrors((er) => ({ ...er, name: undefined }));
            }}
          />
        </Field>
        {asksTaxLine && (
          <Field
            label="Tax form line"
            htmlFor={`${uid}-taxline`}
            className="sm:col-span-2"
            hint={`Where this category goes on Schedule C for ${taxYear}.${!lineTouched && suggestedLine ? ' Suggested from the name; change it if it’s wrong.' : ''}`}
          >
            <Select
              id={`${uid}-taxline`}
              value={taxLine}
              onChange={(e) => {
                setLineTouched(true);
                setForm({ ...form, taxLine: e.target.value });
              }}
            >
              <option value="">Choose later</option>
              {taxLines.map((l) => (
                <option key={l.code} value={l.code}>
                  Line {l.code}: {l.label}
                </option>
              ))}
              <option value={EXCLUDED_LINE_CODE}>Not on Schedule C</option>
            </Select>
          </Field>
        )}
        {roleOptions.length > 0 && (
          <Field label="Used for" htmlFor={`${uid}-role`} hint="Bank and credit card accounts can import statements and connect to your bank.">
            <Select id={`${uid}-role`} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="">None</option>
              {roleOptions.map((r) => (
                <option key={r.v} value={r.v}>
                  {r.l}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Parent account" htmlFor={`${uid}-parent`}>
          <Select id={`${uid}-parent`} value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
            <option value="">None</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {accountLabel(p)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Description" htmlFor={`${uid}-desc`} className="sm:col-span-2">
          <Textarea id={`${uid}-desc`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}
