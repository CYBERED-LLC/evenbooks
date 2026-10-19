'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useConfirm } from '@/components/ui/dialog';

const DISCARD = {
  title: 'Discard unsaved changes?',
  description: 'You have changes on this page that have not been saved.',
  confirmLabel: 'Discard changes',
  cancelLabel: 'Keep editing',
  tone: 'danger' as const,
};

/**
 * Guards a form with unsaved input: warns on tab close or reload, and asks
 * before in-app links navigate away. `leave(fn)` wraps Cancel/Back buttons.
 * Pass `dirty = false` right before navigating after a successful save.
 */
export function useUnsavedChanges(dirty: boolean) {
  const confirm = useConfirm();
  const router = useRouter();
  const dirtyRef = React.useRef(dirty);
  dirtyRef.current = dirty;

  React.useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    // Next's <Link> navigates client-side, which beforeunload never sees; intercept the click.
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      void confirm(DISCARD).then((ok) => {
        if (ok) {
          dirtyRef.current = false;
          router.push(url.pathname + url.search + url.hash);
        }
      });
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, confirm, router]);

  const leave = React.useCallback(
    async (go: () => void) => {
      if (dirtyRef.current && !(await confirm(DISCARD))) return;
      dirtyRef.current = false;
      go();
    },
    [confirm],
  );

  /** Call after a successful save so the redirect that follows is not intercepted. */
  const markSaved = React.useCallback(() => {
    dirtyRef.current = false;
  }, []);

  return { leave, markSaved };
}
