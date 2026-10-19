'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import type { DeletableType, DeletionBlocker } from '@evenbooks/contracts';
import { useCompany } from '@/components/company-context';
import type { ActionMenuItem } from '@/components/ui/action-menu';
import { Button } from '@/components/ui/button';
import { ErrorNotice, Spinner } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { idempotencyKey } from '@/lib/api-client';
import { formatDate, formatMoney } from '@/lib/format';
import { useDeleteRecord, useDeletionPreview } from '@/lib/queries/deletions';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';

const NOUN: Record<DeletableType, string> = {
  invoice: 'invoice',
  credit_note: 'credit note',
  payment: 'payment',
  refund: 'refund',
  purchase: 'purchase',
  journal_entry: 'journal entry',
  bank_transaction: 'bank transaction',
};

function recordHref(r: NonNullable<DeletionBlocker['record']>): string | null {
  switch (r.type) {
    case 'invoice': return `/invoices/${r.id}`;
    case 'credit_note': return `/credit-notes/${r.id}`;
    case 'payment': return `/payments/${r.id}`;
    case 'purchase': return `/purchases/${r.id}`;
    case 'journal_entry': return `/journal/${r.id}`;
    default: return null;
  }
}

/** Admins see Delete only while the company allows permanent deletion. */
export function useCanDeleteRecords(): boolean {
  const { isAdmin, company } = useCompany();
  return isAdmin && company.transactionDeletionEnabled;
}

/** "Delete…" button plus the confirmation dialog; renders nothing for members or when deletion is off. */
export function DeleteRecordButton({
  type,
  id,
  redirectTo,
  onDeleted,
  size,
  variant = 'danger',
  label = 'Delete…',
  ariaLabel,
}: {
  type: DeletableType;
  id: string;
  /** Page to show after the delete (the record's page no longer exists). */
  redirectTo?: string;
  onDeleted?: () => void;
  size?: 'sm' | 'md';
  variant?: 'danger' | 'ghost';
  label?: string;
  ariaLabel?: string;
}) {
  const allowed = useCanDeleteRecords();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  if (!allowed) return null;
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)} title={`Delete this ${NOUN[type]} permanently`} aria-label={ariaLabel}>
        <Trash2 className="size-4" /> {label}
      </Button>
      {open && (
        <DeleteRecordDialog
          type={type}
          id={id}
          onClose={() => setOpen(false)}
          onDeleted={() => {
            onDeleted?.();
            if (redirectTo) router.push(redirectTo);
          }}
        />
      )}
    </>
  );
}

/**
 * Menu-item form of DeleteRecordButton for page action menus: `item` is null
 * when the user may not delete; render `dialog` somewhere on the page.
 */
export function useDeleteRecordAction(
  type: DeletableType,
  id: string,
  { redirectTo, onDeleted, label = 'Delete…' }: { redirectTo?: string; onDeleted?: () => void; label?: string } = {},
): { item: ActionMenuItem | null; dialog: React.ReactNode } {
  const allowed = useCanDeleteRecords();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  if (!allowed) return { item: null, dialog: null };
  return {
    item: { label, icon: Trash2, tone: 'danger', description: 'Removes it and its ledger entries for good', onSelect: () => setOpen(true) },
    dialog: open ? (
      <DeleteRecordDialog
        type={type}
        id={id}
        onClose={() => setOpen(false)}
        onDeleted={() => {
          onDeleted?.();
          if (redirectTo) router.push(redirectTo);
        }}
      />
    ) : null,
  };
}

/**
 * Confirmation for a permanent delete. Loads the server preview so the user
 * sees every entry that disappears, what blocks the delete, and which
 * reconciliations reopen, before typing a reason.
 */
export function DeleteRecordDialog({ type, id, onClose, onDeleted }: { type: DeletableType; id: string; onClose: () => void; onDeleted?: () => void }) {
  const preview = useDeletionPreview(type, id, true);
  const remove = useDeleteRecord();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const { company } = useCompany();
  const cur = company.baseCurrency;
  const [reason, setReason] = React.useState('');
  const idem = React.useRef(idempotencyKey());
  const p = preview.data;
  const noun = NOUN[type];

  const submit = () => {
    if (!p || !p.canDelete || !reason.trim() || remove.isPending) return;
    remove.mutate(
      { type, id, version: p.version, reason: reason.trim(), idempotencyKey: idem.current },
      {
        onSuccess: () => {
          toast.success(`${p.label} deleted`);
          onClose();
          onDeleted?.();
        },
        onError: (e) => {
          idem.current = idempotencyKey();
          void preview.refetch();
          onError(e, `Could not delete ${noun}`);
        },
      },
    );
  };

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      onSubmit={submit}
      dirty={!!reason.trim() && !remove.isPending}
      title={`Delete ${noun} permanently`}
      description="The record and its journal entries are removed as if they never existed. This cannot be undone; the audit log keeps a copy of what was deleted."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={remove.isPending} disabled={!p?.canDelete || !reason.trim()}>
            Delete permanently
          </Button>
        </>
      }
    >
      {preview.isPending && <Spinner label="Checking what this affects" />}
      {preview.isError && <ErrorNotice error={preview.error} onRetry={() => preview.refetch()} />}
      {p && (
        <div className="space-y-4 text-sm" data-testid="delete-preview">
          <p className="font-medium text-stone-900">{p.label}</p>

          {p.blockers.length > 0 && (
            <div role="alert" className="space-y-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800" data-testid="delete-blockers">
              <p className="font-medium">This {noun} cannot be deleted yet:</p>
              <ul className="list-disc space-y-1 pl-5">
                {p.blockers.map((b, i) => {
                  const href = b.record ? recordHref(b.record) : null;
                  return (
                    <li key={i}>
                      {b.message}
                      {b.record && href && (
                        <>
                          {' '}
                          <Link href={href} className="font-medium underline">
                            Open {b.record.label}
                          </Link>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {p.lockedDates.length > 0 && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800">
              The accounting period containing {p.lockedDates.map(formatDate).join(', ')} is closed. Reopen it in Settings → Periods to delete this {noun}.
            </div>
          )}

          {p.reconciliations.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900" data-testid="delete-reconciliations">
              <p className="font-medium">Reconciliations will be reopened</p>
              <p className="mt-1">
                Lines from this {noun} were cleared in a finished reconciliation. They are removed from it and the reconciliation goes back to in progress so you can finish it again:
              </p>
              <ul className="mt-1 list-disc pl-5">
                {p.reconciliations.map((r) => (
                  <li key={r.id}>
                    <Link href={`/banking/reconcile/${r.id}`} className="underline">
                      {r.bankAccountName}, statement ending {formatDate(r.statementEndDate)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {p.customerFacing && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
              This invoice was shared with the customer. Its link stops working and its email history is removed.
            </div>
          )}

          {p.bankTransactions.length > 0 && (
            <div>
              <p className="font-medium text-stone-900">Bank lines that go back to the inbox</p>
              <ul className="mt-1 space-y-0.5 text-stone-600">
                {p.bankTransactions.map((t) => (
                  <li key={t.id}>
                    {formatDate(t.date)} · {t.description} · <span className="tabular">{formatMoney(t.amount, cur)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {p.affectedDocuments.length > 0 && (
            <p className="text-stone-600">
              Balances are recalculated on {p.affectedDocuments.map((d) => d.label).join(', ')}.
            </p>
          )}

          {p.entries.length > 0 ? (
            <div>
              <p className="font-medium text-stone-900">Journal entries removed</p>
              <ul className="mt-1 space-y-0.5 text-stone-600" data-testid="delete-entries">
                {p.entries.map((e) => (
                  <li key={e.id}>
                    {e.entryNumber ? `#${e.entryNumber}` : 'Draft'} · {formatDate(e.date)} · {e.memo || e.sourceType.replace(/_/g, ' ')} · <span className="tabular">{formatMoney(e.amount, cur)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-stone-600">Nothing has been posted to the ledger for this {noun}.</p>
          )}

          {type === 'bank_transaction' && <p className="text-stone-600">Future bank syncs and statement imports will skip this line.</p>}

          {p.canDelete && (
            <Field label="Reason" htmlFor="delete-reason" required hint="Recorded in the audit log.">
              <Textarea id="delete-reason" data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            </Field>
          )}
        </div>
      )}
    </Dialog>
  );
}
