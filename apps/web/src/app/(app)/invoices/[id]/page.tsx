import { InvoiceDetailView } from './view';

export const metadata = { title: 'Invoice' };

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvoiceDetailView id={id} />;
}
