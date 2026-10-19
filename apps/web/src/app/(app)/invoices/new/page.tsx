import { NewInvoiceView } from './view';

export const metadata = { title: 'New invoice' };

export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<{ copyFrom?: string; contactId?: string }> }) {
  const { copyFrom, contactId } = await searchParams;
  return <NewInvoiceView copyFrom={copyFrom} contactId={contactId} />;
}
