'use client';
import * as React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { getQueryClient } from '@/lib/query-client';
import { ToastProvider } from '@/components/ui/toast';
import { ConfirmProvider } from '@/components/ui/dialog';

export function RootProviders({ children }: { children: React.ReactNode }) {
  const queryClient = getQueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
      {process.env.NODE_ENV !== 'production' && <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />}
    </QueryClientProvider>
  );
}

/**
 * Scopes the query cache to one company. When the active company changes, the
 * previous company's queries are cancelled and removed so late responses can
 * never populate the new company's screens. On sign-out the whole cache clears.
 */
export function CompanyCacheScope({ companyId, userId, children }: { companyId: string; userId: string; children: React.ReactNode }) {
  const queryClient = getQueryClient();
  const prev = React.useRef<{ companyId: string; userId: string } | null>(null);

  React.useEffect(() => {
    const before = prev.current;
    if (before && before.userId !== userId) {
      queryClient.clear();
    } else if (before && before.companyId !== companyId) {
      const predicate = (q: { queryKey: readonly unknown[] }) => q.queryKey[0] === 'company' && q.queryKey[1] === before.companyId;
      void queryClient.cancelQueries({ predicate });
      queryClient.removeQueries({ predicate });
      queryClient.getMutationCache().clear();
    }
    prev.current = { companyId, userId };
  }, [companyId, userId, queryClient]);

  React.useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') return;
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  // Remount the subtree per company so component state (forms, filters) never carries over.
  return <React.Fragment key={companyId}>{children}</React.Fragment>;
}
