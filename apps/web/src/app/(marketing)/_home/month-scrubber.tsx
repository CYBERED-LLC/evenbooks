'use client';
import * as React from 'react';
import { Lock, Pause, Play } from 'lucide-react';
import { Money, estimateProcessorFee } from '@evenbooks/domain';
import { cn } from '@/lib/utils';
import { fmtUsd, useTween } from './balance-mark';
import { type DemoMonth, storyDay } from './demo-month';

const usd = (v: string) => Money.of(v, 'USD');
const zero = Money.zero('USD');

interface Books {
  cash: Money;
  owed: Money;
  stripe: Money;
  income: Money;
  expenses: Money;
}
interface MonthEvent {
  day: number;
  title: string;
  detail: string | ((m: DemoMonth) => string);
  apply: (b: Books) => Books;
  milestone?: boolean;
}

const CARD_FEE = estimateProcessorFee(usd('2400.00'), 'card');
const ACH_FEE = estimateProcessorFee(usd('1850.00'), 'ach');
const CARD_NET = usd('2400.00').subtract(CARD_FEE);
const ACH_NET = usd('1850.00').subtract(ACH_FEE);

/**
 * One month at a small studio on the paid plan, so the only payment fees are
 * Stripe's published rates. Days are on a 30-day story scale; `buildMonth`
 * maps them onto the real month.
 */
const STORY: MonthEvent[] = [
  { day: 1, title: 'Opening balance', detail: 'Checking starts the month at $4,200.00.', apply: (b) => b },
  {
    day: 3,
    title: 'Invoice #1041 sent to Harbor Dental',
    detail: 'It counts as income now. Harbor Dental owes you $2,400.00.',
    apply: (b) => ({ ...b, owed: b.owed.add(usd('2400')), income: b.income.add(usd('2400')) }),
  },
  { day: 5, title: 'Figma', detail: 'Approved from the inbox as Software subscriptions.', apply: (b) => ({ ...b, cash: b.cash.subtract(usd('45')), expenses: b.expenses.add(usd('45')) }) },
  {
    day: 9,
    title: 'Harbor Dental pays by card',
    detail: `The invoice closes itself. Stripe keeps ${fmtUsd(Number(CARD_FEE.toString()))}, booked as a fee.`,
    apply: (b) => ({ ...b, owed: b.owed.subtract(usd('2400')), stripe: b.stripe.add(CARD_NET), expenses: b.expenses.add(CARD_FEE) }),
  },
  {
    day: 11,
    title: 'Stripe payout arrives',
    detail: 'Matched to the deposit in your bank. The Stripe balance returns to zero.',
    apply: (b) => ({ ...b, stripe: b.stripe.subtract(CARD_NET), cash: b.cash.add(CARD_NET) }),
  },
  { day: 15, title: 'Common Desk', detail: 'Rent. A rule you set up once fills this in.', apply: (b) => ({ ...b, cash: b.cash.subtract(usd('620')), expenses: b.expenses.add(usd('620')) }) },
  {
    day: 18,
    title: 'Invoice #1042 sent to Marlow Bakery',
    detail: 'Sent by email with a PDF and a pay link.',
    apply: (b) => ({ ...b, owed: b.owed.add(usd('1850')), income: b.income.add(usd('1850')) }),
  },
  {
    day: 22,
    title: 'Marlow Bakery pays by bank transfer',
    detail: `A bank transfer costs ${fmtUsd(Number(ACH_FEE.toString()))} here, not the ${fmtUsd(Number(estimateProcessorFee(usd('1850.00'), 'card').toString()))} a card would.`,
    apply: (b) => ({ ...b, owed: b.owed.subtract(usd('1850')), stripe: b.stripe.add(ACH_NET), expenses: b.expenses.add(ACH_FEE) }),
  },
  { day: 25, title: 'Stripe payout arrives', detail: 'Matched and cleared, same as last time.', apply: (b) => ({ ...b, stripe: b.stripe.subtract(ACH_NET), cash: b.cash.add(ACH_NET) }) },
  { day: 27, title: 'Paper and toner', detail: 'Office supplies. The receipt is attached to the entry.', apply: (b) => ({ ...b, cash: b.cash.subtract(usd('120')), expenses: b.expenses.add(usd('120')) }) },
  { day: 30, title: 'Reconciled and locked', detail: (m) => `Every transaction ticked off against the bank statement. ${m.name} is closed.`, apply: (b) => b, milestone: true },
];

/** The story laid onto a real month: events on real days, the books at the end of each day, and the chart geometry. */
function buildMonth(m: DemoMonth) {
  const events = STORY.map((e) => ({
    ...e,
    day: storyDay(m, e.day),
    detail: typeof e.detail === 'function' ? e.detail(m) : e.detail,
  }));
  // Books at the end of each day, index 0 = before day 1.
  let b: Books = { cash: usd('4200'), owed: zero, stripe: zero, income: zero, expenses: zero };
  const books: Books[] = [b];
  for (let day = 1; day <= m.days; day++) {
    for (const e of events.filter((x) => x.day === day)) b = e.apply(b);
    books.push(b);
  }
  const cash = books.slice(1).map((d) => Number(d.cash.toString()));
  const yMin = Math.floor(Math.min(...cash) / 1000) * 1000 - 500;
  const yMax = Math.ceil(Math.max(...cash) / 1000) * 1000;
  const x = (day: number) => ((day - 1) / (m.days - 1)) * 100;
  const y = (v: number) => 100 - ((v - yMin) / (yMax - yMin)) * 100;
  /** A step line: cash only changes when something posts. */
  const stepPath = (upTo: number) => {
    let d = `M ${x(1)} ${y(cash[0]!)}`;
    for (let day = 2; day <= upTo; day++) d += ` H ${x(day)} V ${y(cash[day - 1]!)}`;
    return d;
  };
  return { events, books, cash, yMin, yMax, x, y, stepPath, fullPath: stepPath(m.days) };
}

export function MonthScrubber({ month }: { month: DemoMonth }) {
  const { events, books, cash, yMin, yMax, x, y, stepPath, fullPath } = React.useMemo(() => buildMonth(month), [month]);
  const last = month.days;
  const [day, setDay] = React.useState(1);
  const [playing, setPlaying] = React.useState(false);
  const [hover, setHover] = React.useState<number | null>(null);
  const chart = React.useRef<HTMLDivElement>(null);
  const list = React.useRef<HTMLOListElement>(null);

  React.useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setDay((d) => {
        if (d >= last) {
          setPlaying(false);
          return last;
        }
        return d + 1;
      });
    }, 380);
    return () => clearInterval(t);
  }, [playing, last]);

  const toggle = () => {
    if (!playing && day >= last) setDay(1);
    setPlaying((p) => !p);
  };

  const b = books[day]!;
  const n = (m: Money) => Number(m.toString());
  const latest = [...events].reverse().find((e) => e.day <= day)!;
  const shownDay = hover ?? day;

  // Keep the latest event visible in the list without scrolling the page.
  React.useEffect(() => {
    const ol = list.current;
    const li = ol?.querySelector<HTMLElement>('[data-current]');
    if (!ol || !li) return;
    if (li.offsetTop < ol.scrollTop) ol.scrollTop = li.offsetTop - 8;
    else if (li.offsetTop + li.offsetHeight > ol.scrollTop + ol.clientHeight) ol.scrollTop = li.offsetTop + li.offsetHeight - ol.clientHeight + 8;
  }, [latest]);

  const onPointer = (e: React.PointerEvent) => {
    const r = chart.current?.getBoundingClientRect();
    if (!r) return;
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setHover(Math.round(t * (last - 1)) + 1);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
      <dl className="grid grid-cols-2 gap-px border-b border-stone-200 bg-stone-200 lg:grid-cols-4">
        <Tile label="Cash in checking" value={n(b.cash)} />
        <Tile label="Owed to you" value={n(b.owed)} />
        <Tile label="Stripe balance" value={n(b.stripe)} note={b.stripe.isZero() ? 'cleared' : 'in transit'} />
        <Tile label={`Net profit, ${month.name}`} value={n(b.income.subtract(b.expenses))} />
      </dl>

      <div className="grid lg:grid-cols-[1.6fr_1fr]">
        <div className="min-w-0 p-4 sm:p-6">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-medium text-stone-800">Cash in checking</p>
            <p className="tabular text-sm text-stone-500">
              {month.short} {shownDay} · <span className="font-medium text-stone-900">{fmtUsd(cash[shownDay - 1]!)}</span>
            </p>
          </div>
          <div className="mt-4 grid grid-cols-[3.25rem_1fr] gap-2">
            <div className="tabular relative text-right text-[0.7rem] text-stone-400" aria-hidden>
              <span className="absolute right-0 -translate-y-1/2" style={{ top: '0%' }}>
                {fmtUsd(yMax).replace('.00', '')}
              </span>
              <span className="absolute right-0 -translate-y-1/2" style={{ top: '100%' }}>
                {fmtUsd(yMin).replace('.00', '')}
              </span>
            </div>
            <div
              ref={chart}
              className="relative h-44 touch-none sm:h-56"
              onPointerMove={onPointer}
              onPointerDown={onPointer}
              onPointerLeave={() => setHover(null)}
              role="img"
              aria-label={`Cash in checking through ${month.name}: from ${fmtUsd(cash[0]!)} on the 1st to ${fmtUsd(cash[last - 1]!)} on the ${last}${last === 31 ? 'st' : 'th'}.`}
            >
              <span aria-hidden className="absolute inset-x-0 top-0 border-t border-stone-100" />
              <span aria-hidden className="absolute inset-x-0 top-1/2 border-t border-stone-100" />
              <span aria-hidden className="absolute inset-x-0 bottom-0 border-t border-stone-200" />
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
                <path d={fullPath} fill="none" stroke="var(--color-stone-300)" strokeWidth={2} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
                <path d={`${stepPath(day)} V 100 H ${x(1)} Z`} fill="var(--color-brand-500)" fillOpacity={0.08} stroke="none" />
                <path d={stepPath(day)} fill="none" stroke="var(--color-brand-600)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              </svg>
              {hover !== null && (
                <span aria-hidden className="pointer-events-none absolute inset-y-0 border-l border-stone-400/60" style={{ left: `${x(hover)}%` }} />
              )}
              <span
                aria-hidden
                className="ve-dot pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-600 ring-2 ring-white"
                style={{ left: `${x(day)}%`, top: `${y(cash[day - 1]!)}%` }}
              />
              {events.filter((e) => e.day > 1).map((e) => (
                <span
                  key={e.day}
                  aria-hidden
                  className={cn('pointer-events-none absolute bottom-0 h-1.5 w-px', e.day <= day ? 'bg-brand-500' : 'bg-stone-300')}
                  style={{ left: `${x(e.day)}%` }}
                />
              ))}
            </div>
          </div>
          <div className="mt-2 ml-[3.75rem] flex justify-between text-[0.7rem] text-stone-400" aria-hidden>
            <span>{month.short} 1</span>
            <span>
              {month.short} {Math.ceil(last / 2)}
            </span>
            <span>
              {month.short} {last}
            </span>
          </div>

          <div className="mt-5 flex items-center gap-3">
            <button
              type="button"
              onClick={toggle}
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-md bg-brand-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
            >
              {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
              {playing ? 'Pause' : day >= last ? 'Replay' : 'Play the month'}
            </button>
            <label htmlFor="ve-day" className="sr-only">
              Day of {month.name}
            </label>
            <input
              id="ve-day"
              type="range"
              min={1}
              max={last}
              value={day}
              onChange={(e) => {
                setPlaying(false);
                setDay(Number(e.target.value));
              }}
              aria-valuetext={`${month.name} ${day}`}
              className="ve-range min-w-0 flex-1"
            />
          </div>
        </div>

        <div className="border-t border-stone-200 bg-stone-50 lg:border-t-0 lg:border-l">
          <ol ref={list} className="relative max-h-[23rem] overflow-y-auto p-2" aria-label="What happened">
            {events.map((e) => {
              const past = e.day <= day;
              const current = e === latest;
              return (
                <li
                  key={e.day}
                  data-current={current || undefined}
                  className={cn(
                    'flex gap-3 rounded-md px-3 py-2 transition-colors',
                    current && 'bg-white shadow-sm ring-1 ring-stone-200',
                    !past && 'opacity-45',
                  )}
                >
                  <span className={cn('tabular w-12 shrink-0 pt-px text-xs', past ? 'text-brand-700' : 'text-stone-400')}>
                    {month.short} {e.day}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-stone-900">
                      {e.milestone && <Lock className="size-3.5 text-brand-600" aria-hidden />}
                      {e.title}
                    </span>
                    {current && <span className="ve-pop block text-xs leading-5 text-stone-600">{e.detail}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: number; note?: string }) {
  const shown = useTween(value, 360);
  return (
    <div className="bg-white px-4 py-3 sm:px-5">
      <dt className="flex items-center justify-between gap-2 text-xs text-stone-500">
        {label}
        {note && <span className={cn('rounded-full px-1.5 text-[0.65rem]', note === 'cleared' ? 'bg-brand-50 text-brand-700' : 'bg-amber-50 text-amber-700')}>{note}</span>}
      </dt>
      <dd className="tabular mt-0.5 text-lg font-semibold text-stone-900 sm:text-xl">{fmtUsd(shown)}</dd>
    </div>
  );
}
