'use client';
import * as React from 'react';
import Link from 'next/link';
import { ChevronDown, MoreHorizontal, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buttonClass } from './button';
import { FloatingPanel } from './floating';
import { useIsPhone } from '@/lib/use-media-query';

/**
 * Hides a header button on phones. Pair it with a `phoneOnly` copy in the page's
 * ActionMenu so the action moves into the menu instead of wrapping the header.
 * Use it for actions that are rarely done on a phone (export, download, print).
 */
export const phoneHidden = 'max-sm:hidden';

export interface ActionMenuItem {
  label: string;
  icon?: LucideIcon;
  /** Navigate instead of running `onSelect`. */
  href?: string;
  onSelect?(): void;
  /** Small text under the label. On a disabled item, say why it is disabled. */
  description?: string;
  disabled?: boolean;
  /** Red text for irreversible actions (void, delete). Keep these in the last group. */
  tone?: 'danger';
  /** Only listed on phones, where the matching header button has `phoneHidden`. */
  phoneOnly?: boolean;
}

/** Falsy entries are skipped so callers can write `cond && { … }`. */
export type ActionMenuGroup = ReadonlyArray<ActionMenuItem | false | null | undefined>;

export interface ActionMenuProps {
  /** Groups render with a divider between them; empty groups disappear. */
  groups: ReadonlyArray<ActionMenuGroup>;
  /** Visible trigger text. Without it the trigger is an icon button. */
  label?: string;
  'aria-label'?: string;
  size?: 'sm' | 'md';
  align?: 'start' | 'end';
  className?: string;
}

/**
 * Overflow menu for secondary page actions (WAI-ARIA menu button). Keyboard:
 * Enter/Space/↓ opens on the first item, ↑ on the last; ↑/↓/Home/End move;
 * a letter jumps to the next item starting with it; Esc closes and returns
 * focus to the trigger. Renders nothing when every group is empty.
 */
export function ActionMenu({ groups, label, 'aria-label': ariaLabel, size = 'md', align = 'end', className }: ActionMenuProps) {
  const phone = useIsPhone();
  const visible = groups.map((g) => g.filter((i): i is ActionMenuItem => !!i && (!i.phoneOnly || phone))).filter((g) => g.length > 0);
  const flat = visible.flat();
  const id = React.useId();
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const itemRefs = React.useRef<Array<HTMLElement | null>>([]);
  const [open, setOpen] = React.useState(false);
  const [initial, setInitial] = React.useState<'first' | 'last' | null>(null);

  const focusAt = (i: number) => {
    const n = flat.length;
    if (n === 0) return;
    itemRefs.current[((i % n) + n) % n]?.focus();
  };
  const current = () => itemRefs.current.findIndex((el) => el === document.activeElement);

  // The panel stays `visibility: hidden` until FloatingPanel has measured it, and
  // hidden elements refuse focus, so retry for a few frames.
  React.useLayoutEffect(() => {
    if (!open || !initial) return;
    let raf = 0;
    let tries = 0;
    const attempt = () => {
      const el = itemRefs.current[initial === 'first' ? 0 : flat.length - 1];
      el?.focus();
      if (document.activeElement === el || ++tries > 10) setInitial(null);
      else raf = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(raf);
  }, [open, initial, flat.length]);

  if (flat.length === 0) return null;

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const openAt = (at: 'first' | 'last') => {
    setInitial(at);
    setOpen(true);
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openAt('first');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openAt('last');
    }
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    const i = current();
    if (e.key === 'ArrowDown') focusAt(i + 1);
    else if (e.key === 'ArrowUp') focusAt(i < 0 ? flat.length - 1 : i - 1);
    else if (e.key === 'Home') focusAt(0);
    else if (e.key === 'End') focusAt(flat.length - 1);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') return close(false);
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const ch = e.key.toLowerCase();
      for (let step = 1; step <= flat.length; step++) {
        const j = (i + step) % flat.length;
        if (flat[j]!.label.toLowerCase().startsWith(ch)) {
          focusAt(j);
          break;
        }
      }
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const select = (item: ActionMenuItem) => {
    if (item.disabled) return;
    // Focus the trigger before a dialog opens so the dialog hands focus back to it on close.
    close();
    item.onSelect?.();
  };

  let index = -1;
  const triggerLabel = ariaLabel ?? (label ? undefined : 'More actions');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        aria-label={triggerLabel}
        title={label ? undefined : triggerLabel}
        onClick={() => (open ? close() : openAt('first'))}
        onKeyDown={onTriggerKey}
        className={buttonClass('secondary', size, cn(!label && (size === 'sm' ? 'w-8 px-0!' : 'w-9 px-0!'), className))}
      >
        {label ? (
          <>
            {label} <ChevronDown className="size-4 text-stone-500" aria-hidden />
          </>
        ) : (
          <MoreHorizontal className="size-4" aria-hidden />
        )}
      </button>
      {open && (
        <FloatingPanel
          anchorRef={triggerRef}
          align={align}
          maxHeight={480}
          onDismiss={() => close(false)}
          id={`${id}-menu`}
          role="menu"
          aria-label={label ?? triggerLabel}
          onKeyDown={onMenuKey}
          className="min-w-56 max-w-80"
        >
          {visible.map((group, g) => (
            <div key={g} role="group" className={cn(g > 0 && 'mt-1 border-t border-stone-200 pt-1')}>
              {group.map((item) => {
                const i = ++index;
                const Icon = item.icon;
                const body = (
                  <>
                    {Icon ? <Icon className={cn('mt-0.5 size-4 shrink-0', item.tone === 'danger' ? 'text-red-600' : 'text-stone-500')} aria-hidden /> : <span className="size-4 shrink-0" aria-hidden />}
                    <span className="min-w-0">
                      <span className="block font-medium">{item.label}</span>
                      {item.description && <span className="block text-xs font-normal text-stone-500">{item.description}</span>}
                    </span>
                  </>
                );
                const cls = cn(
                  'flex w-full items-start gap-2.5 rounded px-2.5 py-2 text-left outline-none',
                  item.disabled ? 'cursor-not-allowed text-stone-400 focus:bg-stone-50' : item.tone === 'danger' ? 'text-red-700 hover:bg-red-50 focus:bg-red-50' : 'text-stone-800 hover:bg-stone-100 focus:bg-stone-100',
                );
                const common = {
                  role: 'menuitem',
                  tabIndex: -1,
                  'aria-disabled': item.disabled || undefined,
                  className: cls,
                  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => e.currentTarget.focus(),
                };
                return item.href && !item.disabled ? (
                  <Link
                    key={item.label}
                    href={item.href}
                    ref={(el) => {
                      itemRefs.current[i] = el;
                    }}
                    onClick={() => close(false)}
                    {...common}
                  >
                    {body}
                  </Link>
                ) : (
                  <button
                    key={item.label}
                    type="button"
                    ref={(el) => {
                      itemRefs.current[i] = el;
                    }}
                    onClick={() => select(item)}
                    {...common}
                  >
                    {body}
                  </button>
                );
              })}
            </div>
          ))}
        </FloatingPanel>
      )}
    </>
  );
}
