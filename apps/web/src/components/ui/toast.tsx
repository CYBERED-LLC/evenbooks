'use client';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface Toast {
  id: number;
  title: string;
  description?: string;
  tone: 'success' | 'error' | 'info';
  /** One button, such as "Undo" or "View". Toasts with an action stay up longer. */
  action?: ToastAction;
}

type ToastInput = Omit<Toast, 'id'>;
type Extra = { action?: ToastAction };

interface ToastContextValue {
  push(t: ToastInput): number;
  dismiss(id: number): void;
  success(title: string, description?: string, extra?: Extra): number;
  error(title: string, description?: string, extra?: Extra): number;
  info(title: string, description?: string, extra?: Extra): number;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

/** Errors stay long enough to read the reason; hovering keeps any toast up. */
function lifetime(t: ToastInput): number {
  if (t.tone === 'error') return 20_000;
  if (t.action) return 10_000;
  return 4000;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const idRef = React.useRef(0);
  const timers = React.useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = React.useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const schedule = React.useCallback((id: number, ms: number) => {
    const old = timers.current.get(id);
    if (old) clearTimeout(old);
    timers.current.set(id, setTimeout(() => dismiss(id), ms));
  }, [dismiss]);

  const [host, pickHost] = useModalHost();
  const push = React.useCallback(
    (t: ToastInput) => {
      pickHost(); // a dialog may have been removed without closing
      const id = ++idRef.current;
      setToasts((prev) => [...prev.slice(-4), { ...t, id }]);
      schedule(id, lifetime(t));
      return id;
    },
    [schedule, pickHost],
  );

  // A modal <dialog> makes everything outside it inert, so the stack is portaled into the
  // topmost open modal (or the body) and shown in the top layer, where it sits above that
  // dialog and stays clickable. Re-showing moves it above whatever entered the top layer since.
  const stackRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const el = stackRef.current;
    if (!el || !('showPopover' in el)) return;
    try {
      if (el.matches(':popover-open')) el.hidePopover();
      if (toasts.length) el.showPopover();
    } catch {
      // not supported; the fixed-position fallback still renders
    }
  }, [toasts, host]);

  const value = React.useMemo<ToastContextValue>(
    () => ({
      push,
      dismiss,
      success: (title, description, extra) => push({ title, description, tone: 'success', ...extra }),
      error: (title, description, extra) => push({ title, description, tone: 'error', ...extra }),
      info: (title, description, extra) => push({ title, description, tone: 'info', ...extra }),
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {host && createPortal(
      <div
        ref={stackRef}
        popover="manual"
        style={{ inset: 'auto 0 1rem 0', margin: 0, width: '100%', height: 'auto', border: 0, padding: 0, background: 'transparent', overflow: 'visible' }}
        className="pointer-events-none fixed z-50 flex flex-col items-center gap-2 px-4 print:hidden [&:not(:popover-open)]:hidden"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            // Hold (up to 15 s) while the pointer is over a toast so its action stays reachable.
            onMouseEnter={() => schedule(t.id, 15_000)}
            onMouseLeave={() => schedule(t.id, 3000)}
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-md border px-4 py-3 text-sm shadow-lg',
              t.tone === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-900',
              t.tone === 'error' && 'border-red-200 bg-red-50 text-red-900',
              t.tone === 'info' && 'border-sky-200 bg-sky-50 text-sky-900',
            )}
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t.title}</p>
              {t.description && <p className="mt-0.5 opacity-90">{t.description}</p>}
            </div>
            {t.action && (
              <button
                type="button"
                className="shrink-0 rounded px-1.5 py-0.5 font-semibold underline-offset-2 hover:underline"
                onClick={() => {
                  dismiss(t.id);
                  t.action!.onClick();
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" aria-label="Dismiss" className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100" onClick={() => dismiss(t.id)}>
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>,
        host,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

/** The topmost open modal <dialog>, else document.body; follows dialogs opening and closing. */
function useModalHost(): [HTMLElement | null, () => void] {
  const [host, setHost] = React.useState<HTMLElement | null>(null);
  const pick = React.useCallback(() => {
    const modals = Array.from(document.querySelectorAll('dialog[open]')).filter((d) => d.matches(':modal'));
    const next = (modals[modals.length - 1] as HTMLElement | undefined) ?? document.body;
    setHost((prev) => (prev === next ? prev : next));
  }, []);
  React.useEffect(() => {
    pick();
    const mo = new MutationObserver(pick);
    // childList too: a dialog can leave the DOM without closing (its owner unmounts).
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    return () => mo.disconnect();
  }, [pick]);
  return [host, pick];
}
