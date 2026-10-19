'use client';
import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'md' | 'lg' | 'xl';
  /**
   * Wraps the body and footer in a form: Enter in a field submits, and a footer
   * `<Button type="submit">` triggers this. Native validation is off; forms validate themselves.
   */
  onSubmit?: () => void;
  /** Unsaved input: closing (Esc, ×, backdrop Cancel) asks before discarding. */
  dirty?: boolean;
}

const FOCUSABLE_FIELD = 'input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])';

/**
 * Accessible modal built on the native <dialog> element. Focus starts on an
 * element marked `data-autofocus`, else the first field, else the close button.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md', onSubmit, dirty }: DialogProps) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const descId = React.useId();
  const confirm = useConfirm();

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      const target = el.querySelector<HTMLElement>('[data-autofocus]') ?? bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE_FIELD);
      target?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);

  const requestClose = async () => {
    if (dirty && !(await confirm({ title: 'Discard changes?', description: 'What you entered in this dialog has not been saved.', confirmLabel: 'Discard', tone: 'danger' }))) return;
    onClose();
  };

  const body = (
    <>
      <div ref={bodyRef} className="overflow-y-auto px-5 py-4">
        {children}
      </div>
      {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-stone-200 px-5 py-3">{footer}</div>}
    </>
  );

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        void requestClose();
      }}
      className={cn(
        'm-auto w-full rounded-lg border border-stone-200 bg-white p-0 shadow-xl backdrop:bg-stone-900/40',
        size === 'md' && 'max-w-lg',
        size === 'lg' && 'max-w-2xl',
        size === 'xl' && 'max-w-4xl',
      )}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-stone-200 px-5 py-4">
            <div>
              <h2 id={titleId} className="text-lg font-semibold text-stone-900">
                {title}
              </h2>
              {description && (
                <p id={descId} className="mt-1 text-sm text-stone-500">
                  {description}
                </p>
              )}
            </div>
            <button type="button" onClick={() => void requestClose()} aria-label="Close" className="rounded-md p-1 text-stone-500 hover:bg-stone-100">
              <X className="size-5" />
            </button>
          </div>
          {onSubmit ? (
            <form
              noValidate
              className="flex min-h-0 flex-col"
              onSubmit={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onSubmit();
              }}
            >
              {body}
            </form>
          ) : (
            body
          )}
        </div>
      )}
    </dialog>
  );
}

// ---------------------------------------------------------------------------
// Confirmation prompts
// ---------------------------------------------------------------------------
export interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` styles the confirm button red and starts focus on Cancel. */
  tone?: 'primary' | 'danger';
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = React.createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<{ opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  const confirm = React.useCallback<ConfirmFn>((opts) => new Promise<boolean>((resolve) => setState({ opts, resolve })), []);
  const settle = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const danger = state?.opts.tone === 'danger';
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={!!state}
        onClose={() => settle(false)}
        title={state?.opts.title ?? ''}
        footer={
          <>
            <Button variant="secondary" onClick={() => settle(false)} data-autofocus={danger ? true : undefined}>
              {state?.opts.cancelLabel ?? 'Cancel'}
            </Button>
            <Button variant={danger ? 'danger' : 'primary'} onClick={() => settle(true)} data-autofocus={danger ? undefined : true}>
              {state?.opts.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        {state?.opts.description ? <div className="text-sm text-stone-700">{state.opts.description}</div> : <span className="sr-only">{state?.opts.title}</span>}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/** Styled replacement for `window.confirm`. Falls back to the browser prompt outside ConfirmProvider. */
export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmContext);
  return React.useCallback<ConfirmFn>(
    (opts) => (ctx ? ctx(opts) : Promise.resolve(window.confirm(opts.title))),
    [ctx],
  );
}
