'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { CreateScheduleInput, DocumentLineInput, Frequency, InvoiceDto, RecurringTemplateInput } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardBody, PageHeader, Spinner } from '@/components/ui/card';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DateInput, addDays } from '@/components/ui/date-input';
import { ErrorSummary, focusFirstError, invalidFields, type FormError } from '@/components/ui/error-summary';
import { useToast } from '@/components/ui/toast';
import { ContactPicker } from '@/components/contact-picker';
import { blankDocumentLine, DocumentLines, normalizeDiscount, normalizeLine, toPreviewInput, validateDocumentLines, type DocumentLinesValue } from '@/components/document-lines';
import { useAccounts } from '@/lib/queries/accounts';
import { useContact } from '@/lib/queries/contacts';
import { useDocumentPreview, useInvoice, useInvoices } from '@/lib/queries/invoices';
import { useCreateSchedule } from '@/lib/queries/recurring';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { formatDate, formatMoney, todayIso } from '@/lib/format';
import { useCompany } from '@/components/company-context';
import { useDebounced } from '@/lib/use-debounced';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';
import { useModKeyLabel, useSubmitShortcut } from '@/lib/use-hotkeys';
import { lineFromDto, stillFailing } from '@/app/(app)/invoices/invoice-form';
import { FREQUENCY_LABEL } from './view';

export const ANCHOR_HELP = 'If you pick the 29th, 30th or 31st, shorter months bill on their last day.';
export const PAYMENT_URL_REUSE_HELP = 'Only for links that can be paid more than once. Single-use links must not be reused.';

// ---------------------------------------------------------------------------
// Template editor (shared by the new-schedule form and the "Edit template" dialog)
// ---------------------------------------------------------------------------
export interface TemplateState {
  doc: DocumentLinesValue;
  memo: string;
  footer: string;
  paymentUrl: string;
}

export function blankTemplate(): TemplateState {
  return { doc: { lines: [blankDocumentLine()], documentDiscount: null }, memo: '', footer: '', paymentUrl: '' };
}

export function templateFromDto(t: RecurringTemplateInput): TemplateState {
  return {
    doc: {
      lines: t.lines.map((l) => ({ itemId: l.itemId ?? null, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount ?? null, incomeAccountId: l.incomeAccountId, taxRateIds: l.taxRateIds })),
      documentDiscount: t.documentDiscount ?? null,
    },
    memo: t.memo ?? '',
    footer: t.footer ?? '',
    paymentUrl: t.paymentUrl ?? '',
  };
}

export function templateToInput(t: TemplateState): RecurringTemplateInput {
  return {
    lines: t.doc.lines.map(normalizeLine),
    documentDiscount: normalizeDiscount(t.doc.documentDiscount),
    memo: t.memo.trim() || null,
    footer: t.footer.trim() || null,
    paymentUrl: t.paymentUrl.trim() || null,
  };
}

/** Field id prefix for the template's line editor. */
export const templateLinesPrefix = (idPrefix: string) => `${idPrefix}-line`;

export function validateTemplate(t: TemplateState, idPrefix = 'tpl'): FormError[] {
  const errs = validateDocumentLines(t.doc, templateLinesPrefix(idPrefix));
  const url = t.paymentUrl.trim();
  if (url && !/^https:\/\/\S+$/.test(url)) errs.push({ message: 'Payment URL must start with https://', fieldId: `${idPrefix}-payment-url` });
  return errs;
}

/** Totals come from the server preview (debounced); no money math happens client-side. */
export function TemplateEditor({
  value,
  onChange,
  disabled,
  idPrefix = 'tpl',
  invalid,
}: {
  value: TemplateState;
  onChange(next: TemplateState): void;
  disabled?: boolean;
  idPrefix?: string;
  invalid?: Set<string>;
}) {
  const previewInput = React.useMemo(() => toPreviewInput(value.doc), [value.doc]);
  const debouncedInput = useDebounced(previewInput, 300);
  const preview = useDocumentPreview(debouncedInput);
  const previewStale = debouncedInput !== previewInput || preview.isFetching;
  return (
    <div className="space-y-5">
      <DocumentLines
        idPrefix={templateLinesPrefix(idPrefix)}
        invalid={invalid}
        value={value.doc}
        onChange={(doc) => onChange({ ...value, doc })}
        preview={preview.data ?? null}
        previewPending={previewStale}
        disabled={disabled}
      />
      {preview.isError && (
        <p role="alert" className="text-xs text-red-700">
          Totals could not be computed: {preview.error instanceof Error ? preview.error.message : 'unknown error'}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Memo" htmlFor={`${idPrefix}-memo`} hint="Shown to the customer above the totals on every issued invoice.">
          <Textarea id={`${idPrefix}-memo`} value={value.memo} rows={2} maxLength={2000} disabled={disabled} onChange={(e) => onChange({ ...value, memo: e.target.value })} />
        </Field>
        <Field label="Footer" htmlFor={`${idPrefix}-footer`} hint="Payment instructions, thank-you note, terms.">
          <Textarea id={`${idPrefix}-footer`} value={value.footer} rows={2} maxLength={2000} disabled={disabled} onChange={(e) => onChange({ ...value, footer: e.target.value })} />
        </Field>
      </div>
      <Field label="Reusable payment URL" htmlFor={`${idPrefix}-payment-url`} hint={`Copied onto every issued invoice. ${PAYMENT_URL_REUSE_HELP}`}>
        <Input
          id={`${idPrefix}-payment-url`}
          type="url"
          placeholder="https://"
          value={value.paymentUrl}
          aria-invalid={invalid?.has(`${idPrefix}-payment-url`) || undefined}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, paymentUrl: e.target.value })} />
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only lines (invoice being repeated; schedule template on the detail page)
// ---------------------------------------------------------------------------
export function ReadOnlyLines({ lines, ariaLabel }: { lines: DocumentLineInput[]; ariaLabel: string }) {
  const { company } = useCompany();
  const accounts = useAccounts({ includeArchived: true });
  const accountLabel = (id: string) => {
    const a = accounts.data?.find((x) => x.id === id);
    return a ? `${a.code} ${a.name}` : '…';
  };
  return (
    <Table aria-label={ariaLabel}>
      <THead>
        <TR>
          <TH>Description</TH>
          <TH className="hidden md:table-cell">Category</TH>
          <TH numeric>Qty</TH>
          <TH numeric>Unit price</TH>
          <TH className="hidden sm:table-cell">Tax / discount</TH>
        </TR>
      </THead>
      <TBody>
        {lines.map((l, i) => (
          <TR key={i}>
            <TD>
              {l.description}
              <p className="text-xs text-stone-500 md:hidden">{accountLabel(l.incomeAccountId)}</p>
            </TD>
            <TD className="hidden md:table-cell">{accountLabel(l.incomeAccountId)}</TD>
            <TD numeric>{l.quantity}</TD>
            <TD numeric>{formatMoney(l.unitPrice, company.baseCurrency)}</TD>
            <TD className="hidden sm:table-cell">
              <div className="flex flex-wrap gap-1">
                {l.taxRateIds.length > 0 && <Badge tone="blue">{l.taxRateIds.length === 1 ? '1 tax rate' : `${l.taxRateIds.length} tax rates`}</Badge>}
                {l.discount && <Badge tone="amber">{l.discount.type === 'percent' ? `${l.discount.value}% off` : `${formatMoney(l.discount.value, company.baseCurrency)} off`}</Badge>}
              </div>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}


// ---------------------------------------------------------------------------
// New schedule form
// ---------------------------------------------------------------------------
type Source = 'invoice' | 'scratch';
const FREQUENCIES: Frequency[] = ['weekly', 'biweekly', 'monthly', 'quarterly', 'semiannually', 'yearly'];
const MONTHS: Partial<Record<Frequency, number>> = { monthly: 1, quarterly: 3, semiannually: 6, yearly: 12 };

function addMonthsClamped(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(y!, m! - 1 + months, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  const day = Math.min(d!, last);
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** `k` periods after `date` (calendar arithmetic, month ends clamped). */
export function addPeriods(date: string, frequency: Frequency, k: number): string {
  if (frequency === 'weekly') return addDays(date, 7 * k);
  if (frequency === 'biweekly') return addDays(date, 14 * k);
  return addMonthsClamped(date, (MONTHS[frequency] ?? 1) * k);
}

/**
 * First occurrence for a schedule repeating an invoice: the next date in the
 * invoice's rhythm that is not in the past, so the invoice already sent is not
 * billed twice and no backlog is issued on creation.
 */
export function nextAnchorAfter(issueDate: string, frequency: Frequency, today = todayIso()): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) return today;
  for (let k = 1; k < 2000; k++) {
    const d = addPeriods(issueDate, frequency, k);
    if (d >= today) return d;
  }
  return today;
}

const repeatable = (i: InvoiceDto) => i.status === 'issued' || i.status === 'paid';
const customerOf = (i: InvoiceDto) => i.contactName ?? i.customerSnapshot.name;

/**
 * New recurring schedule, either repeating an issued invoice or from a blank
 * template. `fromInvoice` (the invoice page's "Make recurring") preselects the
 * invoice and prefills name, terms and the first date; a draft invoice cannot be
 * repeated as such, so its customer and lines seed a template instead.
 */
export function ScheduleForm({ fromInvoice }: { fromInvoice?: InvoiceDto }) {
  const router = useRouter();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const { company } = useCompany();
  const create = useCreateSchedule();

  const seed = React.useMemo(() => {
    const inv = fromInvoice;
    const frequency: Frequency = 'monthly';
    return {
      source: (inv && !repeatable(inv) ? 'scratch' : 'invoice') as Source,
      invoiceId: inv && repeatable(inv) ? inv.id : '',
      contactId: inv?.contactId ?? null,
      template: inv && !repeatable(inv) ? templateFromDto({ lines: inv.lines.map(lineFromDto), documentDiscount: inv.documentDiscount, memo: inv.memo, footer: inv.footer, paymentUrl: inv.paymentUrl }) : blankTemplate(),
      name: inv ? `${customerOf(inv)} ${FREQUENCY_LABEL[frequency].toLowerCase()}` : '',
      frequency,
      anchorDate: inv && repeatable(inv) ? nextAnchorAfter(inv.issueDate, frequency, todayIso(company.timeZone)) : todayIso(company.timeZone),
      termsDays: String(inv?.termsDays ?? company.defaultTermsDays),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [source, setSource] = React.useState<Source>(seed.source);
  // Repeat an existing invoice
  const [query, setQuery] = React.useState('');
  const q = useDebounced(query.trim(), 250);
  const [invoiceId, setInvoiceId] = React.useState(seed.invoiceId);
  const [copyPaymentUrl, setCopyPaymentUrl] = React.useState(false);
  // Issued (open) and paid invoices can both be repeated; drafts and voids cannot.
  const issuedList = useInvoices({ status: 'issued', limit: 25, q: q || undefined });
  const paidList = useInvoices({ status: 'paid', limit: 25, q: q || undefined });
  const invoice = useInvoice(invoiceId, Boolean(invoiceId));
  // Start from scratch
  const [contactId, setContactId] = React.useState<string | null>(seed.contactId);
  const [template, setTemplate] = React.useState<TemplateState>(seed.template);
  // Common
  const [name, setName] = React.useState(seed.name);
  const [nameTouched, setNameTouched] = React.useState(false);
  const [frequency, setFrequency] = React.useState<Frequency>(seed.frequency);
  const [anchorDate, setAnchorDate] = React.useState(seed.anchorDate);
  const [anchorTouched, setAnchorTouched] = React.useState(false);
  const [endDate, setEndDate] = React.useState('');
  const [termsDays, setTermsDays] = React.useState(seed.termsDays);
  // null = not chosen by the user: follow the customer (email them when an address is on file).
  const [sendEmailChoice, setSendEmail] = React.useState<boolean | null>(null);
  const [emailToTyped, setEmailTo] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<FormError[]>([]);

  const selectedInvoice = invoice.data && invoice.data.id === invoiceId ? invoice.data : fromInvoice && fromInvoice.id === invoiceId ? fromInvoice : null;
  const customerId = source === 'invoice' ? (selectedInvoice?.contactId ?? null) : contactId;
  const customer = useContact(customerId ?? '');
  const customerEmail = (source === 'invoice' ? selectedInvoice?.customerSnapshot.email : null) || customer.data?.email || '';
  const customerName = customer.data?.name ?? (source === 'invoice' && selectedInvoice ? customerOf(selectedInvoice) : null);
  // Emailing each invoice is the default whenever we know where to send it.
  const sendEmail = sendEmailChoice ?? Boolean(customerEmail);
  const emailTo = emailToTyped ?? customerEmail;

  const snap = JSON.stringify([source, invoiceId, copyPaymentUrl, contactId, template, name, frequency, anchorDate, endDate, termsDays, sendEmailChoice, emailToTyped]);
  const [baseline] = React.useState(snap);
  const [saved, setSaved] = React.useState(false);
  const guard = useUnsavedChanges(!saved && snap !== baseline);

  const listed = React.useMemo(() => [...(issuedList.data?.items ?? []), ...(paidList.data?.items ?? [])], [issuedList.data, paidList.data]);
  const invoiceOptions = React.useMemo<ComboboxOption[]>(() => {
    const items = [...listed];
    // Keep the chosen invoice selectable even when a new search no longer includes it.
    if (selectedInvoice && !items.some((i) => i.id === selectedInvoice.id)) items.unshift(selectedInvoice);
    return items.map((i) => ({
      value: i.id,
      label: i.number ?? 'Invoice',
      hint: formatMoney(i.total, company.baseCurrency),
      description: `${customerOf(i)} · ${formatDate(i.issueDate)}${i.status === 'paid' ? ' · paid' : ''}`,
      keywords: customerOf(i),
    }));
  }, [listed, selectedInvoice, company.baseCurrency]);

  /** A newly chosen source invoice fills in what the user has not typed themselves. */
  const adoptInvoice = (inv: InvoiceDto | null, freq = frequency) => {
    if (!inv) return;
    if (!nameTouched) setName(`${customerOf(inv)} ${FREQUENCY_LABEL[freq].toLowerCase()}`);
    if (!anchorTouched) setAnchorDate(nextAnchorAfter(inv.issueDate, freq, todayIso(company.timeZone)));
    setTermsDays(String(inv.termsDays));
  };

  const changeFrequency = (f: Frequency) => {
    setFrequency(f);
    if (source === 'invoice' && selectedInvoice) adoptInvoice(selectedInvoice, f);
  };

  const validate = (): FormError[] => {
    const errs: FormError[] = [];
    if (source === 'invoice') {
      if (!invoiceId) errs.push({ message: 'Choose an issued invoice to repeat.', fieldId: 'inv-select' });
    } else {
      if (!contactId) errs.push({ message: 'Choose a customer.', fieldId: 'customer' });
      errs.push(...validateTemplate(template));
    }
    if (!name.trim()) errs.push({ message: 'Name is required.', fieldId: 'sch-name' });
    if (!anchorDate) errs.push({ message: 'First invoice date is required.', fieldId: 'sch-anchor' });
    if (endDate && anchorDate && endDate < anchorDate) errs.push({ message: 'End date cannot be before the first invoice date.', fieldId: 'sch-end' });
    const n = Number(termsDays);
    if (!/^\d+$/.test(termsDays.trim()) || n < 0 || n > 365) errs.push({ message: 'Days to pay must be a whole number from 0 to 365.', fieldId: 'sch-terms' });
    if (sendEmail && !emailTo.trim()) errs.push({ message: 'Enter the email address to send each invoice to, or turn emailing off.', fieldId: 'sch-email' });
    else if (sendEmail && !/^\S+@\S+\.\S+$/.test(emailTo.trim())) errs.push({ message: 'Enter a valid email address.', fieldId: 'sch-email' });
    return errs;
  };
  const shownErrors = errors.length ? stillFailing(errors, validate()) : errors;
  const invalid = invalidFields(shownErrors);

  const pending = create.isPending;

  const submit = () => {
    if (pending) return;
    const errs = validate();
    setErrors(errs);
    if (errs.length) {
      focusFirstError(errs);
      return;
    }
    const common = {
      name: name.trim(),
      frequency,
      anchorDate,
      endDate: endDate || null,
      termsDays: Number(termsDays),
      sendEmail,
      emailTo: sendEmail ? emailTo.trim() : null,
    };
    const input: CreateScheduleInput =
      source === 'invoice'
        ? { ...common, fromInvoiceId: invoiceId, copyPaymentUrl: copyPaymentUrl && Boolean(selectedInvoice?.paymentUrl) }
        : { ...common, contactId: contactId!, template: templateToInput(template), copyPaymentUrl: false };
    create.mutate(input, {
      onSuccess: (s) => {
        guard.markSaved();
        setSaved(true);
        toast.success(`Schedule “${s.name}” created`, s.nextOccurrenceDate ? `First invoice on ${formatDate(s.nextOccurrenceDate)}${s.sendEmail ? `, emailed to ${s.emailTo}` : ''}` : undefined);
        router.push(`/recurring/${s.id}`);
      },
      onError: (e) => onError(e, 'Could not create schedule'),
    });
  };

  const modKey = useModKeyLabel();
  const shortcut = useSubmitShortcut(submit, true);

  return (
    <>
      <PageHeader title="New recurring schedule" description="Evenbooks creates and issues an invoice on each date, early in the morning in your company’s time zone, and can email it to the customer. The invoice you start from isn’t changed." />
      <Card>
        <CardBody>
          <div {...shortcut} className="space-y-6">
            <fieldset disabled={pending}>
              <legend className="mb-2 text-sm font-medium text-stone-700">Start from</legend>
              <div className="flex flex-wrap gap-4">
                <label className="inline-flex items-center gap-2 text-sm text-stone-800">
                  <input type="radio" name="source" value="invoice" checked={source === 'invoice'} onChange={() => setSource('invoice')} className="size-4 border-stone-300 text-brand-600 focus:ring-brand-500" />
                  Repeat an existing invoice
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-stone-800">
                  <input type="radio" name="source" value="scratch" checked={source === 'scratch'} onChange={() => setSource('scratch')} className="size-4 border-stone-300 text-brand-600 focus:ring-brand-500" />
                  Start from scratch
                </label>
              </div>
              {fromInvoice && !repeatable(fromInvoice) && (
                <p className="mt-2 text-xs text-stone-500">
                  {fromInvoice.status === 'draft' ? 'Draft invoices cannot be repeated as they are' : 'Void invoices cannot be repeated'}; its customer and lines were copied into a new template instead.
                </p>
              )}
            </fieldset>

            {source === 'invoice' && (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Invoice to repeat" htmlFor="inv-select" required hint="Search issued or paid invoices by number, customer or memo.">
                    <Combobox
                      id="inv-select"
                      value={invoiceId || null}
                      options={invoiceOptions}
                      selectedLabel={selectedInvoice ? (selectedInvoice.number ?? 'Invoice') : invoiceId ? 'Loading…' : undefined}
                      onQueryChange={setQuery}
                      onChange={(v) => {
                        setInvoiceId(v ?? '');
                        adoptInvoice(listed.find((i) => i.id === v) ?? null);
                      }}
                      loading={issuedList.isFetching || paidList.isFetching}
                      placeholder="Search invoices…"
                      emptyText={q ? `No issued invoice matches “${q}”` : 'No issued invoices yet'}
                      disabled={pending}
                      invalid={invalid.has('inv-select')}
                      required
                      autoFocus={!fromInvoice}
                    />
                  </Field>
                </div>
                {invoiceId && !selectedInvoice && invoice.isPending && <Spinner label="Loading invoice" />}
                {selectedInvoice && (
                  <div className="space-y-3 rounded-md border border-stone-200">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-3 py-2 text-sm">
                      <span>
                        <Link href={`/invoices/${selectedInvoice.id}`} className="font-medium text-brand-700 hover:underline">
                          {selectedInvoice.number}
                        </Link>{' '}
                        <span className="text-stone-500">
                          for {customerOf(selectedInvoice)} · issued {formatDate(selectedInvoice.issueDate)}
                        </span>
                      </span>
                      <span className="tabular font-medium">{formatMoney(selectedInvoice.total, company.baseCurrency)}</span>
                    </div>
                    <ReadOnlyLines lines={selectedInvoice.lines} ariaLabel="Lines of the invoice to repeat" />
                    {selectedInvoice.paymentUrl && (
                      <div className="px-3 pb-3">
                        <Checkbox label="This invoice's payment link is reusable — copy it to the schedule" checked={copyPaymentUrl} disabled={pending} onChange={(e) => setCopyPaymentUrl(e.target.checked)} />
                        <p className="mt-1 text-xs text-stone-500">
                          {PAYMENT_URL_REUSE_HELP} Leave unchecked and the issued invoices carry no payment link.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {source === 'scratch' && (
              <div className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <ContactPicker kind="customer" value={contactId} onChange={setContactId} required id="customer" invalid={invalid.has('customer')} disabled={pending} />
                </div>
                <TemplateEditor value={template} onChange={setTemplate} disabled={pending} invalid={invalid} />
              </div>
            )}

            <div className="grid gap-4 border-t border-stone-200 pt-5 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Name" htmlFor="sch-name" required hint="Only you see this, e.g. “Monthly retainer”.">
                <Input
                  id="sch-name"
                  value={name}
                  maxLength={120}
                  disabled={pending}
                  aria-invalid={invalid.has('sch-name') || undefined}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameTouched(true);
                  }}
                />
              </Field>
              <Field label="Frequency" htmlFor="sch-frequency" required>
                <Select id="sch-frequency" value={frequency} disabled={pending} onChange={(e) => changeFrequency(e.target.value as Frequency)}>
                  {FREQUENCIES.map((f) => (
                    <option key={f} value={f}>
                      {FREQUENCY_LABEL[f]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="First invoice date"
                htmlFor="sch-anchor"
                required
                hint={source === 'invoice' && selectedInvoice && !anchorTouched ? `The next date after the invoice you're repeating. ${ANCHOR_HELP}` : `Later invoices follow on the same day. ${ANCHOR_HELP}`}
              >
                <DateInput
                  id="sch-anchor"
                  value={anchorDate}
                  disabled={pending}
                  aria-invalid={invalid.has('sch-anchor') || undefined}
                  onChange={(v) => {
                    setAnchorDate(v);
                    setAnchorTouched(true);
                  }}
                />
              </Field>
              <Field label="End date" htmlFor="sch-end" hint="Optional. No invoices are created after this date.">
                <DateInput id="sch-end" value={endDate} min={anchorDate || undefined} presets={[]} disabled={pending} aria-invalid={invalid.has('sch-end') || undefined} onChange={setEndDate} />
              </Field>
              <Field label="Days to pay" htmlFor="sch-terms" required hint="Each invoice is due this many days after it's created.">
                <Input id="sch-terms" inputMode="numeric" value={termsDays} disabled={pending} aria-invalid={invalid.has('sch-terms') || undefined} onChange={(e) => setTermsDays(e.target.value)} />
              </Field>
              <div className="space-y-2">
                <Checkbox label="Email each invoice to the customer" checked={sendEmail} disabled={pending} onChange={(e) => setSendEmail(e.target.checked)} />
                {sendEmail ? (
                  <Field
                    label="Email address"
                    htmlFor="sch-email"
                    required
                    hint={
                      !emailTo.trim()
                        ? `${customerName ?? 'This customer'} has no email on file. Enter one, or turn emailing off.`
                        : emailToTyped === null && customerEmail
                          ? `From ${customerName ?? 'the customer'}’s details.`
                          : undefined
                    }
                  >
                    <Input
                      id="sch-email"
                      type="email"
                      value={emailTo}
                      disabled={pending}
                      aria-invalid={invalid.has('sch-email') || undefined}
                      onChange={(e) => setEmailTo(e.target.value)}
                      placeholder="billing@customer.example"
                    />
                  </Field>
                ) : (
                  customerId &&
                  !customerEmail && (
                    <p className="text-xs text-stone-500" data-testid="no-customer-email">
                      Off because {customerName ?? 'this customer'} has no email on file. Turn it on to enter an address.
                    </p>
                  )
                )}
              </div>
            </div>

            <ErrorSummary errors={shownErrors} />

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-stone-200 pt-4">
              <span className="mr-auto hidden text-xs text-stone-500 sm:inline">{modKey}+Enter to create</span>
              <Button variant="secondary" onClick={() => void guard.leave(() => router.back())} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={submit} loading={pending}>
                Create schedule
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
    </>
  );
}
