import { ReconcileDetailView } from './view';

export const metadata = { title: 'Reconcile statement' };

export default async function ReconcileDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReconcileDetailView id={id} />;
}
