import type { CreditNoteDto, InvoiceDto } from '@evenbooks/contracts';
import { Badge } from '@/components/ui/card';
import { creditNoteStatus, invoiceStatus } from '@/lib/status';

export function InvoiceStatusBadge({ invoice }: { invoice: Pick<InvoiceDto, 'status' | 'isOverdue' | 'amountSettled'> }) {
  const { label, tone } = invoiceStatus(invoice);
  return <Badge tone={tone}>{label}</Badge>;
}

export function CreditNoteStatusBadge({ creditNote }: { creditNote: Pick<CreditNoteDto, 'status' | 'amountUsed'> }) {
  const { label, tone } = creditNoteStatus(creditNote);
  return <Badge tone={tone}>{label}</Badge>;
}
