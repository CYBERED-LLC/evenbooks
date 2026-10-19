'use client';
import * as React from 'react';
import { ArrowRightLeft, X } from 'lucide-react';
import { LinkButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useCompany } from '@/components/company-context';

/**
 * First-run nudge for companies with empty books: bring history over from another
 * app. Disappears once anything is recorded; dismissal is per browser.
 */
export function ImportPrompt() {
  const { company, isAdmin } = useCompany();
  const storageKey = `eb-import-prompt-dismissed:${company.id}`;
  const [dismissed, setDismissed] = React.useState(true);
  React.useEffect(() => setDismissed(window.localStorage.getItem(storageKey) === '1'), [storageKey]);
  if (!isAdmin || company.hasPostedEntries || dismissed) return null;
  return (
    <Card className="mb-6 border-brand-200 bg-brand-50/60" data-testid="import-prompt">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <ArrowRightLeft className="size-6 shrink-0 text-brand-700" aria-hidden />
        <div className="flex-1">
          <h2 className="font-display font-semibold text-stone-900">Coming from Wave or another app?</h2>
          <p className="text-sm text-stone-600">Bring your past transactions over from Wave or another app, or start fresh by uploading bank statements.</p>
        </div>
        <div className="flex items-center gap-2">
          <LinkButton size="sm" href="/settings/import">
            Import data
          </LinkButton>
          <button
            type="button"
            aria-label="Dismiss"
            className="rounded-md p-2 text-stone-500 hover:bg-stone-100 hover:text-stone-700"
            onClick={() => {
              window.localStorage.setItem(storageKey, '1');
              setDismissed(true);
            }}
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </div>
    </Card>
  );
}
