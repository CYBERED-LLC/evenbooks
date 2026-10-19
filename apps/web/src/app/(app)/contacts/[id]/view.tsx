'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ContactDto, InvoiceDto, PaymentDto, PurchaseDto } from '@evenbooks/contracts';
import { Archive, ArchiveRestore, Banknote, Pencil, Plus } from 'lucide-react';
import { Button, LinkButton } from '@/components/ui/button';
import { ActionMenu } from '@/components/ui/action-menu';
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { BackLink, Pager } from '@/components/ui/list';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useContact, useContactActivity, useContactBalance, useUpdateContact, type ContactActivityKind } from '@/lib/queries/contacts';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { useCompany } from '@/components/company-context';
import { formatDate, formatMoney, isZeroDecimal } from '@/lib/format';
import { InvoiceStatusBadge } from '@/components/status-badges';
import { negateDecimal, sumDecimals } from '@/lib/decimal';
import { cn } from '@/lib/utils';
import { ContactDialog } from '../contact-dialog';
import { methodLabel } from '@/app/(app)/payments/view';

export function ContactDetailView({ id }: { id: string }) {
  const q = useContact(id);
  const update = useUpdateContact();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const [editing, setEditing] = React.useState(false);

  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data;

  const setArchived = (target: ContactDto, isArchived: boolean, undo = false) =>
    update.mutate(
      { id: target.id, input: { version: target.version, isArchived } },
      {
        onSuccess: (saved) => {
          if (undo) return void toast.info(isArchived ? 'Archived again' : 'Archive undone');
          if (isArchived) toast.success('Contact archived', 'It is hidden from pickers and lists.', { action: { label: 'Undo', onClick: () => setArchived(saved, false, true) } });
          else toast.success('Contact restored');
        },
        onError: (e) => onError(e, isArchived ? 'Could not archive contact' : 'Could not restore contact'),
      },
    );

  const addr = c.billingAddress;
  const addressLines = [
    addr.line1,
    addr.line2,
    [addr.city, addr.region].filter(Boolean).join(', ') + (addr.postalCode ? ` ${addr.postalCode}` : ''),
    addr.country,
  ]
    .map((l) => l?.trim())
    .filter((l): l is string => Boolean(l));

  return (
    <>
      <BackLink listPath="/contacts" label="Customers & vendors" />
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {c.name}
            {c.isCustomer && <Badge tone="blue">Customer</Badge>}
            {c.isVendor && <Badge tone="purple">Vendor</Badge>}
            {c.isArchived && <Badge tone="neutral">Archived</Badge>}
          </span>
        }
        description={c.email ?? undefined}
        actions={
          <>
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Pencil className="size-4" aria-hidden /> Edit
            </Button>
            {c.isArchived && (
              <Button loading={update.isPending} onClick={() => setArchived(c, false)}>
                <ArchiveRestore className="size-4" aria-hidden /> Restore
              </Button>
            )}
            {c.isCustomer && !c.isArchived && (
              <LinkButton href={`/invoices/new?contactId=${c.id}`} title={`Start an invoice for ${c.name}`}>
                <Plus className="size-4" aria-hidden /> New invoice
              </LinkButton>
            )}
            <ActionMenu
              groups={[
                [c.isCustomer && !c.isArchived && { label: 'Record payment', icon: Banknote, href: `/payments/new?contactId=${c.id}` }],
                [!c.isArchived && { label: 'Archive', icon: Archive, description: 'Hide from pickers and lists; you can restore it', disabled: update.isPending, onSelect: () => setArchived(c, true) }],
              ]}
            />
          </>
        }
      />
      {c.isCustomer && <BalanceSummary contactId={c.id} />}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Details" />
          <CardBody>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Detail label="Email">
                {c.email ? (
                  <a href={`mailto:${c.email}`} className="text-brand-700 hover:underline">
                    {c.email}
                  </a>
                ) : (
                  '—'
                )}
              </Detail>
              <Detail label="Phone">{c.phone ?? '—'}</Detail>
              <Detail label="Billing address">
                {addressLines.length > 0 ? (
                  <address className="not-italic">
                    {addressLines.map((l, i) => (
                      <span key={i} className="block">
                        {l}
                      </span>
                    ))}
                  </address>
                ) : (
                  '—'
                )}
              </Detail>
              <Detail label="Added">{formatDate(c.createdAt)}</Detail>
            </dl>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Notes" />
          <CardBody>{c.notes ? <p className="whitespace-pre-wrap text-sm text-stone-800">{c.notes}</p> : <p className="text-sm text-stone-500">No notes.</p>}</CardBody>
        </Card>
      </div>
      <Activity contact={c} />
      <ContactDialog open={editing} onClose={() => setEditing(false)} contact={editing ? c : null} />
    </>
  );
}

function BalanceSummary({ contactId }: { contactId: string }) {
  const { company } = useCompany();
  const q = useContactBalance(contactId);
  const cur = company.baseCurrency;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  const b = q.data;
  const overdue = b?.openInvoices.filter((i) => i.isOverdue) ?? [];
  const unapplied = b ? sumDecimals(b.unappliedPayments.map((p) => p.unappliedAmount)) : '0.00';
  return (
    <Card className="mb-4" data-testid="contact-balance" aria-busy={q.isPending || undefined}>
      <div className="grid gap-px overflow-hidden rounded-lg bg-stone-200 sm:grid-cols-4">
        <Figure label="Owed to you" value={b ? formatMoney(b.totalReceivable, cur) : '…'} hint={b ? `${b.openInvoices.length} open ${b.openInvoices.length === 1 ? 'invoice' : 'invoices'}` : undefined} />
        <Figure
          label="Overdue"
          value={b ? formatMoney(sumDecimals(overdue.map((i) => i.balanceDue)), cur) : '…'}
          hint={b ? (overdue.length ? `${overdue.length} past due` : 'nothing past due') : undefined}
          tone={overdue.length ? 'red' : undefined}
          href={overdue.length ? `/invoices?contactId=${contactId}&overdue=1` : undefined}
        />
        <Figure label="Credit from payments" value={b ? formatMoney(unapplied, cur) : '…'} hint={b && !isZeroDecimal(unapplied) ? 'paid but not on an invoice yet' : undefined} />
        <Figure label="Credit notes" value={b ? formatMoney(b.totalCredits, cur) : '…'} hint={b?.openCreditNotes.length ? `${b.openCreditNotes.length} with credit left` : undefined} />
      </div>
    </Card>
  );
}

function Figure({ label, value, hint, tone, href }: { label: string; value: string; hint?: string; tone?: 'red'; href?: string }) {
  const body = (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{label}</p>
      <p className={cn('tabular mt-0.5 text-xl font-semibold', tone === 'red' ? 'text-red-700' : 'text-stone-900')}>{value}</p>
      {hint && <p className="text-xs text-stone-500">{hint}</p>}
    </>
  );
  return href ? (
    <Link href={href} className="block bg-white px-4 py-3 hover:bg-stone-50">
      {body}
    </Link>
  ) : (
    <div className="bg-white px-4 py-3">{body}</div>
  );
}

const TAB_LABEL: Record<ContactActivityKind, string> = { invoices: 'Invoices', payments: 'Payments', purchases: 'Expenses' };
const PAGE_SIZE = 25;

function Activity({ contact }: { contact: ContactDto }) {
  const tabs: ContactActivityKind[] = [...(contact.isCustomer ? (['invoices', 'payments'] as const) : []), ...(contact.isVendor ? (['purchases'] as const) : [])];
  const [tab, setTab] = React.useState<ContactActivityKind>(tabs[0] ?? 'invoices');
  const baseId = React.useId();
  const current = tabs.includes(tab) ? tab : (tabs[0] ?? 'invoices');

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = tabs.indexOf(current);
    const next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : undefined;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    document.getElementById(`${baseId}-tab-${next}`)?.focus();
  };

  return (
    <Card className="mt-4">
      <div role="tablist" aria-label="Activity" className="flex flex-wrap gap-1 border-b border-stone-200 px-3 py-2" onKeyDown={onKeyDown}>
        {tabs.map((t) => (
          <button
            key={t}
            id={`${baseId}-tab-${t}`}
            type="button"
            role="tab"
            aria-selected={t === current}
            aria-controls={`${baseId}-panel`}
            tabIndex={t === current ? 0 : -1}
            onClick={() => setTab(t)}
            className={cn('min-h-10 rounded-md px-3 py-1.5 text-sm font-medium transition-colors sm:min-h-0', t === current ? 'bg-brand-600 text-white' : 'text-stone-700 hover:bg-stone-100')}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-tab-${current}`}>
        <ActivityTable key={current} kind={current} contactId={contact.id} />
      </div>
    </Card>
  );
}

function ActivityTable({ kind, contactId }: { kind: ContactActivityKind; contactId: string }) {
  const [stack, setStack] = React.useState<string[]>([]);
  const cursor = stack.at(-1);
  const q = useContactActivity(kind, contactId, { cursor, limit: PAGE_SIZE });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  const page = q.data;
  if (page.items.length === 0) return <EmptyState title={`No ${TAB_LABEL[kind].toLowerCase()} yet`} description={`${TAB_LABEL[kind]} for this contact will show up here.`} />;
  const pager = (
    <Pager
      count={page.items.length}
      pageIndex={stack.length}
      pageSize={PAGE_SIZE}
      hasPrev={stack.length > 0}
      hasNext={!!page.nextCursor}
      onPrev={() => setStack((s) => s.slice(0, -1))}
      onNext={() => page.nextCursor && setStack((s) => [...s, page.nextCursor!])}
      noun={TAB_LABEL[kind].toLowerCase()}
    />
  );

  if (kind === 'invoices') {
    const items = (page.items as InvoiceDto[]);
    return (
      <div className={cn(q.isPlaceholderData && 'opacity-60')}>
        <Table aria-label="Contact invoices">
          <THead>
            <TR>
              <TH>Number</TH>
              <TH>Issued</TH>
              <TH className="hidden sm:table-cell">Due</TH>
              <TH>Status</TH>
              <TH numeric>Total</TH>
              <TH numeric>Balance due</TH>
            </TR>
          </THead>
          <TBody>
            {items.map((i) => (
              <TR key={i.id} href={`/invoices/${i.id}`}>
                <TD>
                  <Link href={`/invoices/${i.id}`} className="font-medium text-brand-700 hover:underline">
                    {i.number ?? 'Draft'}
                  </Link>
                </TD>
                <TD>{formatDate(i.issueDate)}</TD>
                <TD className="hidden sm:table-cell">{formatDate(i.dueDate)}</TD>
                <TD>
                  <InvoiceStatusBadge invoice={i} />
                </TD>
                <TD numeric>{formatMoney(i.total)}</TD>
                <TD numeric>{formatMoney(i.balanceDue)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {pager}
      </div>
    );
  }
  if (kind === 'payments') {
    const items = (page.items as PaymentDto[]);
    return (
      <div className={cn(q.isPlaceholderData && 'opacity-60')}>
        <Table aria-label="Contact payments">
          <THead>
            <TR>
              <TH>Date</TH>
              <TH>Method</TH>
              <TH className="hidden sm:table-cell">Reference</TH>
              <TH>
                <span className="sr-only">Status</span>
              </TH>
              <TH numeric>Amount</TH>
              <TH numeric>Credit to use</TH>
            </TR>
          </THead>
          <TBody>
            {items.map((p) => (
              <TR key={p.id} href={`/payments/${p.id}`}>
                <TD>
                  <Link href={`/payments/${p.id}`} className="font-medium text-brand-700 hover:underline">
                    {formatDate(p.date)}
                  </Link>
                </TD>
                <TD>{methodLabel(p.method)}</TD>
                <TD className="hidden sm:table-cell">{p.reference ?? '—'}</TD>
                <TD>{p.status === 'void' && <Badge tone="neutral">Void</Badge>}</TD>
                <TD numeric>{formatMoney(p.amount, p.currency)}</TD>
                <TD numeric>{isZeroDecimal(p.unappliedAmount) ? '—' : formatMoney(p.unappliedAmount, p.currency)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {pager}
      </div>
    );
  }
  const items = (page.items as PurchaseDto[]);
  return (
    <div className={cn(q.isPlaceholderData && 'opacity-60')}>
      <Table aria-label="Contact purchases">
        <THead>
          <TR>
            <TH>Date</TH>
            <TH>Reference</TH>
            <TH className="hidden sm:table-cell">Paid from</TH>
            <TH>
              <span className="sr-only">Status</span>
            </TH>
            <TH numeric>Total</TH>
          </TR>
        </THead>
        <TBody>
          {items.map((p) => (
            <TR key={p.id} href={`/purchases/${p.id}`}>
              <TD>
                <Link href={`/purchases/${p.id}`} className="font-medium text-brand-700 hover:underline">
                  {formatDate(p.date)}
                </Link>
              </TD>
              <TD>{p.reference || p.memo || '—'}</TD>
              <TD className="hidden sm:table-cell">{p.paidFromAccountName ?? '—'}</TD>
              <TD>{p.status === 'void' && <Badge tone="neutral">Void</Badge>}</TD>
              <TD numeric>{formatMoney(p.direction === 'inflow' ? negateDecimal(p.total) : p.total, p.currency)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
      {pager}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</dt>
      <dd className="mt-1 text-sm text-stone-800">{children}</dd>
    </div>
  );
}
