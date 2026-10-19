import { PurchaseDetailView } from './view';

export const metadata = { title: 'Expense' };

export default async function PurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PurchaseDetailView id={id} />;
}
