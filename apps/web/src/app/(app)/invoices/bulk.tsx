'use client';
import * as React from 'react';
import { Download, FileCheck2, Mail, X } from 'lucide-react';
import type { BulkInvoiceItemResult, BulkInvoiceResultDto, InvoiceDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { downloadText, toCsv, type CsvColumn } from '@/components/export-csv-button';
import { useBulkInvoices } from '@/lib/queries/invoices';
import { invoiceStatus } from '@/lib/status';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Columns shared by "Export CSV" (all matching rows) and "Export selected". */
export const INVOICE_CSV_COLUMNS: CsvColumn<InvoiceDto>[] = [
  { header: 'Number', value: (r) => r.number ?? 'Draft' },
  { header: 'Customer', value: (r) => r.contactName ?? r.customerSnapshot.name },
  { header: 'Issue date', value: (r) => r.issueDate },
  { header: 'Due date', value: (r) => r.dueDate },
  { header: 'Status', value: (r) => invoiceStatus(r).label },
  { header: 'Total', value: (r) => r.total },
  { header: 'Balance due', value: (r) => r.balanceDue },
  { header: 'Memo', value: (r) => r.memo },
];

const sendable = (i: InvoiceDto) => i.status === 'issued' || i.status === 'paid';

type Outcome = { result: BulkInvoiceResultDto; labels: Map<string, string> };

/**
 * Bulk bar for the invoice list: issue the selected drafts, email the selected
 * issued invoices, or export the selection. Each invoice gets its own
 * idempotency key, kept for a retry after a network error and dropped once a
 * request comes back, so a later "Send" really sends again.
 */
export function InvoiceBulkBar({ selected, onClear, onSettled }: { selected: InvoiceDto[]; onClear: () => void; onSettled: (succeeded: string[]) => void }) {
  const bulk = useBulkInvoices();
  const toast = useToast();
  const confirm = useConfirm();
  const onError = useMutationErrorHandler();
  const keys = React.useRef<Record<string, string>>({});
  const keyFor = (action: string, inv: InvoiceDto) => (keys.current[`${action}:${inv.id}:${inv.version}`] ??= idempotencyKey());
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);
  const [running, setRunning] = React.useState<'issue' | 'send' | null>(null);

  const drafts = selected.filter((i) => i.status === 'draft');
  const toSend = selected.filter(sendable);
  const noSnapshotEmail = toSend.filter((i) => !i.customerSnapshot.email).length;

  const report = (res: BulkInvoiceResultDto, list: InvoiceDto[]) => {
    const labels = new Map(list.map((i) => [i.id, `${i.number ?? 'Draft'} · ${i.contactName ?? i.customerSnapshot.name}`]));
    const verb = res.action === 'issue' ? 'Issued' : 'Queued';
    const noun = res.action === 'issue' ? 'invoice' : 'email';
    if (res.failed === 0 && res.skipped === 0) {
      toast.success(`${verb} ${plural(res.succeeded, noun)}`, res.action === 'send' ? 'They are sent in the background; each invoice shows its delivery status.' : undefined);
    } else {
      const parts = [res.succeeded > 0 && `${res.succeeded} done`, res.skipped > 0 && `${res.skipped} skipped`, res.failed > 0 && `${res.failed} failed`].filter(Boolean).join(', ');
      const details = { action: { label: 'Details', onClick: () => setOutcome({ result: res, labels }) } };
      if (res.succeeded > 0) toast.success(`${verb} ${plural(res.succeeded, noun)}`, parts, details);
      else toast.error(res.action === 'issue' ? 'No drafts were issued' : 'No emails were queued', parts, details);
      setOutcome({ result: res, labels });
    }
    onSettled(res.results.filter((r) => r.ok).map((r) => r.id));
  };

  const run = (action: 'issue' | 'send', list: InvoiceDto[]) => {
    setRunning(action);
    const items = list.map((i) => ({ id: i.id, version: i.version, idempotencyKey: keyFor(action, i) }));
    bulk.mutate(action === 'issue' ? { action: 'issue', items } : { action: 'send', items }, {
      onSuccess: (res) => {
        keys.current = {};
        report(res, list);
      },
      onError: (e) => onError(e, action === 'issue' ? 'Could not issue the selected drafts' : 'Could not send the selected invoices'),
      onSettled: () => setRunning(null),
    });
  };

  const issue = async () => {
    const ok = await confirm({
      title: `Issue ${plural(drafts.length, 'draft')}?`,
      description: 'Each draft gets the next invoice number and counts as money your customer owes you. To change one afterwards, void it or give a credit note.',
      confirmLabel: `Issue ${drafts.length}`,
    });
    if (ok) run('issue', drafts);
  };

  const send = async () => {
    const ok = await confirm({
      title: `Email ${plural(toSend.length, 'invoice')}?`,
      description: (
        <>
          Each invoice is emailed to its customer with the PDF and a payment link.
          {noSnapshotEmail > 0 && ` ${plural(noSnapshotEmail, 'invoice')} ha${noSnapshotEmail === 1 ? 's' : 've'} no email on the invoice; the customer's current email is used if there is one, otherwise it is skipped.`}
        </>
      ),
      confirmLabel: `Send ${toSend.length}`,
    });
    if (ok) run('send', toSend);
  };

  const exportSelected = () => {
    downloadText('invoices-selected.csv', toCsv(INVOICE_CSV_COLUMNS, selected));
    toast.success(`Exported ${plural(selected.length, 'row')}`);
  };

  return (
    <>
      {selected.length > 0 && (
        <div role="region" aria-label="Bulk actions" className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm shadow-sm">
          <span className="font-medium text-stone-800">{selected.length} selected</span>
          <Button
            size="sm"
            loading={running === 'send'}
            disabled={toSend.length === 0 || (bulk.isPending && running !== 'send')}
            title={toSend.length === 0 ? 'Select issued invoices to email them' : undefined}
            onClick={() => void send()}
          >
            {running !== 'send' && <Mail className="size-4" aria-hidden />} Send {toSend.length}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            loading={running === 'issue'}
            disabled={drafts.length === 0 || (bulk.isPending && running !== 'issue')}
            title={drafts.length === 0 ? 'Select drafts to issue them' : undefined}
            onClick={() => void issue()}
          >
            {running !== 'issue' && <FileCheck2 className="size-4" aria-hidden />} Issue {plural(drafts.length, 'draft')}
          </Button>
          <Button size="sm" variant="secondary" onClick={exportSelected}>
            <Download className="size-4" aria-hidden /> Export selected
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear} className="ml-auto">
            <X className="size-4" aria-hidden /> Clear selection
          </Button>
        </div>
      )}
      <BulkResultDialog outcome={outcome} onClose={() => setOutcome(null)} />
    </>
  );
}

function outcomeBadge(r: BulkInvoiceItemResult, action: 'issue' | 'send') {
  if (r.ok) return <Badge tone="green">{action === 'issue' ? `Issued ${r.number ?? ''}`.trim() : 'Queued'}</Badge>;
  if (r.skipped) return <Badge tone="amber">Skipped</Badge>;
  return <Badge tone="red">Failed</Badge>;
}

/** Per-invoice outcome of a bulk action that did not fully succeed. */
function BulkResultDialog({ outcome, onClose }: { outcome: Outcome | null; onClose: () => void }) {
  const res = outcome?.result;
  return (
    <Dialog
      open={!!outcome}
      onClose={onClose}
      size="lg"
      title={res?.action === 'issue' ? 'Issue results' : 'Send results'}
      description={res ? [`${res.succeeded} done`, res.skipped > 0 && `${res.skipped} skipped`, res.failed > 0 && `${res.failed} failed`].filter(Boolean).join(' · ') : undefined}
      footer={
        <Button onClick={onClose} data-autofocus>
          Close
        </Button>
      }
    >
      {res && (
        <Table aria-label="Bulk results">
          <THead>
            <TR>
              <TH>Invoice</TH>
              <TH className="w-32">Outcome</TH>
              <TH>Details</TH>
            </TR>
          </THead>
          <TBody>
            {res.results.map((r) => (
              <TR key={r.id} data-testid="bulk-result-row">
                <TD className="font-medium">{outcome.labels.get(r.id) ?? r.number ?? r.id}</TD>
                <TD>{outcomeBadge(r, res.action)}</TD>
                <TD className="text-stone-600">{r.error?.message ?? (r.email ? `To ${r.email.toEmail}` : '')}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Dialog>
  );
}
