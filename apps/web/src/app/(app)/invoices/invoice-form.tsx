'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { CreateInvoiceInput, DocumentLineDto, DocumentLineInput, InvoiceDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardBody, PageHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { DateInput, addDays, termsPresets } from '@/components/ui/date-input';
import { ErrorSummary, focusFirstError, invalidFields, type FormError } from '@/components/ui/error-summary';
import { useToast } from '@/components/ui/toast';
import { ContactPicker } from '@/components/contact-picker';
import { blankDocumentLine, DocumentLines, normalizeDiscount, normalizeLine, toPreviewInput, validateDocumentLines, withDefaultIncomeAccount, type DocumentLinesValue } from '@/components/document-lines';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateAfterSalesPosting, useCreateInvoice, useDocumentPreview, useIssueInvoice, useUpdateInvoice } from '@/lib/queries/invoices';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { api, idempotencyKey } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';
import { formatDate, todayIso } from '@/lib/format';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';
import { useModKeyLabel, useSubmitShortcut } from '@/lib/use-hotkeys';
import { useDebounced } from '@/lib/use-debounced';
import { useDefaultIncomeAccountId } from '@/lib/queries/items';
import { useContact } from '@/lib/queries/contacts';
import { Term } from '@/components/ui/term';
import { CustomerCreditNotice } from './customer-credit';

export const PAYMENT_URL_HELP = 'Optional link to a payment page you use elsewhere (PayPal, Square…). It is shown on the invoice and in emails. Record the payment here when the money arrives.';

export function lineFromDto(l: DocumentLineDto): DocumentLineInput {
  return { itemId: l.itemId, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, incomeAccountId: l.incomeAccountId, taxRateIds: l.taxRateIds };
}

/**
 * Create or edit a draft invoice. Totals come from the server preview endpoint
 * (debounced); nothing is computed client-side. "Save and issue" saves the draft
 * and then posts it with a per-form idempotency key. `copyOf` starts a new
 * invoice from an existing one (customer, lines and notes; dates start today).
 */
export function InvoiceForm({ invoice, copyOf, contactId: presetContactId, defaults }: { defaults?: { defaultNotes: string | null; defaultFooter: string | null }; invoice?: InvoiceDto; copyOf?: InvoiceDto; /** Preselected customer for a new invoice (`?contactId=`). */ contactId?: string }) {
  const router = useRouter();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const { company } = useCompany();
  const qc = useQueryClient();
  const create = useCreateInvoice();
  const update = useUpdateInvoice(invoice?.id ?? '');
  const issue = useIssueInvoice(invoice?.id ?? '');

  const initial = React.useMemo<FormState>(() => {
    const src = invoice ?? copyOf;
    return {
      contactId: src?.contactId ?? presetContactId ?? null,
      issueDate: invoice?.issueDate ?? todayIso(company.timeZone),
      dueMode: 'terms',
      termsDays: String(src?.termsDays ?? company.defaultTermsDays),
      dueDate: invoice?.dueDate ?? '',
      doc: src ? { lines: src.lines.map(lineFromDto), documentDiscount: src.documentDiscount } : { lines: [blankDocumentLine()], documentDiscount: null },
      memo: src ? src.memo ?? '' : defaults?.defaultNotes ?? '',
      footer: src ? src.footer ?? '' : defaults?.defaultFooter ?? '',
      paymentUrl: src?.paymentUrl ?? '',
    };
    // The form owns its state after mount; later refetches of the source must not reset it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [contactId, setContactId] = React.useState<string | null>(initial.contactId);
  const [issueDate, setIssueDate] = React.useState(initial.issueDate);
  const [dueMode, setDueMode] = React.useState<'terms' | 'date'>(initial.dueMode);
  const [termsDays, setTermsDays] = React.useState(initial.termsDays);
  const [dueDate, setDueDate] = React.useState(initial.dueDate);
  const [doc, setDoc] = React.useState<DocumentLinesValue>(initial.doc);
  const [memo, setMemo] = React.useState(initial.memo);
  const [footer, setFooter] = React.useState(initial.footer);
  const [paymentUrl, setPaymentUrl] = React.useState(initial.paymentUrl);
  const [errors, setErrors] = React.useState<FormError[]>([]);
  const [busy, setBusy] = React.useState<'draft' | 'issue' | 'issue-new' | null>(null);
  const idemRef = React.useRef(idempotencyKey());

  const current: FormState = { contactId, issueDate, dueMode, termsDays, dueDate, doc, memo, footer, paymentUrl };
  const [baseline, setBaseline] = React.useState<FormState>(initial);
  // The default category fills in once accounts load; that alone is not an unsaved edit.
  const defaultIncome = useDefaultIncomeAccountId();
  const dirty = snapshot(current, defaultIncome) !== snapshot(baseline, defaultIncome);
  const contact = useContact(contactId ?? '');
  const guard = useUnsavedChanges(dirty && busy === null);

  const previewInput = React.useMemo(() => toPreviewInput(doc), [doc]);
  const debouncedInput = useDebounced(previewInput, 300);
  const preview = useDocumentPreview(debouncedInput);
  const previewStale = debouncedInput !== previewInput || preview.isFetching;

  const termsValid = /^\d+$/.test(termsDays.trim()) && Number(termsDays) <= 365;
  const computedDue = dueMode === 'terms' && termsValid && /^\d{4}-\d{2}-\d{2}$/.test(issueDate) ? addDays(issueDate, Number(termsDays)) : null;

  const validate = (): FormError[] => {
    const errs: FormError[] = [];
    if (!contactId) errs.push({ message: 'Choose a customer.', fieldId: 'customer' });
    if (!issueDate) errs.push({ message: 'Issue date is required.', fieldId: 'issueDate' });
    if (dueMode === 'terms') {
      if (!termsValid) errs.push({ message: 'Days to pay must be a whole number from 0 to 365.', fieldId: 'termsDays' });
    } else {
      if (!dueDate) errs.push({ message: 'Due date is required.', fieldId: 'dueDate' });
      else if (issueDate && dueDate < issueDate) errs.push({ message: 'Due date cannot be before the issue date.', fieldId: 'dueDate' });
    }
    errs.push(...validateDocumentLines(doc));
    const url = paymentUrl.trim();
    if (url && !/^https:\/\/\S+$/.test(url)) errs.push({ message: 'Payment URL must start with https://', fieldId: 'paymentUrl' });
    return errs;
  };

  // Errors clear as soon as their field is fixed, rather than waiting for the next submit.
  const shownErrors = errors.length ? stillFailing(errors, validate()) : errors;
  const invalid = invalidFields(shownErrors);

  const buildInput = (): CreateInvoiceInput => ({
    contactId: contactId!,
    issueDate,
    ...(dueMode === 'terms' ? { termsDays: Number(termsDays) } : { dueDate }),
    lines: doc.lines.map(normalizeLine),
    documentDiscount: normalizeDiscount(doc.documentDiscount),
    memo: memo.trim() || null,
    footer: footer.trim() || null,
    paymentUrl: paymentUrl.trim() || null,
  });

  const save = async (): Promise<InvoiceDto> => {
    const input = buildInput();
    return invoice ? update.mutateAsync({ ...input, version: invoice.version }) : create.mutateAsync(input);
  };

  /** Issuing a draft created moments ago: the id is only known after saving, so this bypasses the id-bound hook. */
  const issueNew = async (saved: InvoiceDto): Promise<InvoiceDto> => {
    const issued = await api<InvoiceDto>(`/api/invoices/${saved.id}/issue`, {
      method: 'POST',
      body: { version: saved.version, idempotencyKey: idemRef.current },
      companyId: company.id,
    });
    qc.setQueryData(qk.invoices.detail(company.id, issued.id), issued);
    await invalidateAfterSalesPosting(qc, company.id);
    return issued;
  };

  /** Start the next invoice: keep the dates and terms (a batch usually shares them), clear the rest. */
  const resetForNext = () => {
    const next: FormState = { ...current, contactId: null, doc: { lines: [blankDocumentLine()], documentDiscount: null }, memo: defaults?.defaultNotes ?? '', paymentUrl: '' };
    setContactId(null);
    setDoc(next.doc);
    setMemo('');
    setPaymentUrl('');
    setErrors([]);
    setBaseline(next);
    idemRef.current = idempotencyKey();
    requestAnimationFrame(() => document.getElementById('customer')?.focus());
  };

  const submit = async (mode: 'draft' | 'issue' | 'issue-new') => {
    const errs = validate();
    setErrors(errs);
    if (errs.length) {
      focusFirstError(errs);
      return;
    }
    setBusy(mode);
    let saved: InvoiceDto | null = null;
    try {
      saved = await save();
      if (mode === 'draft') {
        guard.markSaved();
        toast.success(invoice ? 'Draft saved' : 'Draft created');
        router.push(`/invoices/${saved.id}`);
        return;
      }
      // A freshly created draft has its own id; the hook above is bound to the edited one.
      const issued = invoice ? await issue.mutateAsync({ version: saved.version, idempotencyKey: idemRef.current }) : await issueNew(saved);
      const title = `Invoice ${issued.number ?? ''} issued`.replace(/\s+/g, ' ');
      if (mode === 'issue-new') {
        toast.success(title, undefined, { action: { label: 'View', onClick: () => router.push(`/invoices/${issued.id}`) } });
        resetForNext();
        return;
      }
      guard.markSaved();
      toast.success(title);
      router.push(`/invoices/${issued.id}`);
    } catch (e) {
      onError(e, mode === 'draft' ? 'Could not save draft' : 'Could not issue invoice');
      // The draft was saved even if issuing failed; land on it rather than losing the work.
      if (mode !== 'draft' && !invoice && saved) {
        guard.markSaved();
        router.push(`/invoices/${saved.id}`);
      }
    } finally {
      setBusy(null);
    }
  };

  const modKey = useModKeyLabel();
  const shortcut = useSubmitShortcut(() => busy === null && void submit('issue'), true);

  return (
    <>
      <PageHeader
        title={invoice ? `Edit draft ${invoice.number ?? ''}`.trim() : copyOf ? `New invoice (copy of ${copyOf.number ?? 'draft'})` : 'New invoice'}
        description={
          <>
            Add what you sold and save it as a draft, or <Term id="issue">issue</Term> it to give it a number and send it. Once issued, it counts as money your customer owes you and the lines can&rsquo;t be changed.
          </>
        }
      />
      <Card>
        <CardBody className="space-y-5">
          <div {...shortcut} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <ContactPicker kind="customer" value={contactId} onChange={setContactId} required id="customer" invalid={invalid.has('customer')} disabled={busy !== null} autoFocus={!invoice && !copyOf} />
              <Field label="Issue date" htmlFor="issueDate" required>
                <DateInput id="issueDate" value={issueDate} onChange={setIssueDate} aria-invalid={invalid.has('issueDate') || undefined} />
              </Field>
              <Field label="Due" htmlFor="dueMode" hint={dueMode === 'terms' ? 'Counted from the issue date.' : 'Pick the date the customer should pay by.'}>
                <Select
                  id="dueMode"
                  value={dueMode}
                  onChange={(e) => {
                    const m = e.target.value as 'terms' | 'date';
                    // Carry the computed date across so switching modes does not lose it.
                    if (m === 'date' && !dueDate && computedDue) setDueDate(computedDue);
                    setDueMode(m);
                  }}
                >
                  <option value="terms">Days to pay</option>
                  <option value="date">Specific due date</option>
                </Select>
              </Field>
              {dueMode === 'terms' ? (
                <Field label="Days to pay" htmlFor="termsDays" required hint={computedDue ? <span data-testid="computed-due">Due {formatDate(computedDue)}</span> : undefined}>
                  <Input id="termsDays" inputMode="numeric" value={termsDays} aria-invalid={invalid.has('termsDays') || undefined} onChange={(e) => setTermsDays(e.target.value)} />
                </Field>
              ) : (
                <Field label="Due date" htmlFor="dueDate" required>
                  <DateInput
                    id="dueDate"
                    value={dueDate}
                    min={issueDate || undefined}
                    presets={termsPresets(issueDate)}
                    aria-invalid={invalid.has('dueDate') || undefined}
                    onChange={setDueDate}
                  />
                </Field>
              )}
            </div>

            {!invoice?.number && <CustomerCreditNotice contactId={contactId} customerName={contact.data?.name} currency={company.baseCurrency} />}

            <DocumentLines value={doc} onChange={setDoc} preview={preview.data ?? null} previewPending={previewStale} disabled={busy !== null} invalid={invalid} />
            {preview.isError && (
              <p role="alert" className="text-xs text-red-700">
                Totals could not be computed: {preview.error instanceof Error ? preview.error.message : 'unknown error'}
              </p>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Memo" htmlFor="memo" hint="Shown to the customer above the totals.">
                <Textarea id="memo" value={memo} onChange={(e) => setMemo(e.target.value)} rows={3} maxLength={2000} />
              </Field>
              <Field label="Footer" htmlFor="footer" hint="Payment instructions, thank-you note, terms.">
                <Textarea id="footer" value={footer} onChange={(e) => setFooter(e.target.value)} rows={3} maxLength={2000} />
              </Field>
            </div>
            <Field label="Payment URL" htmlFor="paymentUrl" hint={PAYMENT_URL_HELP}>
              <Input id="paymentUrl" type="url" placeholder="https://" value={paymentUrl} aria-invalid={invalid.has('paymentUrl') || undefined} onChange={(e) => setPaymentUrl(e.target.value)} />
            </Field>

            <ErrorSummary errors={shownErrors} />

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-stone-200 pt-4">
              <span className="mr-auto hidden text-xs text-stone-500 sm:inline">{modKey}+Enter to save and issue</span>
              <Button variant="secondary" onClick={() => void guard.leave(() => router.back())} disabled={busy !== null}>
                Cancel
              </Button>
              <Button variant="secondary" onClick={() => submit('draft')} loading={busy === 'draft'} disabled={busy !== null}>
                Save draft
              </Button>
              {!invoice && (
                <Button variant="secondary" onClick={() => submit('issue-new')} loading={busy === 'issue-new'} disabled={busy !== null} title="Issue this invoice and start another with the same dates and terms">
                  Issue and new
                </Button>
              )}
              <Button onClick={() => submit('issue')} loading={busy === 'issue'} disabled={busy !== null}>
                Save and issue
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
    </>
  );
}

interface FormState {
  contactId: string | null;
  issueDate: string;
  dueMode: 'terms' | 'date';
  termsDays: string;
  dueDate: string;
  doc: DocumentLinesValue;
  memo: string;
  footer: string;
  paymentUrl: string;
}

function snapshot(s: FormState, defaultIncome: string | null): string {
  return JSON.stringify([s.contactId, s.issueDate, s.dueMode, s.termsDays, s.dueDate, withDefaultIncomeAccount(s.doc, defaultIncome), s.memo, s.footer, s.paymentUrl]);
}

/** The submitted errors that still apply to the current input. */
export function stillFailing(submitted: FormError[], now: FormError[]): FormError[] {
  const key = (e: FormError) => `${e.fieldId ?? ''}|${e.message}`;
  const live = new Set(now.map(key));
  return submitted.filter((e) => live.has(key(e)));
}
