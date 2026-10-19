import { JournalDetailView } from './view';

export const metadata = { title: 'Journal entry' };

export default async function JournalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <JournalDetailView id={id} />;
}
