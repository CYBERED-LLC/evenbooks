'use client';
import { ErrorNotice, Spinner } from '@/components/ui/card';
import { useJournalEntry } from '@/lib/queries/journal';
import { JournalForm } from '../journal-form';

/**
 * New entry, optionally started from an existing one (`?copyFrom=<id>`, the Duplicate action)
 * or prefilled with a date and a first-line account (`?date=&accountId=`, from reconciliation).
 */
export function NewJournalView({ copyFrom, date, accountId }: { copyFrom?: string; date?: string; accountId?: string }) {
  const source = useJournalEntry(copyFrom ?? '');
  if (!copyFrom) return <JournalForm preset={{ date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined, accountId }} />;
  if (source.isPending) return <Spinner />;
  if (source.isError) return <ErrorNotice error={source.error} onRetry={() => source.refetch()} />;
  return <JournalForm key={source.data.id} copyOf={source.data} />;
}
