import { EditInvoiceView } from './view';

export const metadata = { title: 'Edit invoice' };

export default async function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EditInvoiceView id={id} />;
}
