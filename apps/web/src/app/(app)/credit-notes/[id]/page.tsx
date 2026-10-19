import { CreditNoteDetailView } from './view';

export const metadata = { title: 'Credit note' };

export default async function CreditNoteDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ apply?: string }> }) {
  const { id } = await params;
  const { apply } = await searchParams;
  return <CreditNoteDetailView id={id} applyTo={apply} />;
}
