'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ImportCashEditor } from '@/components/import-cash-editor';
import { Copy, Pencil, Trash2, Undo2 } from 'lucide-react';
import { Button, LinkButton } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/input';
import { DateInput } from '@/components/ui/date-input';
import { BackLink } from '@/components/ui/list';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { CASH_TREATMENT_LABEL, journalSourceHref, journalSourceLabel, useDeleteDraftJournal, useJournalEntry, usePostJournal, useReverseJournal, useReviewImportedCash } from '@/lib/queries/journal';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { capitalize, formatDate, formatDateTime, formatMoney, todayIso } from '@/lib/format';
import { useCompany } from '@/components/company-context';
import { JournalForm } from '../journal-form';
import { useDeleteRecordAction } from '@/components/delete-record-dialog';
import { ActionMenu } from '@/components/ui/action-menu';

/** Entries deleted on their own; document entries are deleted with their document. */
const STANDALONE_SOURCES = new Set(['manual', 'opening_balance', 'adjustment', 'import', 'transfer', 'bank_categorization', 'reversal']);

export function JournalDetailView({ id }: { id: string }) {
  const { company, isAdmin, userId } = useCompany();
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const onError = useMutationErrorHandler();
  const q = useJournalEntry(id);
  const post = usePostJournal(id);
  const reverse = useReverseJournal(id);
  const del = useDeleteDraftJournal();
  const cashReview = useReviewImportedCash(id);
  const [cashReason, setCashReason] = React.useState('');
  const [editing, setEditing] = React.useState(false);
  const [reversing, setReversing] = React.useState(false);
  const deleteAction = useDeleteRecordAction('journal_entry', id, { redirectTo: '/journal' });
  const [reverseDate, setReverseDate] = React.useState(todayIso(company.timeZone));
  const [reason, setReason] = React.useState('');
  const postIdem = React.useRef(idempotencyKey());
  const reverseIdem = React.useRef(idempotencyKey());

  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  const e = q.data;
  const cur = e.currency;
  const sourceHref = journalSourceHref(e.sourceType, e.sourceId);
  const createdBy = e.createdBy === userId ? 'You' : /^(system|job)\b/.test(e.createdBy) ? 'Evenbooks' : 'A teammate';

  if (editing && e.status === 'draft') {
    return <JournalForm existing={e} />;
  }

  const deleteDraft = async () => {
    const ok = await confirm({
      title: 'Delete this draft entry?',
      description: 'The draft and its lines are removed. Nothing was posted, so no balances change.',
      confirmLabel: 'Delete draft',
      tone: 'danger',
    });
    if (!ok) return;
    del.mutate(e.id, {
      onSuccess: () => {
        toast.success('Draft deleted');
        router.push('/journal');
      },
      onError: (err) => onError(err, 'Could not delete draft'),
    });
  };

  const closeReverse = () => {
    setReversing(false);
    setReason('');
  };

  const submitReverse = () => {
    if (!reason.trim() || reverse.isPending) return;
    reverse.mutate(
      { date: reverseDate, reason: reason.trim(), idempotencyKey: reverseIdem.current },
      {
        onSuccess: (r) => {
          toast.success(`Posted reversal #${r.entryNumber}`);
          setReversing(false);
          router.push(`/journal/${r.id}`);
        },
        onError: (err) => onError(err, 'Reversal failed'),
      },
    );
  };

  return (
    <>
      <BackLink listPath="/journal" label="Journal entries" />
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {e.entryNumber ? `Entry #${e.entryNumber}` : 'Draft entry'}
            {e.status === 'draft' && <Badge tone="neutral">Draft</Badge>}
            {e.reversedByEntryId && <Badge tone="red">Reversed</Badge>}
            {e.reversesEntryId && <Badge tone="purple">Reversal</Badge>}
          </span>
        }
        description={e.memo}
        actions={
          <>
            {e.status === 'draft' && (
              <>
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  <Pencil className="size-4" aria-hidden /> Edit draft
                </Button>
                <Button
                  loading={post.isPending}
                  onClick={() =>
                    post.mutate(
                      { version: e.version, idempotencyKey: postIdem.current },
                      {
                        onSuccess: (p) => toast.success(`Posted entry #${p.entryNumber}`),
                        onError: (err) => onError(err, 'Posting failed'),
                      },
                    )
                  }
                >
                  Post entry
                </Button>
              </>
            )}
            {e.status !== 'draft' && e.sourceType === 'manual' && (
              <LinkButton href={`/journal/new?copyFrom=${e.id}`} variant="secondary">
                <Copy className="size-4" aria-hidden /> Duplicate
              </LinkButton>
            )}
            <ActionMenu
              groups={[
                [e.status === 'draft' && e.sourceType === 'manual' && { label: 'Duplicate', icon: Copy, href: `/journal/new?copyFrom=${e.id}` }],
                [
                  e.status === 'draft' && { label: 'Delete draft', icon: Trash2, tone: 'danger', description: 'Nothing has posted yet', onSelect: () => void deleteDraft() },
                  e.status === 'posted' && !e.reversedByEntryId && e.cashTreatment !== 'derived' && {
                    label: 'Reverse…',
                    icon: Undo2,
                    tone: 'danger',
                    description: 'Post an equal and opposite entry',
                    onSelect: () => setReversing(true),
                  },
                  e.status === 'posted' && STANDALONE_SOURCES.has(e.sourceType) && deleteAction.item,
                ],
              ]}
            />
          </>
        }
      />
      {deleteAction.dialog}
      {e.sourceType === 'import' && e.status === 'posted' && isAdmin && (
        <Card className="mb-4">
          <CardHeader title="Cash-basis review" description="Record cash-basis income and expenses from your previous system. This changes cash reports and any linked reversal; the accrual entry stays the same. Locked periods must be reopened first." />
          <CardBody className="space-y-3">
            <Field label="Reason for cash-basis review" htmlFor="cash-review-reason" required>
              <Textarea id="cash-review-reason" value={cashReason} onChange={event => setCashReason(event.target.value)} />
            </Field>
            <ImportCashEditor key={`${e.id}-${e.version}`} initial={e.cashComponents ?? []} pending={cashReview.isPending}
              onSave={components => {
                if (!cashReason.trim()) return toast.error('Enter a reason for the cash-basis review');
                cashReview.mutate({ version: e.version, components, reason: cashReason }, {
                  onSuccess: () => { toast.success('Cash-basis review saved'); setCashReason(''); },
                  onError: err => onError(err, 'Could not save cash-basis review'),
                });
              }} />
          </CardBody>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <Table aria-label="Journal lines">
            <THead>
              <TR>
                <TH>Account</TH>
                <TH className="hidden sm:table-cell">Memo</TH>
                <TH numeric>Debit</TH>
                <TH numeric>Credit</TH>
              </TR>
            </THead>
            <TBody>
              {e.lines.map((l) => (
                <TR key={l.id}>
                  <TD>
                    <span className="font-mono text-xs text-stone-500">{l.accountCode}</span> {l.accountName}
                  </TD>
                  <TD className="hidden text-stone-500 sm:table-cell">{l.memo}</TD>
                  <TD numeric>{Number(l.debit) > 0 ? formatMoney(l.debit, cur) : ''}</TD>
                  <TD numeric>{Number(l.credit) > 0 ? formatMoney(l.credit, cur) : ''}</TD>
                </TR>
              ))}
              <TR className="font-semibold">
                <TD colSpan={2}>Totals</TD>
                <TD numeric>{formatMoney(e.totalDebit, cur)}</TD>
                <TD numeric>{formatMoney(e.totalCredit, cur)}</TD>
              </TR>
            </TBody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="Details" />
          <CardBody>
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-stone-500">Date</dt>
              <dd>{formatDate(e.date)}</dd>
              <dt className="text-stone-500">Source</dt>
              <dd>
                {sourceHref ? (
                  <Link className="text-brand-700 underline" href={sourceHref} data-testid="journal-source-link">
                    {journalSourceLabel(e.sourceType)}
                  </Link>
                ) : (
                  journalSourceLabel(e.sourceType)
                )}
              </dd>
              <dt className="text-stone-500">On cash reports</dt>
              <dd>{CASH_TREATMENT_LABEL[e.cashTreatment] ?? capitalize(e.cashTreatment)}</dd>
              <dt className="text-stone-500">Created by</dt>
              <dd className="truncate">{createdBy}</dd>
              <dt className="text-stone-500">Created</dt>
              <dd>{formatDateTime(e.createdAt)}</dd>
              {e.postedAt && (
                <>
                  <dt className="text-stone-500">Saved</dt>
                  <dd>{formatDateTime(e.postedAt)}</dd>
                </>
              )}
              {e.reversesEntryId && (
                <>
                  <dt className="text-stone-500">Reverses</dt>
                  <dd>
                    <Link className="text-brand-700 underline" href={`/journal/${e.reversesEntryId}`}>
                      Original entry
                    </Link>
                  </dd>
                </>
              )}
              {e.reversedByEntryId && (
                <>
                  <dt className="text-stone-500">Reversed by</dt>
                  <dd>
                    <Link className="text-brand-700 underline" href={`/journal/${e.reversedByEntryId}`}>
                      Reversal entry
                    </Link>
                  </dd>
                </>
              )}
              <dt className="text-stone-500">Currency</dt>
              <dd>{company.baseCurrency}</dd>
            </dl>
          </CardBody>
        </Card>
      </div>
      <Dialog
        open={reversing}
        onClose={closeReverse}
        title={`Reverse entry #${e.entryNumber}`}
        description="A new entry with opposite lines is saved and linked to this one, cancelling it out. Nothing is deleted."
        onSubmit={submitReverse}
        dirty={!!reason.trim() && !reverse.isPending}
        footer={
          <>
            <Button variant="secondary" onClick={closeReverse}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={reverse.isPending} disabled={!reason.trim()}>
              Post reversal
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Reversal date" htmlFor="rdate" required hint="On or after the original date, and not in a locked period.">
            <DateInput id="rdate" value={reverseDate} min={e.date} onChange={setReverseDate} />
          </Field>
          <Field label="Reason" htmlFor="rreason" required>
            <Textarea id="rreason" data-autofocus value={reason} onChange={(ev) => setReason(ev.target.value)} />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
