import { NewCreditNoteView } from './view';

export const metadata = { title: 'New credit note' };

export default async function NewCreditNotePage({ searchParams }: { searchParams: Promise<{ invoiceId?: string; contactId?: string }> }) {
  const { invoiceId, contactId } = await searchParams;
  return <NewCreditNoteView invoiceId={invoiceId} contactId={contactId} />;
}
