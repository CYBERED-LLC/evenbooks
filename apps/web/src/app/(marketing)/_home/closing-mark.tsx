'use client';
import * as React from 'react';
import { LinkButton } from '@/components/ui/button';

/**
 * The last screen. Two long bars drift apart as the pointer wanders and slide
 * into an equals sign as it nears the button. On touch, or with reduced
 * motion, they simply meet once the section scrolls into view.
 */
export function ClosingMark({ headline, children }: { headline: string; children?: React.ReactNode }) {
  const root = React.useRef<HTMLElement>(null);
  const cta = React.useRef<HTMLDivElement>(null);
  const [offset, setOffset] = React.useState(1);

  React.useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setOffset((o) => (o === 1 ? 0 : o)), { threshold: 0.45 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const onMove = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const b = cta.current?.getBoundingClientRect();
    const r = root.current?.getBoundingClientRect();
    if (!b || !r) return;
    const dx = e.clientX - (b.left + b.width / 2);
    const dy = e.clientY - (b.top + b.height / 2);
    const dist = Math.hypot(dx, dy);
    // Within reach of the button the bars are even; further away they part, up to a limit.
    const t = Math.min(1, Math.max(0, (dist - 90) / (r.width * 0.45)));
    setOffset(t * Math.sign(dx || 1));
  };

  return (
    <section ref={root} onPointerMove={onMove} onPointerLeave={() => setOffset(0)} className="relative overflow-hidden border-t border-stone-200 bg-white">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        <div aria-hidden className="relative mx-auto h-[clamp(6rem,16vw,11rem)] max-w-3xl">
          <span
            className="ve-glide absolute inset-x-0 top-0 h-[36%] rounded-full bg-brand-600"
            style={{ transform: `translateX(${offset * -14}%)` }}
          />
          <span
            className="ve-glide absolute inset-x-0 bottom-0 h-[36%] rounded-full bg-brand-600"
            style={{ transform: `translateX(${offset * 14}%)` }}
          />
        </div>
        <h2 className="mx-auto mt-12 max-w-3xl text-center font-display text-[clamp(2.25rem,7vw,4.5rem)] leading-[1.02] font-semibold tracking-[-0.03em] text-balance text-stone-900">
          {headline}
        </h2>
        {children && <div className="mx-auto mt-5 max-w-xl text-center text-lg leading-8 text-stone-600">{children}</div>}
        <div ref={cta} className="mt-9 flex flex-wrap justify-center gap-3">
          <LinkButton href="/sign-up" size="lg">
            Start for free
          </LinkButton>
          <LinkButton href="/pricing" variant="secondary" size="lg">
            See pricing
          </LinkButton>
        </div>
      </div>
    </section>
  );
}
