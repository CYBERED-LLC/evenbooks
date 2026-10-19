'use client';
import * as React from 'react';
import Link from 'next/link';
import { Trash2 } from 'lucide-react';
import type { BankTransactionDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { useDeleteRecordAction } from '@/components/delete-record-dialog';
import { useUndoReview } from '@/lib/queries/inbox';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';

const OUTCOME: Record<BankTransactionDto['status'], string> = {
  unreviewed: 'For review',
  categorized: 'Categorized and recorded in your books',
  matched: 'Matched to something already recorded',
  transfer: 'Recorded as a transfer between your accounts',
  excluded: 'Excluded from your books',
};

/** What Undo review does, by outcome. */
const UNDO_EFFECT: Record<BankTransactionDto['status'], string> = {
  unreviewed: '',
  categorized: 'Undo review takes this out of your books and puts the transaction back in For review.',
  transfer: 'Undo review takes the transfer out of your books and puts the transaction back in For review (and the other side, if it was linked).',
  matched: 'Undo review puts the transaction back in For review. What it was matched to, such as a customer payment, stays recorded.',
  excluded: 'Undo review puts the transaction back in For review.',
};

/**
 * A reviewed bank line, opened from its row: what it was recorded as, and the
 * actions that change it. Undo review (back to For review, reversing its entry)
 * and Delete live here rather than on the row, one deliberate step away.
 */
export function TransactionDialog({ txn, onClose }: { txn: BankTransactionDto | null; onClose: () => void }) {
  const undo = useUndoReview();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const [reason, setReason] = React.useState('');
  const idemRef = React.useRef(idempotencyKey());
  // Rendered beside the dialog, not inside it: its form must not nest in this one.
  const del = useDeleteRecordAction('bank_transaction', txn?.id ?? '', { onDeleted: onClose });
  React.useEffect(() => {
    if (txn) {
      setReason('');
      idemRef.current = idempotencyKey();
    }
  }, [txn]);
  const submit = () => {
    if (!txn) return;
    undo.mutate(
      { id: txn.id, input: { version: txn.version, reason: reason.trim() || undefined, idempotencyKey: idemRef.current } },
      {
        onSuccess: () => {
          toast.success('Review undone', 'The transaction is back in For review.');
          onClose();
        },
        onError: (e) => onError(e, 'Could not undo review'),
      },
    );
  };
  const extra = txn ? [txn.payee && `Payee: ${txn.payee}`, txn.memo && `Memo: ${txn.memo}`, txn.reference && `Ref: ${txn.reference}`].filter(Boolean) : [];
  return (
    <>
      {del.dialog}
      <Dialog
        open={Boolean(txn)}
        onClose={onClose}
        title={txn?.description ?? 'Transaction'}
        description={txn ? `${formatDate(txn.date)} · ${txn.bankAccountName ?? ''} · ${formatMoney(txn.amount, txn.currency)}` : undefined}
        onSubmit={submit}
        footer={
          txn && (
            <>
              {del.item && (
                <Button variant="ghost" className="mr-auto" onClick={del.item.onSelect}>
                  <Trash2 className="size-4" aria-hidden /> Delete…
                </Button>
              )}
              {/* Focus Close, not the reason field: opening a line to look must not raise a phone keyboard. */}
              <Button variant="secondary" onClick={onClose} data-autofocus>
                Close
              </Button>
              <Button type="submit" variant="danger" loading={undo.isPending}>
                Undo review
              </Button>
            </>
          )
        }
      >
        {txn && (
          <div className="space-y-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-stone-500">Outcome</dt>
              <dd>
                {OUTCOME[txn.status]}
                {txn.journalEntryId && (
                  <>
                    {' · '}
                    <Link href={`/journal/${txn.journalEntryId}`} className="font-medium text-brand-700 hover:underline">
                      Journal entry
                    </Link>
                  </>
                )}
              </dd>
              {txn.excludedReason && (
                <>
                  <dt className="text-stone-500">Reason</dt>
                  <dd>{txn.excludedReason}</dd>
                </>
              )}
              {txn.reviewedAt && (
                <>
                  <dt className="text-stone-500">Reviewed</dt>
                  <dd>{formatDateTime(txn.reviewedAt)}</dd>
                </>
              )}
              {extra.length > 0 && (
                <>
                  <dt className="text-stone-500">Bank details</dt>
                  <dd className="break-words">{extra.join(' · ')}</dd>
                </>
              )}
            </dl>
            <div className="border-t border-stone-200 pt-4">
              <p className="text-sm text-stone-600">
                {UNDO_EFFECT[txn.status]}
              </p>
              <Field label="Reason for undoing" htmlFor="undo-reason" className="mt-3">
                <Textarea id="undo-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
              </Field>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
