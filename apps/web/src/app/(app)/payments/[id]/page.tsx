import { PaymentDetailView } from './view';

export const metadata = { title: 'Payment' };

export default async function PaymentDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ apply?: string }> }) {
  const { id } = await params;
  const { apply } = await searchParams;
  return <PaymentDetailView id={id} applyTo={apply} />;
}
