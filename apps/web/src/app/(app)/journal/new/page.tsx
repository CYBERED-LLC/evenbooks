import { NewJournalView } from './view';

export const metadata = { title: 'New journal entry' };

export default async function NewJournalPage({ searchParams }: { searchParams: Promise<{ copyFrom?: string; date?: string; accountId?: string }> }) {
  const { copyFrom, date, accountId } = await searchParams;
  return <NewJournalView copyFrom={copyFrom} date={date} accountId={accountId} />;
}
