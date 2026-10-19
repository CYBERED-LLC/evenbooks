'use client';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/ui/toast';
import { ApiClientError } from '@/lib/api-client';

/**
 * Consistent error surfacing for mutations. The toast title says what failed (`fallback`,
 * e.g. "Could not void invoice"); the server's plain sentence explains why. A request id is
 * shown only for unexpected failures, where support needs it.
 */
export function useMutationErrorHandler() {
  const toast = useToast();
  const router = useRouter();
  return (err: unknown, fallback?: string) => {
    if (err instanceof ApiClientError) {
      if (err.code === 'company_mismatch') {
        toast.error('The active company changed', 'Reload the page to continue.');
        return;
      }
      const unexpected = err.status >= 500 && err.code !== 'external_error';
      const reference = unexpected && err.requestId ? ` If it keeps happening, contact support and mention reference ${err.requestId.slice(0, 8)}.` : '';
      const why = `${err.message}${reference}`;
      const action = err.code === 'period_locked' ? { label: 'Accounting periods', onClick: () => router.push('/settings/periods') } : undefined;
      if (fallback) toast.error(fallback, why, { action });
      else toast.error(why, undefined, { action });
      return;
    }
    toast.error(fallback ?? 'That didn’t work', err instanceof Error ? err.message : undefined);
  };
}
