'use client';
import Link from 'next/link';
import { BookOpen, Landmark } from 'lucide-react';
import type { LedgerImportDto } from '@evenbooks/contracts';
import { LinkButton } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { useLedgerImports } from '@/lib/queries/ledger-imports';
import { formatDate, formatDateTime } from '@/lib/format';
import { WaveExportSteps } from './wave-steps';

export function ImportHubView() {
  return (
    <>
      <PageHeader title="Import data" description="Bring your past transactions over from Wave or another app, or start fresh with your bank statements." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="flex flex-col">
          <CardBody className="flex flex-1 flex-col gap-3">
            <div className="flex items-center gap-2">
              <BookOpen className="size-5 text-brand-700" aria-hidden />
              <h2 className="font-display font-semibold text-stone-900">Past transactions from Wave or another app</h2>
            </div>
            <p className="text-sm text-stone-600">
              Upload your transaction history. You match its accounts to your categories and see every transaction before anything is saved.
            </p>
            <div>
              <h3 className="text-sm font-medium text-stone-800">From Wave</h3>
              <WaveExportSteps className="mt-1" />
            </div>
            <p className="text-sm text-stone-600">
              <span className="font-medium text-stone-800">Other apps</span> (QuickBooks, Xero, FreshBooks, a spreadsheet): export the general ledger or journal as a CSV with a date, an account and an amount on every line.
            </p>
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="import-not-included">
              Your customer list and unpaid invoices don&rsquo;t come over yet. Add unpaid invoices afterwards.
            </p>
            <div className="mt-auto pt-2">
              <LinkButton href="/settings/import/ledger">Import accounting history</LinkButton>
            </div>
          </CardBody>
        </Card>
        <Card className="flex flex-col">
          <CardBody className="flex flex-1 flex-col gap-3">
            <div className="flex items-center gap-2">
              <Landmark className="size-5 text-brand-700" aria-hidden />
              <h2 className="font-display font-semibold text-stone-900">Bank or card statement</h2>
            </div>
            <p className="text-sm text-stone-600">
              Upload a statement CSV for one bank or credit card account. Its transactions appear in Bank transactions for you to sort; lines you already have are skipped.
            </p>
            <p className="text-sm text-stone-600">
              Prefer automatic updates? Connect your bank on{' '}
              <Link href="/banking" className="text-brand-700 hover:underline">
                Bank accounts
              </Link>
              .
            </p>
            <div className="mt-auto pt-2">
              <LinkButton variant="secondary" href="/banking/import">
                Import bank statement
              </LinkButton>
            </div>
          </CardBody>
        </Card>
      </div>
      <PastImports />
    </>
  );
}

const STATUS_LABEL: Record<LedgerImportDto['status'], string> = { previewed: 'Not imported yet', committed: 'Imported', discarded: 'Discarded' };

function statusTone(status: LedgerImportDto['status']) {
  return status === 'committed' ? 'green' : status === 'previewed' ? 'amber' : 'neutral';
}

function PastImports() {
  const q = useLedgerImports();
  const imports = (q.data ?? []).filter((i) => i.status !== 'discarded');
  return (
    <Card className="mt-6">
      <CardHeader title="Accounting history imports" />
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && imports.length === 0 && (
        <CardBody>
          <EmptyState title="No history imported yet" />
        </CardBody>
      )}
      {imports.length > 0 && (
        <ul className="divide-y divide-stone-100 text-sm" aria-label="Accounting history imports">
          {imports.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-stone-900">{i.fileName}</p>
                <p className="text-xs text-stone-500">
                  {formatDateTime(i.committedAt ?? i.createdAt)}
                  {i.windowStart && i.windowEnd && (
                    <>
                      {' '}
                      · {formatDate(i.windowStart)} – {formatDate(i.windowEnd)}
                    </>
                  )}{' '}
                  · {i.status === 'committed' ? `${i.importedCount} imported` : `${i.readyCount} ready`} · {i.duplicateCount} duplicates · {i.errorCount} with problems
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Badge tone={statusTone(i.status)}>{STATUS_LABEL[i.status]}</Badge>
                {i.status === 'previewed' ? (
                  <Link href={`/settings/import/ledger?id=${i.id}`} className="text-brand-700 hover:underline">
                    Continue
                  </Link>
                ) : (
                  <Link href="/journal?sourceType=import" className="text-brand-700 hover:underline">
                    View entries
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
