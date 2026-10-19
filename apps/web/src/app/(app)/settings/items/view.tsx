'use client';
import * as React from 'react';
import type { AccountDto, ItemDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { MoneyInput } from '@/components/ui/money-input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useAccounts } from '@/lib/queries/accounts';
import { useCreateItem, useDefaultIncomeAccountId, useItems, useUpdateItem } from '@/lib/queries/items';
import { fractionToPercent, useTaxRates } from '@/lib/queries/tax-rates';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { isValidDecimal } from '@/lib/decimal';
import { capitalize, formatMoney } from '@/lib/format';
import { useCompany } from '@/components/company-context';
import { AccountPicker } from '@/components/account-picker';
import { useListParams } from '@/lib/use-list-params';
import { useHotkeys } from '@/lib/use-hotkeys';
import { cn } from '@/lib/utils';

const isIncome = (a: AccountDto) => a.type === 'income';

type ItemKind = ItemDto['kind'];

export function ItemsView() {
  const { company } = useCompany();
  const [includeInactive, setIncludeInactive] = React.useState(false);
  const q = useItems({ includeInactive });
  const accounts = useAccounts({ includeArchived: true });
  const taxRates = useTaxRates({ includeInactive: true });
  const [editing, setEditing] = React.useState<ItemDto | null>(null);
  const [creating, setCreating] = React.useState(false);
  const list = useListParams();
  const searchRef = React.useRef<HTMLInputElement>(null);
  useHotkeys({
    n: () => setCreating(true),
    '/': () => searchRef.current?.focus(),
  });

  const accountName = (id: string) => {
    const a = accounts.data?.find((x) => x.id === id);
    return a ? `${a.code} ${a.name}` : '—';
  };
  const rateName = (id: string) => taxRates.data?.find((t) => t.id === id)?.name ?? '…';

  const term = (list.get('q') ?? '').trim().toLowerCase();
  const rows = (q.data ?? []).filter((i) => !term || [i.name, i.description ?? '', accountName(i.incomeAccountId)].some((v) => v.toLowerCase().includes(term)));
  const openRow = (e: React.MouseEvent<HTMLTableRowElement>, i: ItemDto) => {
    if ((e.target as HTMLElement).closest('a, button, input, select, textarea, label')) return;
    if (window.getSelection()?.toString()) return;
    setEditing(i);
  };

  return (
    <>
      <PageHeader
        title="Products and services"
        description="The things you sell, saved so invoice lines fill themselves in: name, price, category and sales tax."
        actions={
          <>
            <Checkbox label="Show inactive" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
            <Button onClick={() => setCreating(true)} title="New item (n)">
              New item
            </Button>
          </>
        }
      />
      {q.data && q.data.length > 0 && (
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="Search items" htmlFor="item-search" className="w-full sm:w-72">
            <Input ref={searchRef} id="item-search" type="search" placeholder="Name, description or account" value={list.search} onChange={(e) => list.setSearch(e.target.value)} />
          </Field>
          {term && (
            <p className="pb-2 text-sm text-stone-500" role="status">
              {rows.length} of {q.data.length} items
            </p>
          )}
        </div>
      )}
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.length === 0 && (
        <EmptyState title="No items yet" description="Save the things you sell often, and pick them on an invoice instead of typing them out." action={<Button onClick={() => setCreating(true)}>New item</Button>} />
      )}
      {q.data && q.data.length > 0 && rows.length === 0 && (
        <EmptyState
          title="No items match"
          description={`Nothing matches “${list.get('q')}”.`}
          action={
            <Button variant="secondary" onClick={() => list.clear(['q'])}>
              Clear search
            </Button>
          }
        />
      )}
      {rows.length > 0 && (
        <Card>
          <Table aria-label="Products and services" stickyHeader>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH className="w-24">Kind</TH>
                <TH numeric>Unit price</TH>
                <TH className="hidden md:table-cell">Category</TH>
                <TH className="hidden lg:table-cell">Default tax</TH>
                <TH className="w-24">Status</TH>
                <TH className="w-20">
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((i) => (
                <TR key={i.id} className={cn('cursor-pointer', !i.isActive && 'opacity-60')} onClick={(e) => openRow(e, i)}>
                  <TD>
                    <span className="font-medium">{i.name}</span>
                    {i.description && <p className="text-xs text-stone-500">{i.description}</p>}
                  </TD>
                  <TD>{capitalize(i.kind)}</TD>
                  <TD numeric>{formatMoney(i.unitPrice, company.baseCurrency)}</TD>
                  <TD className="hidden md:table-cell">{accountName(i.incomeAccountId)}</TD>
                  <TD className="hidden lg:table-cell">
                    {i.defaultTaxRateIds.length === 0 ? (
                      <span className="text-stone-500">None</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {i.defaultTaxRateIds.map((id) => (
                          <Badge key={id} tone="neutral">
                            {rateName(id)}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </TD>
                  <TD>
                    <Badge tone={i.isActive ? 'green' : 'neutral'}>{i.isActive ? 'Active' : 'Inactive'}</Badge>
                  </TD>
                  <TD>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(i)} aria-label={`Edit ${i.name}`}>
                      Edit
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      <ItemDialog open={creating} onClose={() => setCreating(false)} allowAddAnother />
      <ItemDialog open={Boolean(editing)} item={editing} onClose={() => setEditing(null)} />
    </>
  );
}

interface FormState {
  name: string;
  description: string;
  kind: ItemKind;
  unitPrice: string;
  incomeAccountId: string;
  defaultTaxRateIds: string[];
}

function fromItem(i: ItemDto | null | undefined, defaultName?: string): FormState {
  return {
    name: i?.name ?? defaultName ?? '',
    description: i?.description ?? '',
    kind: i?.kind ?? 'service',
    unitPrice: i?.unitPrice ?? '0',
    incomeAccountId: i?.incomeAccountId ?? '',
    defaultTaxRateIds: i?.defaultTaxRateIds ?? [],
  };
}

export interface ItemDialogProps {
  open: boolean;
  item?: ItemDto | null;
  onClose: () => void;
  /** Pre-fill the name on create (what was typed into the item picker). */
  defaultName?: string;
  onSaved?: (item: ItemDto) => void;
  /** Offer "Create and add another" on create (the items page; not the line picker). */
  allowAddAnother?: boolean;
}

/** Create/edit form for an item. Shared by the items page and the line item picker. */
export function ItemDialog({ open, item, onClose, defaultName, onSaved, allowAddAnother }: ItemDialogProps) {
  const create = useCreateItem();
  const update = useUpdateItem();
  const toast = useToast();
  const confirm = useConfirm();
  const onError = useMutationErrorHandler();
  const taxRates = useTaxRates();
  const id = React.useId();
  const nameRef = React.useRef<HTMLInputElement>(null);
  const [form, setForm] = React.useState<FormState>(() => fromItem(item, defaultName));
  const [baseline, setBaseline] = React.useState<FormState>(() => fromItem(item, defaultName));
  const [errors, setErrors] = React.useState<{ name?: string; unitPrice?: string; incomeAccountId?: string }>({});
  const pending = create.isPending || update.isPending;
  // New items start in the company's main income category; the owner can pick another.
  const defaultIncome = useDefaultIncomeAccountId();
  const incomeAccountId = form.incomeAccountId || (item ? '' : (defaultIncome ?? ''));

  React.useEffect(() => {
    if (open) {
      const initial = fromItem(item, defaultName);
      setForm(initial);
      setBaseline(initial);
      setErrors({});
    }
  }, [open, item, defaultName]);

  const rateOptions = taxRates.data ?? [];
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);

  const validate = () => {
    const next: typeof errors = {};
    if (!form.name.trim()) next.name = 'Name is required';
    const price = form.unitPrice.trim();
    if (!isValidDecimal(price) || price.startsWith('-')) next.unitPrice = 'Enter a non-negative amount like 125.00';
    if (!incomeAccountId) next.incomeAccountId = 'Choose the category this sale belongs in';
    setErrors(next);
    const first = next.name ? `${id}-name` : next.unitPrice ? `${id}-price` : next.incomeAccountId ? `${id}-account` : null;
    if (first) requestAnimationFrame(() => document.getElementById(first)?.focus());
    return Object.keys(next).length === 0;
  };

  const setStatus = async (isActive: boolean) => {
    if (!item) return;
    if (!isActive) {
      const ok = await confirm({
        title: `Deactivate ${item.name}?`,
        description: 'It stays on existing invoices but can no longer be picked for new lines. You can reactivate it any time.',
        confirmLabel: 'Deactivate',
        tone: 'danger',
      });
      if (!ok) return;
    }
    update.mutate(
      { id: item.id, input: { version: item.version, isActive } },
      {
        onSuccess: (saved) => {
          toast.success(isActive ? 'Item reactivated' : 'Item deactivated');
          onSaved?.(saved);
          onClose();
        },
        onError: (e) => onError(e, 'Could not update item'),
      },
    );
  };

  const save = (another = false) => {
    if (pending || !validate()) return;
    const fields = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      kind: form.kind,
      unitPrice: form.unitPrice.trim(),
      incomeAccountId,
      defaultTaxRateIds: form.defaultTaxRateIds,
    };
    if (item) {
      update.mutate(
        { id: item.id, input: { version: item.version, ...fields } },
        {
          onSuccess: (saved) => {
            toast.success('Item updated');
            onSaved?.(saved);
            onClose();
          },
          onError: (e) => onError(e, 'Could not update item'),
        },
      );
    } else {
      create.mutate(fields, {
        onSuccess: (saved) => {
          toast.success('Item created', another ? `${saved.name} saved. Add the next one.` : undefined);
          onSaved?.(saved);
          if (another) {
            // Keep the kind, account and taxes: a batch of items usually shares them.
            const next: FormState = { ...form, name: '', description: '', unitPrice: '0' };
            setForm(next);
            setBaseline(next);
            setErrors({});
            requestAnimationFrame(() => nameRef.current?.focus());
          } else onClose();
        },
        onError: (e) => onError(e, 'Could not create item'),
      });
    }
  };

  const toggleRate = (rateId: string, checked: boolean) =>
    setForm((f) => ({ ...f, defaultTaxRateIds: checked ? [...f.defaultTaxRateIds, rateId] : f.defaultTaxRateIds.filter((x) => x !== rateId) }));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={item ? `Edit ${item.name}` : 'New item'}
      onSubmit={() => save()}
      dirty={dirty}
      footer={
        <>
          {item && item.isActive && (
            <Button variant="danger" onClick={() => void setStatus(false)} loading={pending}>
              Deactivate
            </Button>
          )}
          {item && !item.isActive && (
            <Button variant="secondary" onClick={() => void setStatus(true)} loading={pending}>
              Reactivate
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          {!item && allowAddAnother && (
            <Button variant="secondary" onClick={() => save(true)} loading={pending}>
              Create and add another
            </Button>
          )}
          <Button type="submit" loading={pending}>
            {item ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor={`${id}-name`} required error={errors.name} className="sm:col-span-2">
          <Input
            ref={nameRef}
            id={`${id}-name`}
            value={form.name}
            onChange={(e) => {
              setForm({ ...form, name: e.target.value });
              setErrors((er) => ({ ...er, name: undefined }));
            }}
            aria-invalid={errors.name ? true : undefined}
            data-autofocus
          />
        </Field>
        <Field label="Kind" htmlFor={`${id}-kind`} required>
          <Select id={`${id}-kind`} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ItemKind })}>
            <option value="service">Service</option>
            <option value="product">Product</option>
          </Select>
        </Field>
        <Field label="Unit price" htmlFor={`${id}-price`} required error={errors.unitPrice}>
          <MoneyInput
            id={`${id}-price`}
            value={form.unitPrice}
            onChange={(v) => {
              setForm({ ...form, unitPrice: v });
              setErrors((er) => ({ ...er, unitPrice: undefined }));
            }}
            aria-invalid={errors.unitPrice ? true : undefined}
          />
        </Field>
        <Field label="Category" htmlFor={`${id}-account`} required error={errors.incomeAccountId} hint="Where this sale shows up in your reports." className="sm:col-span-2">
          <AccountPicker
            id={`${id}-account`}
            value={incomeAccountId}
            allow={isIncome}
            createType="income"
            recentKey="item-income-account"
            invalid={!!errors.incomeAccountId}
            onChange={(v) => {
              setForm({ ...form, incomeAccountId: v ?? '' });
              setErrors((er) => ({ ...er, incomeAccountId: undefined }));
            }}
          />
        </Field>
        <Field label="Default tax rates" className="sm:col-span-2" hint={rateOptions.length === 0 && !taxRates.isPending ? 'No active tax rates. Add them under Settings › Sales tax rates.' : undefined}>
          {taxRates.isPending ? (
            <Spinner label="Loading tax rates" />
          ) : (
            <div className="flex flex-wrap gap-x-5 gap-y-2" role="group" aria-label="Default tax rates">
              {rateOptions.map((t) => (
                <Checkbox
                  key={t.id}
                  label={`${t.name} (${fractionToPercent(t.rate)})`}
                  checked={form.defaultTaxRateIds.includes(t.id)}
                  onChange={(e) => toggleRate(t.id, e.target.checked)}
                />
              ))}
            </div>
          )}
        </Field>
        <Field label="Description" htmlFor={`${id}-desc`} className="sm:col-span-2">
          <Textarea id={`${id}-desc`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}
