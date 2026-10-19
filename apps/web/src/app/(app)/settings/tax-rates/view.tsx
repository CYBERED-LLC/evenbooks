'use client';
import * as React from 'react';
import type { TaxRateDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Checkbox, Field, Input } from '@/components/ui/input';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { fractionToPercent, percentToFraction, useCreateTaxRate, useTaxRates, useUpdateTaxRate } from '@/lib/queries/tax-rates';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { useCompany } from '@/components/company-context';
import { useHotkeys } from '@/lib/use-hotkeys';
import { cn } from '@/lib/utils';

export function TaxRatesView() {
  const { isAdmin } = useCompany();
  const [includeInactive, setIncludeInactive] = React.useState(false);
  const q = useTaxRates({ includeInactive, withUsage: true });
  const [editing, setEditing] = React.useState<TaxRateDto | null>(null);
  const [creating, setCreating] = React.useState(false);
  useHotkeys({ n: () => setCreating(true) }, isAdmin);
  const openRow = (e: React.MouseEvent<HTMLTableRowElement>, t: TaxRateDto) => {
    if (!isAdmin || (e.target as HTMLElement).closest('a, button, input, select, textarea, label')) return;
    if (window.getSelection()?.toString()) return;
    setEditing(t);
  };

  return (
    <>
      <PageHeader
        title="Sales tax rates"
        description={
          isAdmin
            ? 'Sales tax you charge on invoice lines. Changing a rate doesn’t change invoices you’ve already sent.'
            : 'Sales tax you charge on invoice lines. Only administrators can add or change rates.'
        }
        actions={
          <>
            <Checkbox label="Show inactive" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
            {isAdmin && (
              <Button onClick={() => setCreating(true)} title="New tax rate (n)">
                New tax rate
              </Button>
            )}
          </>
        }
      />
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.length === 0 && (
        <EmptyState
          title="No tax rates"
          description="Add the sales tax rates you charge, and invoices work out the tax for you."
          action={isAdmin ? <Button onClick={() => setCreating(true)}>New tax rate</Button> : undefined}
        />
      )}
      {q.data && q.data.length > 0 && (
        <Card>
          <Table aria-label="Sales tax rates">
            <THead>
              <TR>
                <TH>Name</TH>
                <TH numeric className="w-28">
                  Rate
                </TH>
                <TH className="hidden md:table-cell">Agency</TH>
                <TH numeric className="hidden sm:table-cell w-20">
                  Items
                </TH>
                <TH numeric className="hidden sm:table-cell w-28">
                  Open invoices
                </TH>
                <TH className="w-24">Status</TH>
                {isAdmin && (
                  <TH className="w-20">
                    <span className="sr-only">Actions</span>
                  </TH>
                )}
              </TR>
            </THead>
            <TBody>
              {q.data.map((t) => (
                <TR key={t.id} className={cn(isAdmin && 'cursor-pointer', !t.isActive && 'opacity-60')} onClick={(e) => openRow(e, t)}>
                  <TD className="font-medium">{t.name}</TD>
                  <TD numeric>{fractionToPercent(t.rate)}</TD>
                  <TD className="hidden md:table-cell">{t.agency ?? '—'}</TD>
                  <TD numeric className="hidden sm:table-cell" data-testid="usage-items">
                    {t.usage?.items ?? '—'}
                  </TD>
                  <TD numeric className="hidden sm:table-cell" data-testid="usage-open-invoices">
                    {t.usage?.openInvoices ?? '—'}
                  </TD>
                  <TD>
                    <Badge tone={t.isActive ? 'green' : 'neutral'}>{t.isActive ? 'Active' : 'Inactive'}</Badge>
                  </TD>
                  {isAdmin && (
                    <TD>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}>
                        Edit
                      </Button>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      {isAdmin && (
        <>
          <TaxRateDialog open={creating} onClose={() => setCreating(false)} allowAddAnother />
          <TaxRateDialog open={Boolean(editing)} rate={editing} onClose={() => setEditing(null)} />
        </>
      )}
    </>
  );
}

interface FormState {
  name: string;
  percent: string;
  agency: string;
}

/** "Used by 2 items and 1 open invoice", or null when the counts are unknown (e.g. opened from a line picker). */
export function usageSentence(usage: TaxRateDto['usage']): string | null {
  if (!usage) return null;
  const items = `${usage.items} item${usage.items === 1 ? '' : 's'}`;
  const invoices = `${usage.openInvoices} open invoice${usage.openInvoices === 1 ? '' : 's'}`;
  return `Used by ${items} and ${invoices}.`;
}

function fromRate(t: TaxRateDto | null | undefined, defaultName?: string): FormState {
  return { name: t?.name ?? defaultName ?? '', percent: t ? fractionToPercent(t.rate).replace(/%$/, '') : '', agency: t?.agency ?? '' };
}

export interface TaxRateDialogProps {
  open: boolean;
  rate?: TaxRateDto | null;
  onClose: () => void;
  defaultName?: string;
  onSaved?: (rate: TaxRateDto) => void;
  /** Offer "Create and add another" on create (the tax rates page; not the line picker). */
  allowAddAnother?: boolean;
}

/** Create/edit form for a sales tax rate. Shared by the tax rates page and the line tax picker. */
export function TaxRateDialog({ open, rate, onClose, defaultName, onSaved, allowAddAnother }: TaxRateDialogProps) {
  const create = useCreateTaxRate();
  const update = useUpdateTaxRate();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const confirm = useConfirm();
  const id = React.useId();
  const nameRef = React.useRef<HTMLInputElement>(null);
  const [form, setForm] = React.useState<FormState>(() => fromRate(rate, defaultName));
  const [baseline, setBaseline] = React.useState<FormState>(() => fromRate(rate, defaultName));
  const [errors, setErrors] = React.useState<{ name?: string; percent?: string }>({});
  const pending = create.isPending || update.isPending;

  React.useEffect(() => {
    if (open) {
      const initial = fromRate(rate, defaultName);
      setForm(initial);
      setBaseline(initial);
      setErrors({});
    }
  }, [open, rate, defaultName]);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);

  const save = async (extra: Partial<{ isActive: boolean }> = {}, another = false) => {
    if (pending) return;
    const statusOnly = extra.isActive !== undefined;
    const fraction = percentToFraction(form.percent);
    if (!statusOnly) {
      const next: typeof errors = {};
      if (!form.name.trim()) next.name = 'Name is required';
      if (fraction === null) next.percent = 'Enter a percent from 0 up to (but not including) 100, with at most 4 decimals';
      setErrors(next);
      const first = next.name ? `${id}-name` : next.percent ? `${id}-rate` : null;
      if (first) {
        requestAnimationFrame(() => document.getElementById(first)?.focus());
        return;
      }
    }
    if (rate && extra.isActive === false) {
      const used = usageSentence(rate.usage);
      const ok = await confirm({
        title: `Deactivate ${rate.name}?`,
        description: `${used ? `${used} ` : ''}Issued documents keep the rate they were issued with. It can no longer be picked for new lines until you reactivate it${rate.usage?.items ? '; items that default to it stop adding it to new lines' : ''}.`,
        confirmLabel: 'Deactivate',
        tone: 'danger',
      });
      if (!ok) return;
    }
    const fields = { name: form.name.trim(), rate: fraction ?? '0', agency: form.agency.trim() || null };
    if (rate) {
      update.mutate(
        { id: rate.id, input: statusOnly ? { version: rate.version, ...extra } : { version: rate.version, ...fields } },
        {
          onSuccess: (saved) => {
            toast.success(extra.isActive === false ? 'Tax rate deactivated' : extra.isActive === true ? 'Tax rate reactivated' : 'Tax rate updated');
            onSaved?.(saved);
            onClose();
          },
          onError: (e) => onError(e, 'Could not update tax rate'),
        },
      );
    } else {
      create.mutate(fields, {
        onSuccess: (saved) => {
          toast.success('Tax rate created', another ? `${saved.name} saved. Add the next one.` : undefined);
          onSaved?.(saved);
          if (another) {
            const next: FormState = { name: '', percent: '', agency: form.agency };
            setForm(next);
            setBaseline(next);
            setErrors({});
            requestAnimationFrame(() => nameRef.current?.focus());
          } else onClose();
        },
        onError: (e) => onError(e, 'Could not create tax rate'),
      });
    }
  };

  const preview = percentToFraction(form.percent);
  const used = rate ? usageSentence(rate.usage) : null;
  const rateChanged = Boolean(rate) && form.percent.trim() !== baseline.percent.trim();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={rate ? `Edit ${rate.name}` : 'New tax rate'}
      description={rate ? 'Changing the rate affects new invoices only. Invoices you’ve already sent keep their rate.' : undefined}
      onSubmit={() => void save()}
      dirty={dirty}
      footer={
        <>
          {rate && rate.isActive && (
            <Button variant="danger" onClick={() => void save({ isActive: false })} loading={pending}>
              Deactivate
            </Button>
          )}
          {rate && !rate.isActive && (
            <Button variant="secondary" onClick={() => void save({ isActive: true })} loading={pending}>
              Reactivate
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          {!rate && allowAddAnother && (
            <Button variant="secondary" onClick={() => void save({}, true)} loading={pending}>
              Create and add another
            </Button>
          )}
          <Button type="submit" loading={pending}>
            {rate ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {used && (
          <p
            className={cn('rounded-md border px-3 py-2 text-sm', rateChanged && (rate!.usage!.items > 0 || rate!.usage!.openInvoices > 0) ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-stone-200 bg-stone-50 text-stone-700')}
            role="status"
            data-testid="tax-rate-usage"
          >
            {used}
            {rateChanged && ' Issued invoices keep the rate they were issued with; the new rate applies to lines added from now on.'}
          </p>
        )}
        <Field label="Name" htmlFor={`${id}-name`} required error={errors.name}>
          <Input ref={nameRef} id={`${id}-name`} value={form.name} onChange={(e) => {
              setForm({ ...form, name: e.target.value });
              setErrors((er) => ({ ...er, name: undefined }));
            }}
            placeholder="State sales tax" aria-invalid={errors.name ? true : undefined} data-autofocus />
        </Field>
        <Field
          label="Rate (%)"
          htmlFor={`${id}-rate`}
          required
          error={errors.percent}
          hint={preview !== null && form.percent.trim() ? `Stored as ${preview}` : 'Enter as a percent, for example 8.25'}
        >
          <Input
            id={`${id}-rate`}
            inputMode="decimal"
            value={form.percent}
            onChange={(e) => {
              setForm({ ...form, percent: e.target.value });
              setErrors((er) => ({ ...er, percent: undefined }));
            }}
            placeholder="8.25"
            aria-invalid={errors.percent ? true : undefined}
            className="tabular"
          />
        </Field>
        <Field label="Agency" htmlFor={`${id}-agency`} hint="Who you pay this tax to (for example, Texas Comptroller).">
          <Input id={`${id}-agency`} value={form.agency} onChange={(e) => setForm({ ...form, agency: e.target.value })} placeholder="State Department of Revenue" />
        </Field>
      </div>
    </Dialog>
  );
}
