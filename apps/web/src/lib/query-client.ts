import { QueryClient, defaultShouldDehydrateQuery, environmentManager } from '@tanstack/react-query';

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: (failureCount, error) => {
          const status = (error as { status?: number }).status;
          if (status && status >= 400 && status < 500) return false;
          return failureCount < 2;
        },
        refetchOnWindowFocus: true,
      },
      mutations: {
        // Financial mutations are never auto-retried; they carry idempotency keys instead.
        retry: false,
      },
      dehydrate: {
        shouldDehydrateQuery: (q) => defaultShouldDehydrateQuery(q) || q.state.status === 'pending',
        shouldRedactErrors: () => false,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

/**
 * Server: a fresh client per request so private data is never shared between
 * users or companies. Browser: one client for the session; company scoping is
 * enforced by query keys and cleared on company switch/logout.
 */
export function getQueryClient(): QueryClient {
  if (environmentManager.isServer()) return makeQueryClient();
  return (browserQueryClient ??= makeQueryClient());
}
