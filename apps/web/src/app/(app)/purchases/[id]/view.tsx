'use client';
import * as React from 'react';
import Link from 'next/link';
import { Ban, Copy, ExternalLink, Paperclip, Trash2 } from 'lucide-react';
import { Button, LinkButton } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/input';
import { DateInput } from '@/components/ui/date-input';
import { BackLink } from '@/components/ui/list';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useAttachReceipt, useAttachmentsFor, useDeleteAttachment, usePurchase, useVoidPurchase } from '@/lib/queries/purchases';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { useDeleteRecordAction } from '@/components/delete-record-dialog';
import { ActionMenu } from '@/components/ui/action-menu';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function PurchaseDetailView({ id }: { id: string }) {
  const confirm = useConfirm();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const q = usePurchase(id);
  const attachments = useAttachmentsFor('purchase', id);
  const voidPurchase = useVoidPurchase(id);
  const deleteAttachment = useDeleteAttachment('purchase', id);
  const attach = useAttachReceipt(id);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [attaching, setAttaching] = React.useState(0);
  const [voiding, setVoiding] = React.useState(false);
  const deleteAction = useDeleteRecordAction('purchase', id, { redirectTo: '/purchases' });
  const [voidDate, setVoidDate] = React.useState('');
  const [reason, setReason] = React.useState('');
  const idem = React.useRef(idempotencyKey());

  const closeVoid = () => {
    setVoiding(false);
    setReason('');
    setVoidDate('');
  };

  const deleteReceipt = async (a: { id: string; fileName: string }) => {
    const ok = await confirm({
      title: `Delete ${a.fileName}?`,
      description: 'The file is removed from this expense. The expense itself is not changed.',
      confirmLabel: 'Delete receipt',
      tone: 'danger',
    });
    if (!ok) return;
    deleteAttachment.mutate(a.id, {
      onSuccess: () => toast.success('Receipt deleted'),
      onError: (e) => onError(e, 'Could not delete receipt'),
    });
  };

  // One file at a time so each failure names its file; the list refreshes after each.
  const attachFiles = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (fileRef.current) fileRef.current.value = '';
    if (list.length === 0) return;
    setAttaching(list.length);
    let done = 0;
    for (const file of list) {
      try {
        await attach.mutateAsync(file);
        done++;
      } catch (e) {
        onError(e, `Could not attach ${file.name}`);
      }
      setAttaching((n) => n - 1);
    }
    if (done > 0) toast.success(done === 1 ? 'Receipt attached' : `${done} receipts attached`);
  };

  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data;
  const cur = p.currency;
  const isVoid = p.status === 'void';

  const submitVoid = () => {
    if (!reason.trim() || voidPurchase.isPending) return;
    voidPurchase.mutate(
      { version: p.version, reason: reason.trim(), date: voidDate || undefined, idempotencyKey: idem.current },
      {
        onSuccess: () => {
          toast.success('Expense voided');
          closeVoid();
        },
        onError: (err) => onError(err, 'Could not void expense'),
      },
    );
  };

  return (
    <>
      <BackLink listPath="/purchases" label="Expenses" />
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {p.direction === 'inflow' ? (p.contactName ? `Refund from ${p.contactName}` : 'Vendor refund') : p.contactName ? `Expense · ${p.contactName}` : 'Expense'}
            {isVoid && <Badge tone="neutral">Void</Badge>}
            {p.direction === 'inflow' && <Badge tone="blue">Refund</Badge>}
          </span>
        }
        description={p.memo}
        actions={
          <>
            <LinkButton href={`/purchases/new?copyFrom=${p.id}`} variant="secondary">
              <Copy className="size-4" aria-hidden /> Duplicate
            </LinkButton>
            <ActionMenu
              groups={[
                [
                  !isVoid && { label: 'Void…', icon: Ban, tone: 'danger', description: 'Cancel it in your books; it stays on record', onSelect: () => setVoiding(true) },
                  deleteAction.item,
                ],
              ]}
            />
          </>
        }
      />
      {deleteAction.dialog}
      {isVoid && (
        <div role="status" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <span className="font-medium">Voided.</span> {p.voidReason && <span>Reason: “{p.voidReason}”.</span>}{' '}
          {p.voidJournalEntryId && (
            <Link className="underline" href={`/journal/${p.voidJournalEntryId}`}>
              View reversal entry
            </Link>
          )}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card>
            <Table aria-label="Expense lines">
              <THead>
                <TR>
                  <TH className="w-12">#</TH>
                  <TH>Category</TH>
                  <TH className="hidden sm:table-cell">Description</TH>
                  <TH numeric>Amount</TH>
                </TR>
              </THead>
              <TBody>
                {p.lines.map((l) => (
                  <TR key={l.id}>
                    <TD className="font-mono text-xs text-stone-500">{l.lineNo}</TD>
                    <TD>
                      <span className="font-mono text-xs text-stone-500">{l.accountCode}</span> {l.accountName}
                      {l.description && <p className="text-xs text-stone-500 sm:hidden">{l.description}</p>}
                    </TD>
                    <TD className="hidden text-stone-500 sm:table-cell">{l.description}</TD>
                    <TD numeric>{formatMoney(l.amount, cur)}</TD>
                  </TR>
                ))}
                <TR className="font-semibold">
                  <TD colSpan={3}>Total</TD>
                  <TD numeric data-testid="purchase-total">
                    {formatMoney(p.total, cur)}
                  </TD>
                </TR>
              </TBody>
            </Table>
          </Card>
          <Card>
            <CardHeader
              title="Receipts"
              description="Photos or PDFs of the receipt. They open in a new tab."
              actions={
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    multiple
                    accept="application/pdf,image/*"
                    className="hidden"
                    aria-label="Receipt files"
                    data-testid="attach-receipt-input"
                    onChange={(e) => void attachFiles(e.target.files)}
                  />
                  <Button variant="secondary" size="sm" loading={attaching > 0} onClick={() => fileRef.current?.click()}>
                    <Paperclip className="size-4" aria-hidden /> Attach receipt
                  </Button>
                </>
              }
            />
            {attachments.isPending && <Spinner />}
            {attachments.isError && <ErrorNotice error={attachments.error} onRetry={() => attachments.refetch()} />}
            {attachments.data && attachments.data.length === 0 && (
              <CardBody>
                <EmptyState compact title="No receipts attached" description="PDF or photos, up to 15 MB each." />
              </CardBody>
            )}
            {attachments.data && attachments.data.length > 0 && (
              <ul className="divide-y divide-stone-100 text-sm" aria-label="Attachments">
                {attachments.data.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-2">
                    <div className="min-w-0">
                      <a href={`/api/attachments/${a.id}/download`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">
                        <span className="truncate">{a.fileName}</span>
                        <ExternalLink className="size-3.5 shrink-0" aria-hidden />
                      </a>
                      <p className="text-xs text-stone-500">
                        {a.contentType} · {formatBytes(a.sizeBytes)} · {formatDateTime(a.createdAt)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete ${a.fileName}`}
                      loading={deleteAttachment.isPending && deleteAttachment.variables === a.id}
                      onClick={() => void deleteReceipt(a)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <Card>
          <CardHeader title="Details" />
          <CardBody>
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-stone-500">Date</dt>
              <dd>{formatDate(p.date)}</dd>
              <dt className="text-stone-500">Vendor</dt>
              <dd>{p.contactName ?? '—'}</dd>
              <dt className="text-stone-500">Paid from</dt>
              <dd>{p.paidFromAccountName ?? p.paidFromAccountId}</dd>
              <dt className="text-stone-500">Type</dt>
              <dd>{p.direction === 'outflow' ? 'Paid' : 'Vendor refund'}</dd>
              <dt className="text-stone-500">Reference</dt>
              <dd>{p.reference ?? '—'}</dd>
              <dt className="text-stone-500">Total</dt>
              <dd className="tabular font-medium">{formatMoney(p.total, cur)}</dd>
              <dt className="text-stone-500">Currency</dt>
              <dd>{cur}</dd>
              <dt className="text-stone-500">Journal entry</dt>
              <dd>
                <Link className="text-brand-700 underline" href={`/journal/${p.journalEntryId}`}>
                  View entry
                </Link>
              </dd>
              {p.voidJournalEntryId && (
                <>
                  <dt className="text-stone-500">Reversal entry</dt>
                  <dd>
                    <Link className="text-brand-700 underline" href={`/journal/${p.voidJournalEntryId}`}>
                      View reversal
                    </Link>
                  </dd>
                </>
              )}
              {p.bankTransactionId && (
                <>
                  <dt className="text-stone-500">Bank transaction</dt>
                  <dd>
                    <Link className="text-brand-700 underline" href={`/banking/inbox?transactionId=${p.bankTransactionId}`}>
                      View
                    </Link>
                  </dd>
                </>
              )}
              <dt className="text-stone-500">Created</dt>
              <dd>{formatDateTime(p.createdAt)}</dd>
            </dl>
          </CardBody>
        </Card>
      </div>
      <Dialog
        open={voiding}
        onClose={closeVoid}
        title="Void expense"
        description="Evenbooks cancels it in your books and keeps it on record, marked Void. Nothing is deleted."
        onSubmit={submitVoid}
        dirty={!!reason.trim() && !voidPurchase.isPending}
        footer={
          <>
            <Button variant="secondary" onClick={closeVoid}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={voidPurchase.isPending} disabled={!reason.trim()}>
              Void expense
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Reason" htmlFor="void-reason" required>
            <Textarea id="void-reason" data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
          <Field label="Void date" htmlFor="void-date" hint="Leave blank to use the expense’s own date. It can’t be in a locked period.">
            <DateInput id="void-date" value={voidDate} min={p.date} onChange={setVoidDate} />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
