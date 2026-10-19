'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Ban, Pencil, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { DateInput } from '@/components/ui/date-input';
import { MoneyInput } from '@/components/ui/money-input';
import { BackLink } from '@/components/ui/list';
import { Field, Select, Textarea } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useApplyCreditNote, useCreditNote, useCreditNoteRefunds, useDeleteCreditNote, useIssueCreditNote, useVoidCreditNote } from '@/lib/queries/credit-notes';
import { useCustomerBalance } from '@/lib/queries/invoices';
import { useAccounts } from '@/lib/queries/accounts';
import { RefundsTable } from '@/app/(app)/payments/view';
import { RefundDialog } from '@/app/(app)/payments/refund-dialog';
import { fractionToPercent } from '@/lib/queries/tax-rates';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { formatDate, formatDateTime, formatMoney, isZeroDecimal } from '@/lib/format';
import { compareDecimals, isValidDecimal, subtractDecimals, sumDecimals } from '@/lib/decimal';
import { CreditNoteStatusBadge } from '@/components/status-badges';
import { AllocationsList } from '@/app/(app)/invoices/[id]/view';
import { CreditNoteForm } from '../credit-note-form';
import { useDeleteRecordAction } from '@/components/delete-record-dialog';
import { ActionMenu } from '@/components/ui/action-menu';

export function CreditNoteDetailView({ id, applyTo }: { id: string; /** Open "Apply to invoices" with this invoice filled in (`?apply=`). */ applyTo?: string }) {
  const router = useRouter();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const confirm = useConfirm();
  const q = useCreditNote(id);
  const accounts = useAccounts();
  const cn = q.data;
  const balance = useCustomerBalance(cn?.contactId);
  const refunds = useCreditNoteRefunds(id, !!cn && cn.status !== 'draft');

  const issue = useIssueCreditNote(id);
  const apply = useApplyCreditNote(id);
  const voidCn = useVoidCreditNote(id);
  const remove = useDeleteCreditNote();
  const deleteAction = useDeleteRecordAction('credit_note', id, { redirectTo: '/credit-notes' });

  const [editing, setEditing] = React.useState(false);
  const [dialog, setDialog] = React.useState<null | 'issue' | 'apply' | 'void' | 'refund'>(null);
  const [applyToInvoiceId, setApplyToInvoiceId] = React.useState('');
  const [applyDate, setApplyDate] = React.useState('');
  const [amounts, setAmounts] = React.useState<Record<string, string>>({});
  const [voidReason, setVoidReason] = React.useState('');
  const idem = React.useRef({ issue: idempotencyKey(), apply: idempotencyKey(), void: idempotencyKey() });

  // Opened from an invoice ("Apply the $50 credit note"): open Apply with that invoice filled in, once.
  const applyPrefilled = React.useRef(false);
  const applyTarget = applyTo ? balance.data?.openInvoices.find((i) => i.id === applyTo) : undefined;
  React.useEffect(() => {
    if (applyPrefilled.current || !cn || cn.status !== 'issued' || !applyTarget || isZeroDecimal(cn.balance)) return;
    applyPrefilled.current = true;
    setAmounts({ [applyTarget.id]: compareDecimals(cn.balance, applyTarget.balanceDue) < 0 ? cn.balance : applyTarget.balanceDue });
    setApplyDate('');
    setDialog('apply');
  }, [cn, applyTarget]);

  const accountName = (accountId: string) => {
    const a = accounts.data?.find((x) => x.id === accountId);
    return a ? `${a.code} ${a.name}` : accountId;
  };

  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  if (!cn) return null;
  const cur = cn.currency;
  const isDraft = cn.status === 'draft';
  const isVoid = cn.status === 'void';
  const canVoid = cn.status === 'issued' && isZeroDecimal(cn.amountUsed);
  const openInvoices = balance.data?.openInvoices ?? [];

  // Apply dialog: every entered amount must be a positive decimal no larger than that invoice's balance,
  // and the sum may not exceed the credit note balance. Comparisons use the decimal helpers, never floats.
  const allocations = openInvoices
    .map((i) => ({ invoiceId: i.id, amount: (amounts[i.id] ?? '').trim(), max: i.balanceDue }))
    .filter((a) => a.amount !== '');
  const allocationErrors: string[] = [];
  for (const a of allocations) {
    if (!isValidDecimal(a.amount) || compareDecimals(a.amount, '0') <= 0) allocationErrors.push('Amounts must be positive numbers.');
    else if (compareDecimals(a.amount, a.max) > 0) allocationErrors.push('An amount exceeds that invoice’s balance due.');
  }
  const applySum = sumDecimals(allocations.filter((a) => isValidDecimal(a.amount)).map((a) => a.amount));
  if (compareDecimals(applySum, cn.balance) > 0) allocationErrors.push(`Total applied (${formatMoney(applySum, cur)}) exceeds the credit balance (${formatMoney(cn.balance, cur)}).`);
  const applyValid = allocations.length > 0 && allocationErrors.length === 0;

  const openIssue = () => {
    setApplyToInvoiceId(cn.invoiceId && openInvoices.some((i) => i.id === cn.invoiceId) ? cn.invoiceId : '');
    setDialog('issue');
  };
  const openApply = () => {
    setAmounts({});
    setApplyDate('');
    idem.current.apply = idempotencyKey();
    setDialog('apply');
  };

  const openVoid = () => {
    setVoidReason('');
    setDialog('void');
  };
  const deleteDraft = async () => {
    const ok = await confirm({
      title: 'Delete this draft credit note?',
      description: 'Nothing is recorded from a draft, so deleting it leaves no trace in your books. This cannot be undone.',
      confirmLabel: 'Delete draft',
      tone: 'danger',
    });
    if (!ok) return;
    remove.mutate(id, {
      onSuccess: () => {
        toast.success('Draft deleted');
        router.push('/credit-notes');
      },
      onError: (e) => onError(e, 'Could not delete draft'),
    });
  };
  const submitIssue = () =>
    issue.mutate(
      { version: cn.version, applyToInvoiceId: applyToInvoiceId || null, idempotencyKey: idem.current.issue },
      {
        onSuccess: (r) => {
          toast.success(`Credit note ${r.number ?? ''} issued`.trim());
          setDialog(null);
        },
        onError: (e) => onError(e, 'Could not issue credit note'),
      },
    );
  const submitApply = () => {
    if (!applyValid || apply.isPending) return;
    apply.mutate(
      { version: cn.version, date: applyDate || undefined, allocations: allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })), idempotencyKey: idem.current.apply },
      {
        onSuccess: () => {
          toast.success('Credit applied');
          setDialog(null);
        },
        onError: (e) => onError(e, 'Could not apply credit'),
      },
    );
  };
  const submitVoid = () => {
    if (!voidReason.trim() || voidCn.isPending) return;
    voidCn.mutate(
      { version: cn.version, reason: voidReason.trim(), idempotencyKey: idem.current.void },
      {
        onSuccess: () => {
          toast.success('Credit note voided');
          setDialog(null);
        },
        onError: (e) => onError(e, 'Could not void credit note'),
      },
    );
  };
  /** Fill one invoice with as much credit as is still unassigned (capped at its balance). */
  const fillRemaining = (invoiceId: string, max: string) => {
    const others = sumDecimals(allocations.filter((a) => a.invoiceId !== invoiceId && isValidDecimal(a.amount)).map((a) => a.amount));
    const left = subtractDecimals(cn.balance, others);
    const amount = compareDecimals(left, max) < 0 ? left : max;
    setAmounts((m) => ({ ...m, [invoiceId]: compareDecimals(amount, '0') > 0 ? amount : '' }));
  };

  if (editing && isDraft) {
    return (
      <>
        <BackLink listPath="/credit-notes" label="Credit notes" />
        <PageHeader title={`Edit draft credit note`} description="Changes are saved to the draft. Nothing is recorded until you issue it." />
        <Card>
          <CreditNoteForm embedded creditNote={cn} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} />
        </Card>
      </>
    );
  }

  return (
    <>
      <BackLink listPath="/credit-notes" label="Credit notes" />
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {cn.number ?? 'Draft credit note'}
            <CreditNoteStatusBadge creditNote={cn} />
          </span>
        }
        description={`${cn.contactName ?? cn.customerSnapshot.name} · ${formatDate(cn.issueDate)}${cn.reason ? ` · ${cn.reason}` : ''}`}
        actions={
          <>
            {isDraft && (
              <>
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  <Pencil className="size-4" /> Edit
                </Button>
                <Button onClick={openIssue}>Issue…</Button>
              </>
            )}
            {cn.status === 'issued' && (
              <Button onClick={openApply} disabled={isZeroDecimal(cn.balance)}>
                Apply to invoices…
              </Button>
            )}
            <ActionMenu
              groups={[
                [
                  cn.status === 'issued' && {
                    label: 'Refund…',
                    icon: Undo2,
                    disabled: isZeroDecimal(cn.balance),
                    description: isZeroDecimal(cn.balance) ? 'All of this credit has been used' : `Give back up to ${formatMoney(cn.balance, cur)} to the customer`,
                    onSelect: () => setDialog('refund'),
                  },
                ],
                [
                  isDraft && { label: 'Delete draft', icon: Trash2, tone: 'danger', description: 'Nothing is recorded yet', onSelect: () => void deleteDraft() },
                  cn.status === 'issued' && {
                    label: 'Void…',
                    icon: Ban,
                    tone: 'danger',
                    disabled: !canVoid,
                    description: canVoid ? 'Marks it Void and keeps its number' : `${formatMoney(cn.amountUsed, cur)} has been used or refunded; undo that first`,
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
      {isVoid && (
        <div role="status" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <span className="font-medium">Voided.</span> {cn.voidReason && <span>Reason: “{cn.voidReason}”.</span>} It stays in your records with its number, and your reports leave it out.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card>
            <Table aria-label="Credit note lines">
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
                  <TH numeric>Net</TH>
                </TR>
              </THead>
              <TBody>
                {cn.lines.map((l) => (
                  <TR key={l.id}>
                    <TD>
                      {l.description}
                      <p className="text-xs text-stone-500 sm:hidden">
                        {l.quantity} × {formatMoney(l.unitPrice, cur)}
                      </p>
                      {l.taxes.length > 0 && <p className="text-xs text-stone-500">{l.taxes.map((t) => `${t.name} ${fractionToPercent(t.rate)}`).join(', ')}</p>}
                    </TD>
                    <TD className="hidden text-stone-500 md:table-cell">{l.incomeAccountName ?? accountName(l.incomeAccountId)}</TD>
                    <TD numeric className="hidden sm:table-cell">
                      {l.quantity}
                    </TD>
                    <TD numeric className="hidden sm:table-cell">
                      {formatMoney(l.unitPrice, cur)}
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
                  <dd>{formatMoney(cn.subtotal, cur)}</dd>
                </div>
                {!isZeroDecimal(cn.discountTotal) && (
                  <div className="flex justify-between">
                    <dt className="text-stone-500">Discounts</dt>
                    <dd>−{formatMoney(cn.discountTotal, cur)}</dd>
                  </div>
                )}
                {cn.taxSummary.map((t) => (
                  <div key={t.taxRateId} className="flex justify-between">
                    <dt className="text-stone-500">
                      {t.name} ({fractionToPercent(t.rate)})
                    </dt>
                    <dd>{formatMoney(t.amount, cur)}</dd>
                  </div>
                ))}
                <div className="flex justify-between border-t border-stone-200 pt-1 font-semibold text-stone-900">
                  <dt>Total</dt>
                  <dd data-testid="credit-note-total">{formatMoney(cn.total, cur)}</dd>
                </div>
                {!isDraft && !isVoid && (
                  <>
                    <div className="flex justify-between">
                      <dt className="text-stone-500">Used or refunded</dt>
                      <dd>−{formatMoney(cn.amountUsed, cur)}</dd>
                    </div>
                    <div className="flex justify-between text-base font-semibold text-stone-900">
                      <dt>Credit left</dt>
                      <dd data-testid="credit-note-balance">{formatMoney(cn.balance, cur)}</dd>
                    </div>
                  </>
                )}
              </dl>
            </div>
          </Card>

          {!isDraft && (
            <Card>
              <CardHeader title="Applied to invoices" />
              <AllocationsList allocations={cn.allocations ?? []} cur={cur} hide="source" />
            </Card>
          )}

          {!isDraft && (
            <Card>
              <CardHeader title="Refunds" description="Money you gave back to the customer from this credit note." />
              {refunds.isPending && <Spinner />}
              {refunds.isError && <ErrorNotice error={refunds.error} onRetry={() => refunds.refetch()} />}
              {refunds.data && refunds.data.length === 0 && (
                <CardBody>
                  <EmptyState compact title="No refunds" description={cn.status === 'issued' && !isZeroDecimal(cn.balance) ? 'To give this credit back as money, choose Refund… in the ⋯ menu.' : undefined} />
                </CardBody>
              )}
              {refunds.data && refunds.data.length > 0 && <RefundsTable refunds={refunds.data} currency={cur} showSource={false} />}
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Customer" />
            <CardBody className="text-sm">
              <p className="font-medium text-stone-900">{cn.customerSnapshot.name}</p>
              {cn.customerSnapshot.email && <p className="text-stone-500">{cn.customerSnapshot.email}</p>}
              <Link href={`/contacts/${cn.contactId}`} className="mt-2 inline-block text-xs text-brand-700 underline">
                Open customer
              </Link>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <dl className="grid grid-cols-2 gap-y-2 text-sm">
                <dt className="text-stone-500">Issue date</dt>
                <dd>{formatDate(cn.issueDate)}</dd>
                <dt className="text-stone-500">For invoice</dt>
                <dd>
                  {cn.invoiceId ? (
                    <Link href={`/invoices/${cn.invoiceId}`} className="font-mono text-xs text-brand-700 underline">
                      {cn.invoiceNumber ?? 'Invoice'}
                    </Link>
                  ) : (
                    '—'
                  )}
                </dd>
                <dt className="text-stone-500">Reason</dt>
                <dd>{cn.reason ?? '—'}</dd>
                <dt className="text-stone-500">Total</dt>
                <dd className="tabular font-medium">{formatMoney(cn.total, cur)}</dd>
                {!isDraft && (
                  <>
                    <dt className="text-stone-500">Credit left</dt>
                    <dd className="tabular font-medium">{isVoid ? '—' : formatMoney(cn.balance, cur)}</dd>
                  </>
                )}
                <dt className="text-stone-500">Created</dt>
                <dd>{formatDateTime(cn.createdAt)}</dd>
              </dl>
              {(cn.journalEntryId || cn.voidJournalEntryId) && (
                <details className="mt-3 border-t border-stone-100 pt-2 text-sm">
                  <summary className="cursor-pointer text-xs font-medium text-stone-500 hover:text-stone-800">Accounting details</summary>
                  <dl className="mt-2 grid grid-cols-2 gap-y-2">
                    {cn.journalEntryId && (
                      <>
                        <dt className="text-stone-500">Journal entry</dt>
                        <dd>
                          <Link className="text-brand-700 underline" href={`/journal/${cn.journalEntryId}`}>
                            View entry
                          </Link>
                        </dd>
                      </>
                    )}
                    {cn.voidJournalEntryId && (
                      <>
                        <dt className="text-stone-500">Void entry</dt>
                        <dd>
                          <Link className="text-brand-700 underline" href={`/journal/${cn.voidJournalEntryId}`}>
                            View reversal
                          </Link>
                        </dd>
                      </>
                    )}
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
        title="Issue credit note"
        description="Gives it a number and lowers what the customer owes. You can put the credit straight onto one of their unpaid invoices."
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button type="submit" loading={issue.isPending}>
              Issue credit note
            </Button>
          </>
        }
      >
        <Field label="Apply to invoice" htmlFor="apply-to" hint="Up to what's still due on that invoice; anything left stays as credit for the customer.">
          <Select id="apply-to" data-autofocus value={applyToInvoiceId} aria-busy={balance.isFetching || undefined} onChange={(e) => setApplyToInvoiceId(e.target.value)}>
            <option value="">Keep it as credit for now</option>
            {openInvoices.map((i) => (
              <option key={i.id} value={i.id}>
                {i.number} · {formatMoney(i.balanceDue, cur)} due{i.isOverdue ? ' (overdue)' : ''}
              </option>
            ))}
          </Select>
        </Field>
      </Dialog>

      <Dialog
        open={dialog === 'apply'}
        onClose={() => setDialog(null)}
        onSubmit={submitApply}
        dirty={allocations.length > 0 || !!applyDate}
        title="Apply credit to invoices"
        description={`Credit available: ${formatMoney(cn.balance, cur)}. Enter an amount next to each invoice to apply.`}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button type="submit" loading={apply.isPending} disabled={!applyValid}>
              Apply {formatMoney(applySum, cur)}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {balance.isPending && <Spinner />}
          {balance.isError && <ErrorNotice error={balance.error} onRetry={() => balance.refetch()} />}
          {balance.data && openInvoices.length === 0 && <EmptyState title="No open invoices" description="This customer has nothing outstanding to apply the credit to." />}
          {openInvoices.length > 0 && (
            <Table aria-label="Open invoices">
              <THead>
                <TR>
                  <TH>Invoice</TH>
                  <TH className="hidden sm:table-cell">Due</TH>
                  <TH numeric>Balance due</TH>
                  <TH numeric className="w-44">
                    Apply
                  </TH>
                </TR>
              </THead>
              <TBody>
                {openInvoices.map((i, idx) => (
                  <TR key={i.id}>
                    <TD className="font-mono text-xs">{i.number}</TD>
                    <TD className={`hidden sm:table-cell ${i.isOverdue ? 'text-red-700' : ''}`}>{formatDate(i.dueDate)}</TD>
                    <TD numeric>{formatMoney(i.balanceDue, cur)}</TD>
                    <TD numeric>
                      <div className="flex items-center justify-end gap-1">
                        <Button type="button" variant="ghost" size="sm" onClick={() => fillRemaining(i.id, i.balanceDue)} aria-label={`Fill ${i.number} with remaining credit`} title="Fill with the remaining credit">
                          Max
                        </Button>
                        <MoneyInput
                          aria-label={`Apply to ${i.number}`}
                          data-autofocus={idx === 0 ? true : undefined}
                          className="w-28"
                          placeholder="0.00"
                          value={amounts[i.id] ?? ''}
                          onChange={(v) => setAmounts((m) => ({ ...m, [i.id]: v }))}
                        />
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          <Field label="Date applied" htmlFor="apply-date" hint="Leave blank for today. Use a later date if that month is locked.">
            <DateInput id="apply-date" value={applyDate} min={cn.issueDate} onChange={setApplyDate} />
          </Field>
          {allocations.length > 0 && allocationErrors.length > 0 && (
            <ul role="alert" className="list-disc rounded-md border border-red-200 bg-red-50 p-3 pl-8 text-sm text-red-800">
              {Array.from(new Set(allocationErrors)).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>

      <Dialog
        open={dialog === 'void'}
        onClose={() => setDialog(null)}
        onSubmit={submitVoid}
        dirty={!!voidReason.trim()}
        title="Void credit note"
        description="The credit note stays in your records marked Void, keeps its number, and your reports drop it."
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={voidCn.isPending} disabled={!voidReason.trim()}>
              Void credit note
            </Button>
          </>
        }
      >
        <Field label="Reason" htmlFor="cn-void-reason" required>
          <Textarea id="cn-void-reason" data-autofocus value={voidReason} onChange={(e) => setVoidReason(e.target.value)} maxLength={500} />
        </Field>
      </Dialog>
      {dialog === 'refund' && cn.status === 'issued' && (
        <RefundDialog source={{ type: 'credit_note', id: cn.id, max: cn.balance, date: cn.issueDate, currency: cur }} onClose={() => setDialog(null)} />
      )}
    </>
  );
}
