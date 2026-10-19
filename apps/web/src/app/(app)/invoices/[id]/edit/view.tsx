'use client';
import { LinkButton } from '@/components/ui/button';
import { EmptyState, ErrorNotice, Spinner } from '@/components/ui/card';
import { useInvoice } from '@/lib/queries/invoices';
import { InvoiceForm } from '../../invoice-form';

export function EditInvoiceView({ id }: { id: string }) {
  const q = useInvoice(id);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  if (q.data.status !== 'draft') {
    return (
      <EmptyState
        title="Only drafts can be edited"
        description={`Invoice ${q.data.number ?? ''} is ${q.data.status}. Issued invoices are corrected with credit notes or by voiding.`}
        action={<LinkButton href={`/invoices/${id}`}>Back to invoice</LinkButton>}
      />
    );
  }
  return <InvoiceForm key={q.data.version} invoice={q.data} />;
}
