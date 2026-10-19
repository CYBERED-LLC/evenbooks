'use client';
import * as React from 'react';
import { cn } from '@/lib/utils';

export interface FloatingPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Element the panel lines up under (or over, when there is no room below). */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Match the anchor's width (listboxes) instead of sizing to content (menus). */
  matchWidth?: boolean;
  align?: 'start' | 'end';
  maxHeight?: number;
  /** Called on a pointer press outside both the panel and the anchor. */
  onDismiss?(): void;
}

/**
 * A panel anchored to another element, rendered in the browser's top layer
 * (`popover="manual"`) so it shows above native modal `<dialog>`s and is never
 * clipped by a scrolling container. Mount it only while open.
 */
export const FloatingPanel = React.forwardRef<HTMLDivElement, FloatingPanelProps>(function FloatingPanel(
  { anchorRef, matchWidth, align = 'start', maxHeight = 320, onDismiss, className, style, children, ...props },
  forwarded,
) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = React.useState<React.CSSProperties>({ visibility: 'hidden' });

  const setRefs = (el: HTMLDivElement | null) => {
    ref.current = el;
    if (typeof forwarded === 'function') forwarded(el);
    else if (forwarded) forwarded.current = el;
  };

  const place = React.useCallback(() => {
    const anchor = anchorRef.current;
    const el = ref.current;
    if (!anchor || !el) return;
    const r = anchor.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const below = vh - r.bottom - 8;
    const above = r.top - 8;
    const up = below < Math.min(maxHeight, 200) && above > below;
    const height = Math.max(120, Math.min(maxHeight, up ? above : below));
    const width = matchWidth ? Math.max(r.width, 220) : undefined;
    const next: React.CSSProperties = { position: 'fixed', margin: 0, inset: 'auto', maxHeight: height, minWidth: matchWidth ? undefined : Math.min(r.width, 280) };
    if (width) next.width = Math.min(width, vw - 16);
    if (up) next.bottom = vh - r.top + 4;
    else next.top = r.bottom + 4;
    if (align === 'end') next.right = Math.max(8, vw - r.right);
    else next.left = Math.max(8, Math.min(r.left, vw - (width ?? 240) - 8));
    setPos(next);
  }, [anchorRef, align, matchWidth, maxHeight]);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (el && 'showPopover' in el && !el.matches(':popover-open')) {
      try {
        el.showPopover();
      } catch {
        // not connected yet or already shown; positioning still works as a fixed element
      }
    }
    place();
    const onMove = () => place();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [place]);

  React.useEffect(() => {
    if (!onDismiss) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onDismiss, anchorRef]);

  return (
    <div
      ref={setRefs}
      popover="manual"
      className={cn('z-50 overflow-y-auto rounded-md border border-stone-200 bg-white p-1 text-sm text-stone-900 shadow-lg', className)}
      style={{ ...pos, ...style }}
      {...props}
    >
      {children}
    </div>
  );
});
