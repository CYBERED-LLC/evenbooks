import { NewScheduleView } from './view';

export const metadata = { title: 'New recurring schedule' };

export default async function NewSchedulePage({ searchParams }: { searchParams: Promise<{ invoiceId?: string }> }) {
  const { invoiceId } = await searchParams;
  return <NewScheduleView invoiceId={invoiceId} />;
}
