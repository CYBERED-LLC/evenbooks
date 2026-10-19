'use client';
import * as React from 'react';
import { ExternalLink, FileCheck2, FileText, Mail, RefreshCw } from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { EmailMessageDto, InvoiceDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeTone, Card, CardHeader, ErrorNotice, Spinner } from '@/components/ui/card';
import type { PdfVersionDto } from '@/lib/queries/invoices';
import { capitalize, formatDate, formatDateTime, formatMoney, isZeroDecimal } from '@/lib/format';
import { daysBetween } from '@/lib/status';
import { useToday } from '@/components/company-context';
import { cn } from '@/lib/utils';

const EMAIL_STATUS: Record<EmailMessageDto['status'], { label: string; tone: BadgeTone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  sending: { label: 'Sending', tone: 'blue' },
  sent: { label: 'Sent', tone: 'blue' },
  delivered: { label: 'Delivered', tone: 'green' },
  bounced: { label: 'Bounced', tone: 'red' },
  complained: { label: 'Marked as spam', tone: 'red' },
  failed: { label: 'Failed', tone: 'red' },
  uncertain: { label: 'Unconfirmed', tone: 'amber' },
  suppressed: { label: 'Suppressed', tone: 'neutral' },
};

export function EmailStatusBadge({ status }: { status: EmailMessageDto['status'] }) {
  const { label, tone } = EMAIL_STATUS[status];
  return (
    <span data-testid="email-status" data-status={status}>
      <Badge tone={tone}>{label}</Badge>
    </span>
  );
}

const PDF_REASON: Record<string, string> = {
  on_demand: 'Generated for download',
  email_snapshot: 'Attached to an email',
  manual: 'Regenerated',
  design_updated: 'Re-rendered with current branding',
};

const relativeDays = (n: number) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 0 ? `in ${n} days` : `${-n} days ago`);

/**
 * The one line that answers "what is owed, and by when". Overdue is said here
 * (and by the badge) rather than in a separate banner.
 */
export function BalanceSummary({ invoice: inv }: { invoice: InvoiceDto }) {
  const today = useToday();
  const cur = inv.currency;
  if (inv.status === 'draft') return <> · due {formatDate(inv.dueDate)}</>;
  if (inv.status === 'paid') return <> · {formatMoney(inv.total, cur)} paid in full</>;
  const days = daysBetween(today, inv.dueDate);
  const partly = !isZeroDecimal(inv.amountSettled);
  return (
    <>
      {' · '}
      <span data-testid="balance-summary" className={cn('font-semibold', inv.isOverdue ? 'text-red-700' : 'text-stone-900')}>
        {formatMoney(inv.balanceDue, cur)} {inv.isOverdue ? 'overdue' : 'due'}
      </span>
      {partly && <> of {formatMoney(inv.total, cur)}</>}
      {' · '}
      {inv.isOverdue ? `was due ${formatDate(inv.dueDate)} (${relativeDays(Math.min(days, -1))})` : `due ${formatDate(inv.dueDate)} (${relativeDays(days)})`}
    </>
  );
}

type ActivityEvent =
  | { kind: 'issued'; at: string }
  | { kind: 'email'; at: string; email: EmailMessageDto }
  | { kind: 'pdf'; at: string; pdf: PdfVersionDto };

const COLLAPSED = 5;

/**
 * Issue, emails and PDF versions in one newest-first timeline, so an invoice
 * that has not been sent yet shows one line instead of two empty cards.
 */
export function InvoiceActivity({
  invoice: inv,
  emails,
  pdfVersions,
  onResend,
  resendingTo,
  newVersionMenu,
}: {
  invoice: InvoiceDto;
  emails: UseQueryResult<EmailMessageDto[]>;
  pdfVersions: UseQueryResult<PdfVersionDto[]>;
  onResend?: (m: EmailMessageDto) => void;
  resendingTo?: string;
  newVersionMenu: React.ReactNode;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const events: ActivityEvent[] = [
    ...(inv.issuedAt ? [{ kind: 'issued' as const, at: inv.issuedAt }] : []),
    ...(emails.data ?? []).map((email) => ({ kind: 'email' as const, at: email.queuedAt, email })),
    ...(pdfVersions.data ?? []).map((pdf) => ({ kind: 'pdf' as const, at: pdf.createdAt, pdf })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const shown = expanded ? events : events.slice(0, COLLAPSED);
  const notSent = emails.data?.length === 0;

  return (
    <Card>
      <CardHeader title="Activity" description={notSent ? 'Not emailed to the customer yet.' : undefined} actions={newVersionMenu} />
      {(emails.isPending || pdfVersions.isPending) && <Spinner />}
      {emails.isError && <ErrorNotice error={emails.error} onRetry={() => emails.refetch()} />}
      {pdfVersions.isError && <ErrorNotice error={pdfVersions.error} onRetry={() => pdfVersions.refetch()} />}
      {!emails.isPending && !pdfVersions.isPending && (
        <ol className="divide-y divide-stone-100 text-sm" aria-label="Activity">
          {shown.map((e) => (
            <li key={e.kind === 'email' ? e.email.id : e.kind === 'pdf' ? e.pdf.attachmentId : 'issued'} className="flex gap-3 px-4 py-2.5" data-kind={e.kind}>
              {e.kind === 'issued' && <IssuedRow invoice={inv} at={e.at} />}
              {e.kind === 'email' && <EmailRow email={e.email} onResend={onResend} resending={resendingTo === e.email.toEmail} />}
              {e.kind === 'pdf' && <PdfRow pdf={e.pdf} current={e.pdf.attachmentId === inv.currentPdfAttachmentId} />}
            </li>
          ))}
        </ol>
      )}
      {events.length > COLLAPSED && (
        <div className="border-t border-stone-100 px-4 py-2">
          <Button variant="link" size="sm" onClick={() => setExpanded((x) => !x)} aria-expanded={expanded}>
            {expanded ? 'Show less' : `Show all ${events.length}`}
          </Button>
        </div>
      )}
    </Card>
  );
}

function EventIcon({ icon: Icon, tone = 'stone' }: { icon: typeof Mail; tone?: 'stone' | 'brand' }) {
  return (
    <span className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full', tone === 'brand' ? 'bg-brand-50 text-brand-700' : 'bg-stone-100 text-stone-500')} aria-hidden>
      <Icon className="size-3.5" />
    </span>
  );
}

function When({ at }: { at: string }) {
  return <time dateTime={at} className="text-xs text-stone-500">{formatDateTime(at)}</time>;
}

function IssuedRow({ invoice: inv, at }: { invoice: InvoiceDto; at: string }) {
  return (
    <>
      <EventIcon icon={FileCheck2} tone="brand" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-stone-900">Issued {inv.number}</p>
        <When at={at} />
      </div>
    </>
  );
}

function EmailRow({ email: m, onResend, resending }: { email: EmailMessageDto; onResend?: (m: EmailMessageDto) => void; resending: boolean }) {
  const steps = [m.sentAt && `sent ${formatDateTime(m.sentAt)}`, m.deliveredAt && `delivered ${formatDateTime(m.deliveredAt)}`, m.attempts > 1 && `${m.attempts} attempts`].filter(Boolean);
  return (
    <>
      <EventIcon icon={Mail} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-stone-900">
            {m.isResend ? 'Resent' : 'Emailed'} to {m.toEmail}
          </span>
          <EmailStatusBadge status={m.status} />
        </p>
        <p className="truncate text-xs text-stone-600" title={m.subject}>
          {m.subject}
        </p>
        <p className="text-xs text-stone-500">
          <When at={m.queuedAt} />
          {steps.length > 0 && ` · ${steps.join(' · ')}`}
          {m.fromEmail && ` · from ${m.fromEmail}${m.replyTo ? `, replies to ${m.replyTo}` : ''}`}
        </p>
        {m.lastError && (
          <p className="text-xs text-red-700" role="alert">
            {m.lastError}
          </p>
        )}
      </div>
      {onResend && (
        <Button variant="ghost" size="sm" className="shrink-0 self-start" onClick={() => onResend(m)} loading={resending} aria-label={`Resend to ${m.toEmail}`}>
          <RefreshCw className="size-4" /> Resend
        </Button>
      )}
    </>
  );
}

function PdfRow({ pdf: v, current }: { pdf: PdfVersionDto; current: boolean }) {
  return (
    <>
      <EventIcon icon={FileText} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2">
          <a href={`/api/attachments/${v.attachmentId}/download`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">
            PDF version {v.version}
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
          {current && <Badge tone="green">Current</Badge>}
        </p>
        <p className="text-xs text-stone-500">
          {PDF_REASON[v.reason] ?? capitalize(v.reason)} · <When at={v.createdAt} /> ·{' '}
          <span className="font-mono" title={`SHA-256 ${v.sha256}`}>
            {v.sha256.slice(0, 12)}
          </span>
        </p>
      </div>
    </>
  );
}
