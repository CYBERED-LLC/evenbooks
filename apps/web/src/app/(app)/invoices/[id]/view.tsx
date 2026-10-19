'use client';
import { useInvoiceEmailPreview } from '@/lib/queries/invoice-presentation';
import { useDebounced } from '@/lib/use-debounced';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Ban, Banknote, Copy, CopyPlus, ExternalLink, FileDown, FileMinus, Link2, Palette, Pencil, RefreshCw, Repeat, Send, Trash2 } from 'lucide-react';
import type { AllocationDto, EmailMessageDto, InvoiceDto } from '@evenbooks/contracts';
import { Button, LinkButton } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { DateInput } from '@/components/ui/date-input';
import { BackLink } from '@/components/ui/list';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import {
  useDeleteInvoice,
  useGenerateInvoicePdf,
  useInvoice,
  useInvoiceEmails,
  useInvoicePdfVersions,
  useIssueInvoice,
  usePublicLink,
  useSendInvoiceEmail,
  useUpdateInvoice,
  useVoidInvoice,
  type PublicLinkResult,
} from '@/lib/queries/invoices';
import { useAccounts } from '@/lib/queries/accounts';
import { useContact } from '@/lib/queries/contacts';
import { fractionToPercent } from '@/lib/queries/tax-rates';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { capitalize, formatDate, formatDateTime, formatMoney, isZeroDecimal } from '@/lib/format';
import { InvoiceStatusBadge } from '@/components/status-badges';
import { BalanceSummary, InvoiceActivity } from './activity';
import { PAYMENT_URL_HELP } from '../invoice-form';
import { OnlinePaymentsCard } from './online-payments';
import { useDeleteRecordAction } from '@/components/delete-record-dialog';
import { Term } from '@/components/ui/term';
import { CustomerCreditNotice } from '../customer-credit';
import { ActionMenu, phoneHidden } from '@/components/ui/action-menu';

function AddressBlock({ snapshot }: { snapshot: InvoiceDto['customerSnapshot'] }) {
  const a = snapshot.address ?? {};
  const cityLine = [a.city, a.region].filter(Boolean).join(', ') + (a.postalCode ? ` ${a.postalCode}` : '');
  return (
    <address className="text-sm not-italic text-stone-700">
      <p className="font-medium text-stone-900">{snapshot.name}</p>
      {a.line1 && <p>{a.line1}</p>}
      {a.line2 && <p>{a.line2}</p>}
      {cityLine.trim() && <p>{cityLine.trim()}</p>}
      {a.country && <p>{a.country}</p>}
      {snapshot.email && <p className="mt-1 text-stone-500">{snapshot.email}</p>}
      {snapshot.phone && <p className="text-stone-500">{snapshot.phone}</p>}
    </address>
  );
}

export function AllocationsList({ allocations, cur, hide }: { allocations: AllocationDto[]; cur: string; hide: 'invoice' | 'source' }) {
  if (allocations.length === 0)
    return (
      <div className="px-4 py-3">
        <EmptyState compact title="Nothing applied yet" />
      </div>
    );
  return (
    <Table aria-label={hide === 'invoice' ? 'Payments and credits' : 'Applied to invoices'}>
      <THead>
        <TR>
          <TH className="w-28">Date</TH>
          <TH>{hide === 'invoice' ? 'From' : 'Invoice'}</TH>
          <TH numeric>Amount</TH>
        </TR>
      </THead>
      <TBody>
        {allocations.map((a) => {
          const href = hide === 'invoice' ? (a.sourceType === 'payment' ? `/payments/${a.paymentId}` : `/credit-notes/${a.creditNoteId}`) : `/invoices/${a.invoiceId}`;
          const label = hide === 'invoice' ? a.sourceLabel ?? (a.sourceType === 'payment' ? 'Payment' : 'Credit note') : a.invoiceNumber ?? 'Invoice';
          return (
            <TR key={a.id} className={a.status === 'reversed' ? 'text-stone-400 line-through' : undefined}>
              <TD>{formatDate(a.date)}</TD>
              <TD>
                <Link href={href} className="font-medium text-brand-700 hover:underline">
                  {label}
                </Link>
                {hide === 'invoice' && a.sourceLabel && a.sourceLabel !== capitalize(a.sourceType) && <span className="ml-1 text-xs text-stone-500">{a.sourceType === 'payment' ? 'Payment' : 'Credit note'}</span>}
                {a.status === 'reversed' && (
                  <Badge tone="neutral" className="ml-2">
                    Removed
                  </Badge>
                )}
              </TD>
              <TD numeric>{formatMoney(a.amount, cur)}</TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}

export function InvoiceDetailView({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const confirm = useConfirm();
  const q = useInvoice(id);
  const accounts = useAccounts();
  const inv = q.data;
  const postIssue = !!inv && inv.status !== 'draft';
  const emails = useInvoiceEmails(id, postIssue);
  const pdfVersions = useInvoicePdfVersions(id, postIssue);
  // The issue-time snapshot is the record, but if it has no email the contact may have gained one since.
  const contact = useContact(inv && !inv.customerSnapshot.email ? inv.contactId : '');

  const issue = useIssueInvoice(id);
  const voidInvoice = useVoidInvoice(id);
  const remove = useDeleteInvoice();
  const deleteAction = useDeleteRecordAction('invoice', id, { redirectTo: '/invoices' });
  const send = useSendInvoiceEmail(id);
  const publicLink = usePublicLink(id);
  const pdf = useGenerateInvoicePdf(id);
  const update = useUpdateInvoice(id);

  const [dialog, setDialog] = React.useState<null | 'issue' | 'void' | 'send' | 'link' | 'paymentUrl'>(null);
  const [issueDate, setIssueDate] = React.useState('');
  const [voidReason, setVoidReason] = React.useState('');
  const [voidDate, setVoidDate] = React.useState('');
  const [sendTo, setSendTo] = React.useState('');
  const [sendMessage, setSendMessage] = React.useState<string | null>(null);
  const [sendSubject, setSendSubject] = React.useState<string | null>(null);
  const [usePlatformSender, setUsePlatformSender] = React.useState(false);
  const previewInput = useDebounced({ invoiceId: id, subject: sendSubject ?? undefined, message: sendMessage, usePlatformSender }, 300);
  const emailPreview = useInvoiceEmailPreview(previewInput, dialog === 'send');
  const [paymentUrl, setPaymentUrl] = React.useState('');
  const [link, setLink] = React.useState<PublicLinkResult | null>(null);
  const idem = React.useRef({ issue: idempotencyKey(), void: idempotencyKey(), send: idempotencyKey() });

  const accountName = (accountId: string) => {
    const a = accounts.data?.find((x) => x.id === accountId);
    return a ? `${a.code} ${a.name}` : accountId;
  };

  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  if (!inv) return null;
  const cur = inv.currency;
  const isDraft = inv.status === 'draft';
  const isVoid = inv.status === 'void';
  const settled = !isZeroDecimal(inv.amountSettled);
  const canVoid = inv.status === 'issued' && !settled;
  const title = inv.number ?? 'Draft invoice';

  const defaultSendTo = inv.customerSnapshot.email ?? contact.data?.email ?? '';
  const sendToFromContact = !inv.customerSnapshot.email && !!contact.data?.email;
  const openSend = () => {
    setSendTo(defaultSendTo);
    setSendMessage(null);
    setSendSubject(null);
    setUsePlatformSender(false);
    idem.current.send = idempotencyKey();
    setDialog('send');
  };
  const openLink = () => {
    setLink(null);
    setDialog('link');
    publicLink.mutate('get', { onSuccess: setLink, onError: (e) => onError(e, 'Could not load public link') });
  };
  const downloadPdf = () =>
    pdf.mutate(false, {
      onSuccess: (r) => {
        window.open(r.downloadPath, '_blank', 'noopener,noreferrer');
        void pdfVersions.refetch();
      },
      onError: (e) => onError(e, 'Could not generate PDF'),
    });
  const resend = (m: EmailMessageDto) =>
    send.mutate(
      { to: m.toEmail, idempotencyKey: idempotencyKey() },
      { onSuccess: () => toast.success('Email queued'), onError: (e) => onError(e, 'Could not resend email') },
    );
  const deleteDraft = async () => {
    const ok = await confirm({
      title: 'Delete this draft invoice?',
      description: 'Nothing is recorded from a draft, so deleting it leaves no trace in your books. This cannot be undone.',
      confirmLabel: 'Delete draft',
      tone: 'danger',
    });
    if (!ok) return;
    remove.mutate(id, {
      onSuccess: () => {
        toast.success('Draft deleted');
        router.push('/invoices');
      },
      onError: (e) => onError(e, 'Could not delete draft'),
    });
  };
  const openPaymentUrl = () => {
    setPaymentUrl(inv.paymentUrl ?? '');
    setDialog('paymentUrl');
  };
  const openIssue = () => {
    setIssueDate('');
    setDialog('issue');
  };
  const openVoid = () => {
    setVoidReason('');
    setVoidDate('');
    setDialog('void');
  };
  const submitIssue = () =>
    issue.mutate(
      { version: inv.version, issueDate: issueDate || undefined, idempotencyKey: idem.current.issue },
      {
        onSuccess: (r) => {
          toast.success(`Invoice ${r.number ?? ''} issued`.trim());
          setDialog(null);
        },
        onError: (e) => onError(e, 'Could not issue invoice'),
      },
    );
  const submitVoid = () => {
    if (!voidReason.trim() || voidInvoice.isPending) return;
    voidInvoice.mutate(
      { version: inv.version, reason: voidReason.trim(), date: voidDate || undefined, idempotencyKey: idem.current.void },
      {
        onSuccess: () => {
          toast.success('Invoice voided');
          setDialog(null);
        },
        onError: (e) => onError(e, 'Could not void invoice'),
      },
    );
  };
  const sendValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sendTo.trim());
  const submitSend = () => {
    if (!sendValid || send.isPending || !emailPreview.data || emailPreview.isError || !((sendSubject ?? emailPreview.data.subject).trim())) return;
    send.mutate(
      { to: sendTo.trim(), message: sendMessage, subject: sendSubject ?? undefined, usePlatformSender, idempotencyKey: idem.current.send },
      {
        onSuccess: () => {
          toast.success('Email queued');
          setDialog(null);
        },
        onError: (e) => onError(e, 'Could not send email'),
      },
    );
  };
  const paymentUrlValid = !paymentUrl.trim() || /^https:\/\/\S+$/.test(paymentUrl.trim());
  const submitPaymentUrl = () => {
    if (!paymentUrlValid || update.isPending) return;
    update.mutate(
      { version: inv.version, paymentUrl: paymentUrl.trim() || null },
      {
        onSuccess: () => {
          toast.success('Payment URL updated');
          setDialog(null);
        },
        onError: (e) => onError(e, 'Could not update payment URL'),
      },
    );
  };
  const issuedOrPaid = inv.status === 'issued' || inv.status === 'paid';

  const copyLink = async () => {
    if (!link?.url) return;
    try {
      await navigator.clipboard.writeText(link.url);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy', 'Select the link and copy it manually.');
    }
  };

  return (
    <>
      <BackLink listPath="/invoices" label="Invoices" />
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {title}
            <InvoiceStatusBadge invoice={inv} />
          </span>
        }
        description={
          <>
            <Link href={`/contacts/${inv.contactId}`} className="font-medium text-stone-800 hover:text-brand-700 hover:underline">
              {inv.contactName ?? inv.customerSnapshot.name}
            </Link>
            {` · ${isDraft ? 'dated' : 'issued'} ${formatDate(inv.issueDate)}`}
            {!isVoid && <BalanceSummary invoice={inv} />}
          </>
        }
        actions={
          <>
            {isDraft && (
              <>
                <LinkButton href={`/invoices/${id}/edit`} variant="secondary">
                  <Pencil className="size-4" /> Edit
                </LinkButton>
                <Button onClick={openIssue}>Issue…</Button>
              </>
            )}
            {issuedOrPaid && (
              <>
                <Button variant="secondary" className={phoneHidden} onClick={downloadPdf} loading={pdf.isPending}>
                  <FileDown className="size-4" /> Download PDF
                </Button>
                <Button variant="secondary" onClick={openSend}>
                  <Send className="size-4" /> Send…
                </Button>
              </>
            )}
            {inv.status === 'issued' && (
              <LinkButton href={`/payments/new?invoiceId=${id}`}>
                <Banknote className="size-4" /> Record payment
              </LinkButton>
            )}
            {isVoid && (
              <LinkButton href={`/invoices/new?copyFrom=${id}`} variant="secondary">
                <CopyPlus className="size-4" /> Duplicate
              </LinkButton>
            )}
            <ActionMenu
              groups={[
                [
                  issuedOrPaid && { label: 'Download PDF', icon: FileDown, phoneOnly: true, disabled: pdf.isPending, onSelect: downloadPdf },
                  issuedOrPaid && { label: 'Public link…', icon: Link2, description: inv.hasPublicLink ? 'Active: copy, rotate or revoke' : 'Share without signing in', onSelect: openLink },
                ],
                [
                  !isVoid && { label: 'Duplicate', icon: CopyPlus, href: `/invoices/new?copyFrom=${id}` },
                  issuedOrPaid && { label: 'Create credit note', icon: FileMinus, href: `/credit-notes/new?invoiceId=${id}` },
                  issuedOrPaid && { label: 'Make recurring', icon: Repeat, href: `/recurring/new?invoiceId=${id}`, description: 'Bill these lines on a schedule' },
                ],
                [
                  isDraft && { label: 'Delete draft', icon: Trash2, tone: 'danger', description: 'Nothing is recorded yet', onSelect: () => void deleteDraft() },
                  inv.status === 'issued' && {
                    label: 'Void…',
                    icon: Ban,
                    tone: 'danger',
                    disabled: !canVoid,
                    description: settled ? `${formatMoney(inv.amountSettled, cur)} has been paid toward it; remove those payments from the invoice first` : 'Marks it Void and keeps its number',
                    onSelect: openVoid,
                  },
                  !isDraft && deleteAction.item,
                ],
              ]}
            />
          </>
        }
      />
      {deleteAction.dialog}
      {inv.status === 'issued' && (
        <div className="mb-4">
          <CustomerCreditNotice contactId={inv.contactId} customerName={inv.contactName ?? inv.customerSnapshot.name} currency={cur} invoiceId={inv.id} />
        </div>
      )}
      {isVoid && (
        <div role="status" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <span className="font-medium">Voided.</span> {inv.voidReason && <span>Reason: “{inv.voidReason}”.</span>} It stays in your records with its number, and your reports leave it out.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card>
            <Table aria-label="Invoice lines">
              <THead>
                <TR>
                  <TH>Description</TH>
                  <TH className="hidden md:table-cell">Category</TH>
                  <TH numeric className="hidden sm:table-cell">
                    Qty
                  </TH>
                  <TH numeric className="hidden sm:table-cell">
                    Unit price
                  </TH>
                  <TH numeric className="hidden lg:table-cell">
                    Tax
                  </TH>
                  <TH numeric>Net</TH>
                </TR>
              </THead>
              <TBody>
                {inv.lines.map((l) => (
                  <TR key={l.id}>
                    <TD>
                      {l.description}
                      <p className="text-xs text-stone-500 sm:hidden">
                        {l.quantity} × {formatMoney(l.unitPrice, cur)}
                      </p>
                      {l.discount && (
                        <p className="text-xs text-stone-500">Discount {l.discount.type === 'percent' ? `${l.discount.value}%` : formatMoney(l.discount.value, cur)}</p>
                      )}
                    </TD>
                    <TD className="hidden text-stone-500 md:table-cell">{l.incomeAccountName ?? accountName(l.incomeAccountId)}</TD>
                    <TD numeric className="hidden sm:table-cell">
                      {l.quantity}
                    </TD>
                    <TD numeric className="hidden sm:table-cell">
                      {formatMoney(l.unitPrice, cur)}
                    </TD>
                    <TD numeric className="hidden lg:table-cell">
                      {l.taxes.length ? l.taxes.map((t) => `${t.name} ${fractionToPercent(t.rate)}`).join(', ') : '—'}
                    </TD>
                    <TD numeric>{formatMoney(l.net, cur)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <div className="flex justify-end border-t border-stone-200 px-4 py-3">
              <dl className="tabular w-full max-w-xs space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt className="text-stone-500">Subtotal</dt>
                  <dd>{formatMoney(inv.subtotal, cur)}</dd>
                </div>
                {!isZeroDecimal(inv.discountTotal) && (
                  <div className="flex justify-between">
                    <dt className="text-stone-500">Discounts</dt>
                    <dd>−{formatMoney(inv.discountTotal, cur)}</dd>
                  </div>
                )}
                {inv.taxSummary.map((t) => (
                  <div key={t.taxRateId} className="flex justify-between">
                    <dt className="text-stone-500">
                      {t.name} ({fractionToPercent(t.rate)})
                    </dt>
                    <dd>{formatMoney(t.amount, cur)}</dd>
                  </div>
                ))}
                <div className="flex justify-between border-t border-stone-200 pt-1 font-semibold text-stone-900">
                  <dt>Total</dt>
                  <dd data-testid="invoice-total">{formatMoney(inv.total, cur)}</dd>
                </div>
                {!isDraft && !isVoid && (
                  <>
                    {settled && (
                      <div className="flex justify-between">
                        <dt className="text-stone-500">Paid</dt>
                        <dd>−{formatMoney(inv.amountSettled, cur)}</dd>
                      </div>
                    )}
                    <div className="flex justify-between text-base font-semibold text-stone-900">
                      <dt>Balance due</dt>
                      <dd data-testid="invoice-balance-due">{formatMoney(inv.balanceDue, cur)}</dd>
                    </div>
                  </>
                )}
              </dl>
            </div>
          </Card>

          {(inv.memo || inv.footer) && (
            <Card>
              <CardBody className="space-y-3 text-sm">
                {inv.memo && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Memo</p>
                    <p className="whitespace-pre-wrap text-stone-800">{inv.memo}</p>
                  </div>
                )}
                {inv.footer && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Footer</p>
                    <p className="whitespace-pre-wrap text-stone-800">{inv.footer}</p>
                  </div>
                )}
              </CardBody>
            </Card>
          )}

          {!isDraft && (inv.allocations ?? []).length > 0 && (
            <Card>
              <CardHeader title="Payments and credits" description="Applied to this invoice." />
              <AllocationsList allocations={inv.allocations ?? []} cur={cur} hide="invoice" />
            </Card>
          )}

          {(inv.status === 'issued' || inv.status === 'paid') && <OnlinePaymentsCard invoice={inv} />}

          {postIssue && (
            <InvoiceActivity
              invoice={inv}
              emails={emails}
              pdfVersions={pdfVersions}
              onResend={isVoid ? undefined : resend}
              resendingTo={send.isPending ? send.variables?.to : undefined}
              newVersionMenu={
                <ActionMenu
                  label="New PDF"
                  size="sm"
                  groups={[
                    [
                      {
                        label: 'Apply current branding',
                        icon: Palette,
                        description: 'Re-render with your current invoice design',
                        disabled: pdf.isPending,
                        onSelect: () =>
                          pdf.mutate('apply-design', {
                            onSuccess: () => {
                              void pdfVersions.refetch();
                              toast.success('New PDF version created with the current design');
                            },
                            onError: (e) => onError(e, 'Could not update design'),
                          }),
                      },
                      {
                        label: 'Regenerate as issued',
                        icon: RefreshCw,
                        description: 'Same design as when the invoice was issued',
                        disabled: pdf.isPending,
                        onSelect: () =>
                          pdf.mutate(true, {
                            onSuccess: () => {
                              void pdfVersions.refetch();
                              toast.success('New PDF version created');
                            },
                            onError: (e) => onError(e, 'Could not regenerate PDF'),
                          }),
                      },
                    ],
                  ]}
                />
              }
            />
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Customer" description={isDraft ? 'Copied onto the invoice when you issue it.' : 'As it appeared on the invoice when you issued it.'} />
            <CardBody>
              <AddressBlock snapshot={inv.customerSnapshot} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <dl className="grid grid-cols-2 gap-y-2 text-sm">
                <dt className="text-stone-500">Issue date</dt>
                <dd>{formatDate(inv.issueDate)}</dd>
                <dt className="text-stone-500">Due date</dt>
                <dd>
                  {formatDate(inv.dueDate)} <span className="text-xs text-stone-500">({inv.termsDays === 0 ? 'due on receipt' : `${inv.termsDays} ${inv.termsDays === 1 ? 'day' : 'days'} to pay`})</span>
                </dd>
                <dt className="text-stone-500">Payment URL</dt>
                <dd className="flex min-w-0 items-baseline gap-2">
                  {inv.paymentUrl ? (
                    <a href={inv.paymentUrl} target="_blank" rel="noopener noreferrer" className="truncate text-brand-700 underline">
                      {inv.paymentUrl.replace(/^https:\/\//, '')}
                    </a>
                  ) : (
                    <span>—</span>
                  )}
                  {inv.status === 'issued' && (
                    <Button variant="link" size="sm" className="shrink-0 text-xs" onClick={openPaymentUrl} aria-label="Edit payment URL">
                      Edit
                    </Button>
                  )}
                </dd>
                <dt className="text-stone-500">Public link</dt>
                <dd className="flex items-baseline gap-2">
                  {inv.hasPublicLink ? 'Active' : 'None'}
                  {issuedOrPaid && (
                    <Button variant="link" size="sm" className="text-xs" onClick={openLink} aria-label="Manage public link">
                      {inv.hasPublicLink ? 'Manage' : 'Create'}
                    </Button>
                  )}
                </dd>
                {inv.recurringScheduleId && (
                  <>
                    <dt className="text-stone-500">Recurring</dt>
                    <dd>
                      <Link className="text-brand-700 underline" href={`/recurring/${inv.recurringScheduleId}`}>
                        {inv.recurringOccurrenceIndex != null ? `Invoice ${inv.recurringOccurrenceIndex} of the schedule` : 'From a schedule'}
                      </Link>
                    </dd>
                  </>
                )}
                {isDraft && (
                  <>
                    <dt className="text-stone-500">Created</dt>
                    <dd>{formatDateTime(inv.createdAt)}</dd>
                  </>
                )}
              </dl>
              {(inv.journalEntryId || inv.voidJournalEntryId) && (
                <details className="mt-3 border-t border-stone-100 pt-2 text-sm">
                  <summary className="cursor-pointer text-xs font-medium text-stone-500 hover:text-stone-800">Accounting details</summary>
                  <dl className="mt-2 grid grid-cols-2 gap-y-2">
                    {inv.journalEntryId && (
                      <>
                        <dt className="text-stone-500">Journal entry</dt>
                        <dd>
                          <Link className="text-brand-700 underline" href={`/journal/${inv.journalEntryId}`}>
                            View entry
                          </Link>
                        </dd>
                      </>
                    )}
                    {inv.voidJournalEntryId && (
                      <>
                        <dt className="text-stone-500">Void entry</dt>
                        <dd>
                          <Link className="text-brand-700 underline" href={`/journal/${inv.voidJournalEntryId}`}>
                            View reversal
                          </Link>
                        </dd>
                      </>
                    )}
                    <dt className="text-stone-500">Currency</dt>
                    <dd>{cur}</dd>
                  </dl>
                </details>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      <Dialog
        open={dialog === 'issue'}
        onClose={() => setDialog(null)}
        onSubmit={submitIssue}
        dirty={!!issueDate}
        title="Issue invoice"
        description={
          <>
            Gives it a number and counts it as <Term id="receivable">money your customer owes you</Term>. The lines can&rsquo;t be changed afterwards; to fix a mistake later, void it or give a credit note.
          </>
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button type="submit" loading={issue.isPending} data-autofocus>
              Issue invoice
            </Button>
          </>
        }
      >
        <Field label="Issue date" htmlFor="issue-date" hint={`Leave blank to keep ${formatDate(inv.issueDate)}. The due date shifts with it.`}>
          <DateInput id="issue-date" value={issueDate} onChange={setIssueDate} />
        </Field>
      </Dialog>

      <Dialog
        open={dialog === 'void'}
        onClose={() => setDialog(null)}
        onSubmit={submitVoid}
        dirty={!!voidReason.trim() || !!voidDate}
        title="Void invoice"
        description="The invoice stays in your records marked Void, keeps its number, and your reports drop it."
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={voidInvoice.isPending} disabled={!voidReason.trim()}>
              Void invoice
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Reason" htmlFor="void-reason" required>
            <Textarea id="void-reason" data-autofocus value={voidReason} onChange={(e) => setVoidReason(e.target.value)} maxLength={500} />
          </Field>
          <Field label="Void date" htmlFor="void-date" hint={`Leave blank to void it as of ${formatDate(inv.issueDate)}, the issue date. Use a later date if that month is locked.`}>
            <DateInput id="void-date" value={voidDate} min={inv.issueDate} onChange={setVoidDate} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={dialog === 'send'}
        onClose={() => setDialog(null)}
        onSubmit={submitSend}
        dirty={sendMessage !== null || sendSubject !== null || usePlatformSender || sendTo.trim() !== defaultSendTo}
        size="lg"
        title="Send invoice"
        description="The PDF is attached and the email is queued for delivery. Delivery updates appear under Activity."
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button type="submit" loading={send.isPending} disabled={!sendValid || emailPreview.isPending || emailPreview.isError || !(sendSubject ?? emailPreview.data?.subject)?.trim()}>
              Send email
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label="To"
            htmlFor="send-to"
            required
            hint={
              sendToFromContact && sendTo === defaultSendTo
                ? 'From the contact’s current details. This invoice was issued without an email address.'
                : undefined
            }
          >
            <Input id="send-to" type="email" data-autofocus={!sendTo ? true : undefined} value={sendTo} onChange={(e) => setSendTo(e.target.value)} />
          </Field>
          <p className="break-words text-sm text-stone-600">From: {emailPreview.data?.from ?? 'Loading sender…'}<br />Reply-to: {emailPreview.data?.replyTo ?? 'None'}</p>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={usePlatformSender} onChange={(e)=>setUsePlatformSender(e.target.checked)} />Use the Evenbooks sender for this email</label>
          <Field label="Subject" htmlFor="send-subject" required><Input id="send-subject" value={sendSubject ?? emailPreview.data?.subject ?? ''} maxLength={250} onChange={(e)=>setSendSubject(e.target.value)} /></Field>
          <Field label="Message" htmlFor="send-message" hint="Starts with your company's email template. Changes apply to this email.">
            <Textarea id="send-message" data-autofocus={sendTo ? true : undefined} value={sendMessage ?? emailPreview.data?.message ?? ''} onChange={(e) => setSendMessage(e.target.value)} maxLength={5000} rows={5} />
          </Field>
          {emailPreview.isError && <ErrorNotice error={emailPreview.error} />}
          {emailPreview.data && <details><summary className="cursor-pointer text-sm font-medium">Preview email</summary><iframe title="Outgoing invoice email preview" sandbox="" srcDoc={emailPreview.data.html} className="mt-3 h-96 w-full rounded border border-stone-200" /></details>}
          {send.isError && <ErrorNotice error={send.error} />}
        </div>
      </Dialog>

      <Dialog
        open={dialog === 'link'}
        onClose={() => setDialog(null)}
        title="Public link"
        description="Anyone with this link can view and download the invoice without signing in. Rotating invalidates the old link."
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Done
            </Button>
            {link?.url && (
              <Button
                variant="danger"
                loading={publicLink.isPending && publicLink.variables === 'revoke'}
                onClick={() =>
                  publicLink.mutate('revoke', {
                    onSuccess: (r) => {
                      setLink(r);
                      toast.success('Public link revoked');
                    },
                    onError: (e) => onError(e, 'Could not revoke link'),
                  })
                }
              >
                Revoke
              </Button>
            )}
            <Button
              variant="secondary"
              loading={publicLink.isPending && publicLink.variables === 'rotate'}
              onClick={() =>
                publicLink.mutate('rotate', {
                  onSuccess: (r) => {
                    setLink(r);
                    toast.success('New link generated');
                  },
                  onError: (e) => onError(e, 'Could not rotate link'),
                })
              }
            >
              <RefreshCw className="size-4" /> {link?.url ? 'Rotate' : 'Generate'}
            </Button>
            {link?.url && (
              <Button onClick={copyLink}>
                <Copy className="size-4" /> Copy
              </Button>
            )}
          </>
        }
      >
        {publicLink.isPending && !link && <Spinner label="Loading link" />}
        {publicLink.isError && !link && <ErrorNotice error={publicLink.error} onRetry={() => publicLink.mutate('get', { onSuccess: setLink })} />}
        {link && !link.url && <p className="text-sm text-stone-600">No active link. Generate one to share this invoice.</p>}
        {link?.url && (
          <div className="space-y-2">
            <Field label="Public link URL" htmlFor="public-link-url">
              <Input id="public-link-url" readOnly value={link.url} data-testid="public-link-url" onFocus={(e) => e.currentTarget.select()} />
            </Field>
            <a href={link.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-brand-700 underline">
              Open in new tab <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </div>
        )}
      </Dialog>

      <Dialog
        open={dialog === 'paymentUrl'}
        onClose={() => setDialog(null)}
        onSubmit={submitPaymentUrl}
        dirty={paymentUrl.trim() !== (inv.paymentUrl ?? '')}
        title="Edit payment URL"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button type="submit" loading={update.isPending} disabled={!paymentUrlValid}>
              Save
            </Button>
          </>
        }
      >
        <Field label="Payment URL" htmlFor="payment-url" hint={PAYMENT_URL_HELP} error={paymentUrlValid ? undefined : 'Use a full https:// link.'}>
          <Input id="payment-url" type="url" data-autofocus placeholder="https://" value={paymentUrl} aria-invalid={!paymentUrlValid || undefined} onChange={(e) => setPaymentUrl(e.target.value)} />
        </Field>
      </Dialog>
    </>
  );
}
