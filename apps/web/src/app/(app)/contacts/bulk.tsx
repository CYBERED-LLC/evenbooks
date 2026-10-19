'use client';
import * as React from 'react';
import { Archive, ArchiveRestore, X } from 'lucide-react';
import type { BulkContactsInput, BulkContactsResultDto, ContactDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { useBulkContacts } from '@/lib/queries/contacts';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';

const plural = (n: number) => `${n} ${n === 1 ? 'contact' : 'contacts'}`;

/**
 * Archive (or restore) the selected contacts in one request. Archiving is
 * reversible metadata, so there is no confirmation: the toast offers Undo,
 * which restores exactly the contacts that were archived, at their new versions.
 */
export function ContactBulkBar({ selected, onClear, onSettled }: { selected: ContactDto[]; onClear: () => void; onSettled: (succeeded: string[]) => void }) {
  const bulk = useBulkContacts();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const [running, setRunning] = React.useState<BulkContactsInput['action'] | null>(null);
  const active = selected.filter((c) => !c.isArchived);
  const archived = selected.filter((c) => c.isArchived);

  const run = (action: BulkContactsInput['action'], list: { id: string; version: number }[], opts: { undo?: boolean } = {}) => {
    setRunning(action);
    bulk.mutate(
      { action, items: list.map((c) => ({ id: c.id, version: c.version })) },
      {
        onSuccess: (res: BulkContactsResultDto) => {
          const done = res.results.filter((r) => r.ok && r.contact).map((r) => r.contact!);
          const verb = action === 'archive' ? 'Archived' : 'Restored';
          if (done.length > 0) {
            const reverse = action === 'archive' ? 'unarchive' : 'archive';
            toast.success(
              `${verb} ${plural(done.length)}`,
              undefined,
              opts.undo ? undefined : { action: { label: 'Undo', onClick: () => run(reverse, done, { undo: true }) } },
            );
          }
          if (res.failed > 0) {
            const first = res.results.find((r) => !r.ok);
            toast.error(`${plural(res.failed)} could not be ${verb.toLowerCase()}`, first?.error?.message);
          }
          if (!opts.undo) onSettled(done.map((c) => c.id));
        },
        onError: (e) => onError(e, action === 'archive' ? 'Could not archive the selected contacts' : 'Could not restore the selected contacts'),
        onSettled: () => setRunning(null),
      },
    );
  };

  if (selected.length === 0) return null;
  return (
    <div role="region" aria-label="Bulk actions" className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm shadow-sm">
      <span className="font-medium text-stone-800">{selected.length} selected</span>
      <Button
        size="sm"
        variant="secondary"
        loading={running === 'archive'}
        disabled={active.length === 0 || (bulk.isPending && running !== 'archive')}
        title={active.length === 0 ? 'The selected contacts are already archived' : undefined}
        onClick={() => run('archive', active)}
      >
        {running !== 'archive' && <Archive className="size-4" aria-hidden />} Archive {active.length}
      </Button>
      {archived.length > 0 && (
        <Button size="sm" variant="secondary" loading={running === 'unarchive'} disabled={bulk.isPending && running !== 'unarchive'} onClick={() => run('unarchive', archived)}>
          {running !== 'unarchive' && <ArchiveRestore className="size-4" aria-hidden />} Restore {archived.length}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={onClear} className="ml-auto">
        <X className="size-4" aria-hidden /> Clear selection
      </Button>
    </div>
  );
}
