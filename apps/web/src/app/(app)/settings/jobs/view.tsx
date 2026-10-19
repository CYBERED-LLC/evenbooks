'use client';
import * as React from 'react';
import Link from 'next/link';
import { Activity, AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useCompany } from '@/components/company-context';
import { useJobStatus, useRetryJob, type FailedJob } from '@/lib/queries/jobs';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { capitalize, formatDateTime } from '@/lib/format';

// The worker runs as a scheduled job every 5 minutes and writes a heartbeat on each run;
// allow two missed runs plus scheduling jitter before calling it down.
const HEARTBEAT_FRESH_MS = 15 * 60_000;
// Outbox rows wait for the next worker run; only flag ages beyond one full missed run.
const OUTBOX_BACKLOG_WARN_SECONDS = 15 * 60;
const EMAIL_TONE: Record<string, 'red' | 'amber' | 'neutral'> = { failed: 'red', bounced: 'red', complained: 'red', uncertain: 'amber', suppressed: 'neutral' };
const EMAIL_STATUS: Record<string, string> = { failed: 'Not sent', bounced: 'Bounced', complained: 'Marked as spam', uncertain: 'Not confirmed', suppressed: 'Blocked address' };

/** What a background task does, in words (the raw name stays visible under Technical details). */
export function jobLabel(name: string): string {
  if (name.startsWith('bank.')) return 'Bank sync';
  if (name.startsWith('email.') || name.includes('email')) return 'Sending an email';
  if (name.includes('pdf')) return 'Making an invoice PDF';
  if (name.startsWith('recurring.')) return 'Recurring invoice';
  if (name.startsWith('processor.')) return 'Online payment';
  if (name.startsWith('invoice.')) return 'Invoice';
  if (name.startsWith('outbox.')) return 'Handing work to the worker';
  return name;
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} d`;
}

function errorText(output: unknown): string {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output;
  if (typeof output === 'object') {
    const o = output as Record<string, unknown>;
    const msg = o.message ?? o.error ?? o.reason;
    if (typeof msg === 'string') return msg;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** The record a failed job was working on, from its payload, as a link target. */
export function jobSource(name: string, data: unknown): { href: string; label: string } | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const id = (k: string) => (typeof d[k] === 'string' && UUID_RE.test(d[k] as string) ? (d[k] as string) : null);
  if (id('scheduleId')) return { href: `/recurring/${id('scheduleId')}`, label: 'Open schedule' };
  if (id('invoiceId')) return { href: `/invoices/${id('invoiceId')}`, label: 'Open invoice' };
  if (id('connectionId')) return { href: '/banking', label: 'Open banking' };
  if (name.startsWith('bank.')) return { href: '/banking', label: 'Open banking' };
  return null;
}

export function JobsView() {
  const { isAdmin } = useCompany();
  const q = useJobStatus(isAdmin);
  // Re-evaluate heartbeat freshness on every poll, not just on data change.
  const now = Date.now();

  if (!isAdmin)
    return (
      <>
        <PageHeader title="Sync and email status" />
        <EmptyState title="Only admins can see this page" description="It shows bank syncs, emails and other work Evenbooks does in the background. Ask an admin of this company if something didn’t arrive." />
      </>
    );

  return (
    <>
      <PageHeader
        title="Sync and email status"
        description="Evenbooks syncs your banks, sends emails and makes invoice PDFs in the background every few minutes. Anything that failed is listed here. This page refreshes itself."
      />
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && (
        <div className="space-y-4" aria-busy={q.isFetching || undefined}>
          <HeartbeatCard at={q.data.workerHeartbeatAt} now={now} />

          <Card>
            <CardHeader
              title="Things that failed"
              description="The last 50 tasks that still failed after several tries. Fix the cause, then choose Retry: it runs within 5 minutes, and never sends an email twice or issues an invoice twice."
            />
            {q.data.failedJobs.length === 0 ? (
              <CardBody>
                <p className="text-sm text-stone-500">Nothing failed.</p>
              </CardBody>
            ) : (
              <Table aria-label="Failed tasks">
                <THead>
                  <TR>
                    <TH>Task</TH>
                    <TH className="hidden md:table-cell">Started</TH>
                    <TH numeric>Tries</TH>
                    <TH>Error</TH>
                    <TH className="w-40">
                      <span className="sr-only">Actions</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {q.data.failedJobs.map((j) => (
                    <TR key={j.id} data-testid="failed-job">
                      <TD>
                        <span className="font-medium">{jobLabel(j.name)}</span>
                        <p className="font-mono text-xs text-stone-500">{j.name}</p>
                        <p className="text-xs text-stone-500 md:hidden">{formatDateTime(j.createdOn)}</p>
                      </TD>
                      <TD className="hidden md:table-cell">{formatDateTime(j.createdOn)}</TD>
                      <TD numeric>{j.retryCount}</TD>
                      <TD>
                        <p className="break-words text-xs text-red-800">{errorText(j.output) || 'No reason given.'}</p>
                      </TD>
                      <TD>
                        <FailedJobActions job={j} isAdmin={isAdmin} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Banks not updating" description="Connections that haven’t synced for a while." />
              {q.data.staleConnections.length === 0 ? (
                <CardBody>
                  <p className="text-sm text-stone-500">Every bank connection is up to date.</p>
                </CardBody>
              ) : (
                <ul className="divide-y divide-stone-100" aria-label="Stale connections">
                  {q.data.staleConnections.map((c) => (
                    <li key={c.id} className="px-4 py-2 text-sm">
                      <Link href="/banking" className="font-medium text-brand-700 hover:underline">
                        {c.name}
                      </Link>
                      <p className="text-xs text-stone-500">Last updated: {c.lastSuccessAt ? formatDateTime(c.lastSuccessAt) : 'never'}</p>
                      {c.lastError && <p className="text-xs text-red-700">{c.lastError}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <CardHeader title="Online payment updates" description="Updates from Stripe that couldn’t be recorded yet. They are tried again automatically." />
              {q.data.processorEventProblems.length === 0 ? (
                <CardBody>
                  <p className="text-sm text-stone-500">No problems.</p>
                </CardBody>
              ) : (
                <ul className="divide-y divide-stone-100" aria-label="Payment provider event problems">
                  {q.data.processorEventProblems.map((e) => (
                    <li key={e.id} className="px-4 py-2 text-sm">
                      <span className="font-mono text-xs">{e.eventType}</span> <span className="text-xs text-stone-500">received {formatDateTime(e.receivedAt)} · {e.attempts} attempt{e.attempts === 1 ? '' : 's'}</span>
                      {e.lastError && <p className="text-xs text-red-700">{e.lastError}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <CardHeader title="Emails that didn’t arrive" description="Emails that bounced, were marked as spam, or couldn’t be sent." />
              {q.data.emailProblems.length === 0 ? (
                <CardBody>
                  <p className="text-sm text-stone-500">No delivery problems.</p>
                </CardBody>
              ) : (
                <ul className="divide-y divide-stone-100" aria-label="Email problems">
                  {q.data.emailProblems.map((m) => (
                    <li key={m.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-2 text-sm">
                      <div>
                        <Badge tone={EMAIL_TONE[m.status] ?? 'neutral'}>{EMAIL_STATUS[m.status] ?? capitalize(m.status)}</Badge> <span className="ml-1">{m.toEmail}</span>
                        <p className="text-xs text-stone-500">Queued {formatDateTime(m.queuedAt)}</p>
                        {m.lastError && <p className="text-xs text-red-700">{m.lastError}</p>}
                      </div>
                      {m.invoiceId && (
                        <Link href={`/invoices/${m.invoiceId}`} className="text-brand-700 hover:underline">
                          Open invoice
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
          <details className="group rounded-lg border border-stone-200 bg-white" data-testid="technical-details">
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-stone-700">Technical details</summary>
            <div className="space-y-4 border-t border-stone-200 p-4">
            <Card data-testid="outbox-card">
              <CardHeader title="Outbox" description="Work waiting for the worker’s next run (PDFs, emails, sync requests)." />
              <CardBody>
                <p className="text-3xl font-semibold tabular text-stone-900" data-testid="outbox-pending">
                  {q.data.outboxPending}
                </p>
                <p className="mt-1 text-sm text-stone-600">
                  pending · oldest {formatAge(q.data.outboxOldestAgeSeconds)}
                  {q.data.outboxOldestAgeSeconds !== null && q.data.outboxOldestAgeSeconds > OUTBOX_BACKLOG_WARN_SECONDS && <span className="ml-2 text-amber-700">Backlog is growing; check the worker.</span>}
                </p>
              </CardBody>
            </Card>
          <Card>
            <CardHeader title="Queues" />
            {q.data.queues.length === 0 ? (
              <CardBody>
                <EmptyState title="No jobs recorded" description="Queues appear once the worker has scheduled its first job." />
              </CardBody>
            ) : (
              <Table aria-label="Queues">
                <THead>
                  <TR>
                    <TH>Queue</TH>
                    <TH numeric>Created</TH>
                    <TH numeric>Active</TH>
                    <TH numeric>Retry</TH>
                    <TH numeric>Failed</TH>
                    <TH numeric className="hidden sm:table-cell">
                      Completed
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {q.data.queues.map((r) => (
                    <TR key={r.name}>
                      <TD className="font-mono text-xs">{r.name}</TD>
                      <TD numeric>{r.created}</TD>
                      <TD numeric>{r.active}</TD>
                      <TD numeric className={r.retry ? 'text-amber-700' : undefined}>
                        {r.retry}
                      </TD>
                      <TD numeric className={r.failed ? 'font-medium text-red-700' : undefined}>
                        {r.failed}
                      </TD>
                      <TD numeric className="hidden sm:table-cell">
                        {r.completed}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

            </div>
          </details>
        </div>
      )}
    </>
  );
}

function FailedJobActions({ job, isAdmin }: { job: FailedJob; isAdmin: boolean }) {
  const retry = useRetryJob();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const source = jobSource(job.name, job.data);
  const pending = retry.isPending && retry.variables === job.id;
  return (
    <div className="flex flex-col items-start gap-1">
      {isAdmin && job.retry && (
        <>
          <Badge tone={job.retry.dispatchedAt ? 'green' : 'amber'}>{job.retry.dispatchedAt ? 'Retrying now' : 'Retry waiting'}</Badge>
          <span className="text-xs text-stone-500">Requested {formatDateTime(job.retry.requestedAt)}</span>
        </>
      )}
      {isAdmin && !job.retry && job.retryable && (
        <Button
          size="sm"
          variant="secondary"
          loading={pending}
          aria-label={`Retry ${job.name} job`}
          onClick={() =>
            retry.mutate(job.id, {
              onSuccess: (r) =>
                r.status === 'queued' ? toast.success('Retry queued', 'The worker runs it on its next pass, within 5 minutes.') : toast.success('Retry already queued'),
              onError: (e) => onError(e, 'Could not retry the job'),
            })
          }
        >
          <RotateCcw className="size-4" aria-hidden />
          Retry
        </Button>
      )}
      {source && (
        <Link href={source.href} className="text-sm text-brand-700 hover:underline">
          {source.label}
        </Link>
      )}
    </div>
  );
}

function HeartbeatCard({ at, now }: { at: string | null; now: number }) {
  const fresh = at !== null && now - new Date(at).getTime() < HEARTBEAT_FRESH_MS;
  return (
    <Card data-testid="worker-heartbeat" data-state={fresh ? 'ok' : 'down'}>
      <CardHeader title="Background worker" description="Runs every 5 minutes to sync banks, send emails and make PDFs." />
      <CardBody>
        <div className={`flex items-center gap-2 text-lg font-semibold ${fresh ? 'text-emerald-700' : 'text-red-700'}`} role={fresh ? undefined : 'alert'}>
          {fresh ? <Activity className="size-5" aria-hidden /> : <AlertTriangle className="size-5" aria-hidden />}
          {fresh ? 'Worker running' : 'Worker not running'}
        </div>
        <p className="mt-1 text-sm text-stone-600">{at ? `Last ran ${formatDateTime(at)}` : 'It hasn’t run yet.'}</p>
      </CardBody>
    </Card>
  );
}
