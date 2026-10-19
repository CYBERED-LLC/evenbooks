'use client';
import * as React from 'react';
import Link from 'next/link';
import type { AuditEventDto } from '@evenbooks/contracts';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { FilterChips, Pager, type ActiveFilter } from '@/components/ui/list';
import { useAudit } from '@/lib/queries/audit';
import { useListParams } from '@/lib/use-list-params';
import { useCompany } from '@/components/company-context';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';

const PAGE_SIZE = 50;
const FILTER_KEYS = ['entityType', 'entityId', 'from', 'to'];

/** Entity types that services record, with a label and (when one exists) the page that shows the entity. */
const ENTITY_TYPES: { value: string; label: string; href?: (id: string) => string }[] = [
  { value: 'account', label: 'Account', href: (id) => `/reports/general-ledger?accountId=${id}` },
  { value: 'accounting_period', label: 'Locked period', href: () => '/settings/periods' },
  { value: 'attachment', label: 'Attachment' },
  { value: 'bank_account', label: 'Bank account', href: (id) => `/banking/inbox?bankAccountId=${id}` },
  { value: 'bank_connection', label: 'Bank connection', href: () => '/banking' },
  { value: 'bank_transaction', label: 'Bank transaction', href: () => '/banking/inbox' },
  { value: 'categorization_rule', label: 'Categorization rule', href: () => '/settings/rules' },
  { value: 'company', label: 'Company settings', href: () => '/settings/company' },
  { value: 'contact', label: 'Customer or vendor', href: (id) => `/contacts/${id}` },
  { value: 'credit_note', label: 'Credit note', href: (id) => `/credit-notes/${id}` },
  { value: 'email_suppression', label: 'Email suppression', href: () => '/settings/jobs' },
  { value: 'import_batch', label: 'Statement import', href: () => '/banking' },
  { value: 'invoice', label: 'Invoice', href: (id) => `/invoices/${id}` },
  { value: 'item', label: 'Product or service', href: () => '/settings/items' },
  { value: 'journal_entry', label: 'Journal entry', href: (id) => `/journal/${id}` },
  { value: 'ledger_import', label: 'History import', href: () => '/settings/import' },
  { value: 'payment', label: 'Payment received', href: (id) => `/payments/${id}` },
  { value: 'processor_charge', label: 'Online payment', href: () => '/settings/payments' },
  { value: 'processor_connection', label: 'Payment processor', href: () => '/settings/payments' },
  { value: 'processor_payout', label: 'Processor payout', href: () => '/settings/payments' },
  { value: 'purchase', label: 'Expense', href: (id) => `/purchases/${id}` },
  { value: 'reconciliation', label: 'Statement check', href: (id) => `/banking/reconcile/${id}` },
  { value: 'recurring_schedule', label: 'Recurring schedule', href: (id) => `/recurring/${id}` },
  { value: 'refund', label: 'Refund' },
  { value: 'tax_rate', label: 'Sales tax rate', href: () => '/settings/tax-rates' },
];
const TYPE_BY_VALUE = new Map(ENTITY_TYPES.map((t) => [t.value, t]));

const ACTION_TONE: [RegExp, 'red' | 'amber' | 'green' | 'blue' | 'neutral'][] = [
  [/\.(voided|void|deleted|archived|reversed|failed|flagged)$/, 'red'],
  [/\.(reopened|updated|changed|edited|unmatched)$/, 'amber'],
  [/\.(created|posted|issued|closed|completed|restored|paid|matched|imported|connected)$/, 'green'],
];
const actionTone = (a: string) => ACTION_TONE.find(([re]) => re.test(a))?.[1] ?? 'blue';

/** What each recorded action means, in plain words. Unlisted actions fall back to `actionLabel`'s wording. */
const ACTION_LABELS: Record<string, string> = {
  'account.created': 'Added account',
  'account.updated': 'Changed account',
  'account.archived': 'Archived account',
  'account.restored': 'Restored account',
  'attachment.uploaded': 'Attached a file',
  'attachment.deleted': 'Removed a file',
  'bank_account.created': 'Added bank account',
  'bank_account.updated': 'Changed bank account',
  'bank_connection.created': 'Connected a bank',
  'bank_connection.updated': 'Changed bank connection',
  'bank_connection.synced': 'Bank feed updated',
  'bank_connection.sync_failed': 'Bank feed update failed',
  'bank_connection.reconnected': 'Reconnected a bank',
  'bank_connection.disconnected': 'Disconnected a bank',
  'bank_connection.accounts_linked': 'Linked bank accounts',
  'bank_transaction.categorized': 'Categorized bank transaction',
  'bank_transaction.matched': 'Matched bank transaction',
  'bank_transaction.transfer': 'Recorded transfer',
  'bank_transaction.excluded': 'Excluded bank transaction',
  'bank_transaction.review_undone': 'Undid bank transaction review',
  'cash_recognition.rebuilt': 'Rebuilt cash-basis figures',
  'company.provisioned': 'Created company',
  'company.updated': 'Changed company settings',
  'company.plan_changed': 'Changed plan',
  'contact.created': 'Added customer or vendor',
  'contact.updated': 'Changed customer or vendor',
  'credit_note.draft_created': 'Started credit note',
  'credit_note.draft_deleted': 'Deleted draft credit note',
  'credit_note.issued': 'Issued credit note',
  'credit_note.applied': 'Applied credit note',
  'credit_note.voided': 'Voided credit note',
  'import.committed': 'Imported bank statement',
  'invoice.draft_created': 'Started invoice',
  'invoice.draft_updated': 'Edited draft invoice',
  'invoice.draft_deleted': 'Deleted draft invoice',
  'invoice.issued': 'Issued invoice',
  'invoice.voided': 'Voided invoice',
  'invoice.email_sent': 'Emailed invoice',
  'invoice.email_failed': 'Invoice email failed',
  'invoice.pdf_generated': 'Made invoice PDF',
  'invoice.payment_url_updated': 'Changed invoice payment link',
  'invoice.presentation_updated': 'Changed invoice design',
  'invoice.public_link_created': 'Shared invoice link',
  'invoice.public_link_rotated': 'Replaced invoice link',
  'invoice.public_link_revoked': 'Turned off invoice link',
  'item.created': 'Added product or service',
  'item.updated': 'Changed product or service',
  'journal.posted': 'Saved journal entry',
  'journal.reversed': 'Reversed journal entry',
  'journal.draft_created': 'Started journal entry',
  'journal.draft_updated': 'Edited draft journal entry',
  'journal.draft_deleted': 'Deleted draft journal entry',
  'journal.opening_balances': 'Entered starting balances',
  'journal.import_cash_reviewed': 'Reviewed imported cash figures',
  'ledger_import.committed': 'Imported history',
  'payment.created': 'Recorded payment received',
  'payment.allocated': 'Applied payment to invoices',
  'payment.allocation_reversed': 'Unapplied payment',
  'payment.voided': 'Voided payment',
  'period.closed': 'Locked period',
  'period.reopened': 'Reopened period',
  'purchase.created': 'Recorded expense',
  'purchase.voided': 'Voided expense',
  'reconciliation.started': 'Started statement check',
  'reconciliation.completed': 'Finished statement check',
  'reconciliation.reopened': 'Reopened statement check',
  'reconciliation.deleted': 'Deleted statement check',
  'recurring.created': 'Set up recurring invoice',
  'recurring.updated': 'Changed recurring invoice',
  'recurring.paused': 'Paused recurring invoice',
  'recurring.resumed': 'Resumed recurring invoice',
  'recurring.cancelled': 'Stopped recurring invoice',
  'recurring.issued': 'Recurring invoice issued',
  'refund.created': 'Recorded refund',
  'refund.voided': 'Voided refund',
  'rule.created': 'Added rule',
  'rule.updated': 'Changed rule',
  'rule.deleted': 'Deleted rule',
  'tax_rate.created': 'Added sales tax rate',
  'tax_rate.updated': 'Changed sales tax rate',
};

/** `invoice.email_sent` → "Invoice: email sent" when there is no plain label. */
export function actionLabel(action: string): string {
  const known = ACTION_LABELS[action];
  if (known) return known;
  const [entity, ...rest] = action.split('.');
  const words = (s: string) => s.replace(/_/g, ' ');
  const verb = words(rest.join(' '));
  const subject = words(entity ?? '');
  if (verb === 'deleted') return `Deleted ${TYPE_BY_VALUE.get(entity ?? '')?.label.toLowerCase() ?? subject}`;
  const label = verb ? `${subject}: ${verb}` : subject;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const DATE_VALUE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY_KEY = /(amount|total|balance|fee|net|gross)$/i;

/** One details value as text: dates and amounts formatted, lists joined, nested values summarized. */
function detailValue(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return MONEY_KEY.test(key) ? formatMoney(v) : String(v);
  if (typeof v === 'string') {
    if (DATE_VALUE.test(v)) return formatDate(v);
    if (MONEY_KEY.test(key) && /^-?\d+(\.\d+)?$/.test(v)) return formatMoney(v);
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x !== null ? '…' : detailValue(key, x))).join(', ');
  return '…';
}

/** "fromYear" → "From year", "line_code" → "Line code". */
const detailKey = (k: string) => {
  const s = k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function AuditView() {
  const { userId } = useCompany();
  const list = useListParams();
  const params = {
    limit: PAGE_SIZE,
    cursor: list.cursor,
    entityType: list.get('entityType'),
    entityId: list.get('entityId'),
    from: list.get('from'),
    to: list.get('to'),
  };
  const q = useAudit(params);

  const filters: ActiveFilter[] = [];
  if (params.entityType) filters.push({ key: 'entityType', label: `Type: ${TYPE_BY_VALUE.get(params.entityType)?.label ?? params.entityType}` });
  if (params.entityId) filters.push({ key: 'entityId', label: 'One record only' });
  if (params.from) filters.push({ key: 'from', label: `From ${formatDate(params.from)}` });
  if (params.to) filters.push({ key: 'to', label: `To ${formatDate(params.to)}` });

  return (
    <>
      <PageHeader title="History" description="Who changed what in your books, and when. Every save, void, lock and settings change is kept here and can’t be edited." />
      <Card className="mb-4">
        <div className="grid gap-3 p-3 sm:grid-cols-3">
          <Select aria-label="Record type" value={params.entityType ?? ''} onChange={(e) => list.setMany({ entityType: e.target.value || null, entityId: null })}>
            <option value="">All record types</option>
            {ENTITY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
            {params.entityType && !TYPE_BY_VALUE.has(params.entityType) && <option value={params.entityType}>{params.entityType}</option>}
          </Select>
          <Input type="date" aria-label="From date" value={params.from ?? ''} max={params.to} onChange={(e) => list.set('from', e.target.value || null)} />
          <Input type="date" aria-label="To date" value={params.to ?? ''} min={params.from} onChange={(e) => list.set('to', e.target.value || null)} />
        </div>
      </Card>
      <FilterChips filters={filters} onRemove={(k) => list.clear([k])} onClear={() => list.clear(FILTER_KEYS)} />
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.items.length === 0 && (
        <EmptyState
          title="Nothing here yet"
          description={filters.length ? 'Nothing matches these filters.' : undefined}
          action={
            filters.length ? (
              <Button variant="secondary" onClick={() => list.clear(FILTER_KEYS)}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      )}
      {q.data && q.data.items.length > 0 && (
        <Card className={q.isPlaceholderData ? 'opacity-60' : undefined} aria-busy={q.isPlaceholderData || undefined}>
          <Table aria-label="History" stickyHeader>
            <THead>
              <TR>
                <TH className="w-44">When</TH>
                <TH>What happened</TH>
                <TH className="hidden md:table-cell">Record</TH>
                <TH className="hidden lg:table-cell">By</TH>
                <TH className="hidden lg:table-cell">Reason and details</TH>
              </TR>
            </THead>
            <TBody>
              {q.data.items.map((a) => (
                <TR key={a.id}>
                  <TD className="whitespace-nowrap text-stone-600">{formatDateTime(a.createdAt)}</TD>
                  <TD>
                    <Badge tone={actionTone(a.action)}>{actionLabel(a.action)}</Badge>
                  </TD>
                  <TD className="hidden md:table-cell">
                    <EntityCell event={a} onFilter={() => list.setMany({ entityType: a.entityType, entityId: a.entityId })} />
                  </TD>
                  <TD className="hidden lg:table-cell">
                    <Actor event={a} userId={userId} />
                  </TD>
                  <TD className="hidden max-w-md text-stone-600 lg:table-cell">
                    <Details event={a} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pager
            count={q.data.items.length}
            pageIndex={list.pageIndex}
            pageSize={PAGE_SIZE}
            hasPrev={list.hasPrev}
            hasNext={!!q.data.nextCursor}
            onPrev={list.prev}
            onNext={() => q.data?.nextCursor && list.next(q.data.nextCursor)}
            noun="changes"
          />
        </Card>
      )}
    </>
  );
}

function EntityCell({ event, onFilter }: { event: AuditEventDto; onFilter: () => void }) {
  const type = TYPE_BY_VALUE.get(event.entityType);
  const label = type?.label ?? event.entityType;
  // Links that need the record id (ending in "/" or "=" without one) are dropped for id-less events.
  const candidate = type?.href?.(event.entityId ?? '');
  // A deleted record has no page left to open.
  const deleted = /\.(draft_)?deleted$/.test(event.action);
  const href = candidate && !deleted && !/[/=]$/.test(candidate) ? candidate : undefined;
  const deletedLabel = deleted && typeof event.details.label === 'string' ? event.details.label : null;
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      {href ? (
        <Link href={href} className="text-brand-700 hover:underline">
          {label}
        </Link>
      ) : (
        <span>{deletedLabel ?? label}</span>
      )}
      {event.entityId && (
        <button type="button" onClick={onFilter} className="text-xs text-stone-500 hover:text-stone-800 hover:underline">
          All changes to it
        </button>
      )}
    </span>
  );
}

/** The reason, then the recorded details as "Key: value" lines behind a Details toggle. */
function Details({ event }: { event: AuditEventDto }) {
  const entries = Object.entries(event.details ?? {}).filter(([, v]) => v !== undefined);
  if (!event.reason && entries.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {event.reason && <p className="text-stone-700">“{event.reason}”</p>}
      {entries.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-stone-500 hover:text-stone-800">Details</summary>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {entries.map(([k, v]) => (
              <React.Fragment key={k}>
                <dt className="text-stone-500">{detailKey(k)}</dt>
                <dd className="break-words text-stone-700">{detailValue(k, v)}</dd>
              </React.Fragment>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}

function Actor({ event, userId }: { event: AuditEventDto; userId: string }) {
  if (event.actorType === 'user' && event.actorId === userId) return <span className="font-medium text-stone-800">You</span>;
  if (event.actorType === 'system') return <span className="text-stone-600">Evenbooks</span>;
  if (event.actorType === 'job') return <span className="text-stone-600">Background job</span>;
  return <span className="text-stone-700">A teammate</span>;
}
