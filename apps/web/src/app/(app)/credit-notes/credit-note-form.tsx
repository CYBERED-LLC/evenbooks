'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { CreateCreditNoteInput, CreditNoteDto, InvoiceDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardBody, PageHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { DateInput } from '@/components/ui/date-input';
import { ErrorSummary, focusFirstError, invalidFields, type FormError } from '@/components/ui/error-summary';
import { useToast } from '@/components/ui/toast';
import { ContactPicker } from '@/components/contact-picker';
import { blankDocumentLine, DocumentLines, normalizeDiscount, normalizeLine, toPreviewInput, validateDocumentLines, withDefaultIncomeAccount, type DocumentLinesValue } from '@/components/document-lines';
import { Term } from '@/components/ui/term';
import { useCustomerBalance, useDocumentPreview } from '@/lib/queries/invoices';
import { useCreateCreditNote, useUpdateCreditNote } from '@/lib/queries/credit-notes';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { formatMoney, todayIso } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { useDefaultIncomeAccountId } from '@/lib/queries/items';
import { useCompany } from '@/components/company-context';
import { lineFromDto, stillFailing } from '@/app/(app)/invoices/invoice-form';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';
import { useModKeyLabel, useSubmitShortcut } from '@/lib/use-hotkeys';

export interface CreditNoteFormProps {
  /** Edit this draft (inline on the detail page). */
  creditNote?: CreditNoteDto;
  /** Prefill for a new credit note: the customer and, when raised against an invoice, its lines. */
  fromInvoice?: InvoiceDto;
  contactId?: string;
  onSaved?(cn: CreditNoteDto): void;
  onCancel?(): void;
  embedded?: boolean;
}

/** Create or edit a draft credit note. Shares the line editor and server preview with invoices. */
export function CreditNoteForm({ creditNote, fromInvoice, contactId: contactIdProp, onSaved, onCancel, embedded }: CreditNoteFormProps) {
  const router = useRouter();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const { company } = useCompany();
  const create = useCreateCreditNote();
  const update = useUpdateCreditNote(creditNote?.id ?? '');

  const [contactId, setContactId] = React.useState<string | null>(creditNote?.contactId ?? fromInvoice?.contactId ?? contactIdProp ?? null);
  const [invoiceId, setInvoiceId] = React.useState<string>(creditNote?.invoiceId ?? fromInvoice?.id ?? '');
  const [issueDate, setIssueDate] = React.useState(creditNote?.issueDate ?? todayIso(company.timeZone));
  const [reason, setReason] = React.useState(creditNote?.reason ?? '');
  const [doc, setDoc] = React.useState<DocumentLinesValue>(() => {
    const source = creditNote ?? fromInvoice;
    return source ? { lines: source.lines.map(lineFromDto), documentDiscount: source.documentDiscount } : { lines: [blankDocumentLine()], documentDiscount: null };
  });
  const [errors, setErrors] = React.useState<FormError[]>([]);
  // The default category fills in once accounts load; that alone is not an unsaved edit.
  const defaultIncome = useDefaultIncomeAccountId();
  const snap = (d: DocumentLinesValue) => JSON.stringify([contactId, invoiceId, issueDate, reason, withDefaultIncomeAccount(d, defaultIncome)]);
  const [baseline] = React.useState(() => ({ contactId, invoiceId, issueDate, reason, doc }));
  const [saved, setSaved] = React.useState(false);
  const baselineSnap = JSON.stringify([baseline.contactId, baseline.invoiceId, baseline.issueDate, baseline.reason, withDefaultIncomeAccount(baseline.doc, defaultIncome)]);
  const guard = useUnsavedChanges(!saved && snap(doc) !== baselineSnap);

  const balance = useCustomerBalance(contactId);
  const previewInput = React.useMemo(() => toPreviewInput(doc), [doc]);
  const debouncedInput = useDebounced(previewInput, 300);
  const preview = useDocumentPreview(debouncedInput);
  const previewStale = debouncedInput !== previewInput || preview.isFetching;
  const pending = create.isPending || update.isPending;

  // The linked invoice must belong to the selected customer; keep a foreign selection visible but flagged.
  const openInvoices = balance.data?.openInvoices ?? [];
  const invoiceKnown = !invoiceId || openInvoices.some((i) => i.id === invoiceId) || invoiceId === fromInvoice?.id || invoiceId === creditNote?.invoiceId;

  const validate = (): FormError[] => {
    const errs: FormError[] = [];
    if (!contactId) errs.push({ message: 'Choose a customer.', fieldId: 'cn-customer' });
    if (!issueDate) errs.push({ message: 'Issue date is required.', fieldId: 'cn-issueDate' });
    errs.push(...validateDocumentLines(doc, 'cnl'));
    return errs;
  };
  const shownErrors = errors.length ? stillFailing(errors, validate()) : errors;
  const invalid = invalidFields(shownErrors);

  const submit = () => {
    if (pending) return;
    const errs = validate();
    setErrors(errs);
    if (errs.length) {
      focusFirstError(errs);
      return;
    }
    const input: CreateCreditNoteInput = {
      contactId: contactId!,
      invoiceId: invoiceId || null,
      issueDate,
      reason: reason.trim() || null,
      lines: doc.lines.map(normalizeLine),
      documentDiscount: normalizeDiscount(doc.documentDiscount),
    };
    const done = (cn: CreditNoteDto) => {
      guard.markSaved();
      setSaved(true);
      toast.success(creditNote ? 'Draft saved' : 'Draft created');
      if (onSaved) onSaved(cn);
      else router.push(`/credit-notes/${cn.id}`);
    };
    if (creditNote) update.mutate({ ...input, version: creditNote.version }, { onSuccess: done, onError: (e) => onError(e, 'Could not save draft') });
    else create.mutate(input, { onSuccess: done, onError: (e) => onError(e, 'Could not create credit note') });
  };

  const modKey = useModKeyLabel();
  const shortcut = useSubmitShortcut(submit, true);

  const body = (
    <CardBody>
      <div {...shortcut} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <ContactPicker
            kind="customer"
            value={contactId}
            required
            id="cn-customer"
            invalid={invalid.has('cn-customer')}
            autoFocus={!creditNote && !fromInvoice && !contactIdProp}
            disabled={pending}
            onChange={(id) => {
              setContactId(id);
              setInvoiceId('');
            }}
          />
          <Field label="For invoice" htmlFor="cn-invoice" hint="Optional. The credit goes onto this invoice when you issue it.">
            <Select id="cn-invoice" value={invoiceId} disabled={pending || !contactId} aria-busy={balance.isFetching || undefined} onChange={(e) => setInvoiceId(e.target.value)}>
              <option value="">No specific invoice</option>
              {!invoiceKnown && <option value={invoiceId}>(current selection)</option>}
              {fromInvoice && !openInvoices.some((i) => i.id === fromInvoice.id) && (
                <option value={fromInvoice.id}>
                  {fromInvoice.number ?? 'Invoice'} · {formatMoney(fromInvoice.balanceDue, company.baseCurrency)} due
                </option>
              )}
              {openInvoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.number} · {formatMoney(i.balanceDue, company.baseCurrency)} due{i.isOverdue ? ' (overdue)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Issue date" htmlFor="cn-issueDate" required>
            <DateInput id="cn-issueDate" value={issueDate} onChange={setIssueDate} aria-invalid={invalid.has('cn-issueDate') || undefined} />
          </Field>
          <Field label="Reason" htmlFor="cn-reason" hint="Shown on the credit note.">
            <Input id="cn-reason" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>

        <DocumentLines idPrefix="cnl" invalid={invalid} value={doc} onChange={setDoc} preview={preview.data ?? null} previewPending={previewStale} disabled={pending} />
        {preview.isError && (
          <p role="alert" className="text-xs text-red-700">
            Totals could not be computed: {preview.error instanceof Error ? preview.error.message : 'unknown error'}
          </p>
        )}

        <ErrorSummary errors={shownErrors} />

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-stone-200 pt-4">
          <span className="mr-auto hidden text-xs text-stone-500 sm:inline">{modKey}+Enter to save</span>
          <Button variant="secondary" onClick={() => void guard.leave(() => (onCancel ? onCancel() : router.back()))} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {creditNote ? 'Save draft' : 'Create draft'}
          </Button>
        </div>
      </div>
    </CardBody>
  );

  if (embedded) return body;
  return (
    <>
      <PageHeader
        title={creditNote ? `Edit draft ${creditNote.number ?? ''}`.trim() : 'New credit note'}
        description={
          <>
            Use a <Term id="credit-note" /> for a refund, a discount or a mistake on an invoice you already sent. It starts as a draft. Issuing lowers what the customer owes.
          </>
        }
      />
      <Card>{body}</Card>
    </>
  );
}
