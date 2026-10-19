'use client';
import * as React from 'react';

/** Below Tailwind's `sm` breakpoint (40rem), the same range as the `max-sm:` variant. */
export const PHONE_QUERY = '(width < 40rem)';

/** Live `matchMedia` result. False on the server and during hydration, so markup matches. */
export function useMediaQuery(query: string): boolean {
  return React.useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const useIsPhone = () => useMediaQuery(PHONE_QUERY);
