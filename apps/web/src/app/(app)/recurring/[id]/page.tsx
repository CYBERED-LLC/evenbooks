import { ScheduleDetailView } from './view';

export const metadata = { title: 'Recurring schedule' };

export default async function ScheduleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ScheduleDetailView id={id} />;
}
