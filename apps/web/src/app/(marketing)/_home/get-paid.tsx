'use client';
import * as React from 'react';
import { Check, Landmark, Mail, MousePointer2, RotateCcw } from 'lucide-react';
import { Money, estimateProcessorFee } from '@evenbooks/domain';
import { cn } from '@/lib/utils';
import { fmtUsd } from './balance-mark';
import { type DemoMonth, dayLabel } from './demo-month';

const AMOUNT = Money.of('1850.00', 'USD');
/** Juniper Studio is on the paid plan, so the only fee is Stripe's published bank-debit rate. */
const FEE = estimateProcessorFee(AMOUNT, 'ach');
const NET = AMOUNT.subtract(FEE);
const n = (m: Money) => Number(m.toString());

const STEPS = [
  { title: 'Send the invoice', text: 'One click emails a PDF and a pay link. The receivable posts as you send it.' },
  { title: 'They pay from their phone', text: 'By card or bank transfer, on a page with your name on it. No account to create.' },
  { title: 'It books itself', text: `The invoice is marked paid. The payment and Stripe’s ${fmtUsd(n(FEE))} fee are booked together in one entry.` },
  { title: 'The payout matches up', text: 'When the money reaches your bank, Evenbooks matches it for you and the Stripe balance returns to zero.' },
] as const;
/** Story days, shared with the month section: Marlow Bakery's invoice is sent on the 18th, paid on the 22nd, paid out on the 25th. */
const SENT = 18;
const PAID = 22;
const PAYOUT = 25;
const STEP_MS = 3400;
const LAST_STEP_MS = 5200;

/**
 * Getting paid, as a four-beat illustration: your books on the left, your
 * customer's phone on the right, the invoice and then the money travelling
 * between them. Plays itself while on screen; the steps below are also buttons.
 */
export function GetPaid({ month }: { month: DemoMonth }) {
  const [step, setStep] = React.useState(0);
  const [auto, setAuto] = React.useState(false);
  const [visible, setVisible] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = root.current;
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduced) setAuto(true);
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  React.useEffect(() => {
    if (!auto || !visible) return;
    const t = setTimeout(() => setStep((s) => (s + 1) % STEPS.length), step === STEPS.length - 1 ? LAST_STEP_MS : STEP_MS);
    return () => clearTimeout(t);
  }, [auto, visible, step]);

  const choose = (i: number) => {
    setAuto(false);
    setStep(i);
  };

  return (
    <div ref={root}>
      <div aria-hidden className="ve-stage relative overflow-hidden rounded-lg border border-stone-200 px-4 py-8 sm:px-8 sm:py-12">
        <div className="relative mx-auto grid max-w-5xl items-center gap-0 lg:grid-cols-[minmax(0,1fr)_9rem_17rem]">
          <Books step={step} month={month} />
          <Connector step={step} />
          <Phone step={step} month={month} />
        </div>
      </div>

      <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="How getting paid works">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <button
              type="button"
              onClick={() => choose(i)}
              aria-current={step === i ? 'step' : undefined}
              className={cn(
                'relative h-full w-full overflow-hidden rounded-lg border p-3.5 text-left transition-colors sm:p-4',
                step === i ? 'border-brand-300 bg-white shadow-sm' : 'border-stone-200 bg-white/60 hover:bg-white',
              )}
            >
              <span className="flex items-center gap-2.5">
                <span
                  className={cn(
                    'tabular grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold transition-colors',
                    step === i ? 'bg-brand-600 text-white' : i < step ? 'bg-brand-100 text-brand-800' : 'bg-stone-100 text-stone-500',
                  )}
                >
                  {i < step ? <Check className="size-3.5" aria-hidden /> : i + 1}
                </span>
                <span className="font-display text-base font-semibold text-stone-900">{s.title}</span>
              </span>
              <span className={cn('mt-2 text-sm leading-6 text-stone-600', step === i ? 'block' : 'hidden sm:block')}>{s.text}</span>
              {step === i && auto && visible && (
                <span
                  key={`${step}-progress`}
                  aria-hidden
                  className="ve-progress absolute inset-x-0 bottom-0 h-0.5 origin-left bg-brand-500"
                  style={{ animationDuration: `${i === STEPS.length - 1 ? LAST_STEP_MS : STEP_MS}ms` }}
                />
              )}
            </button>
          </li>
        ))}
      </ol>
      {!auto && (
        <button
          type="button"
          onClick={() => {
            setStep(0);
            setAuto(true);
          }}
          className="mt-3 inline-flex h-10 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-stone-700 hover:bg-stone-100"
        >
          <RotateCcw className="size-4" aria-hidden />
          Play it again
        </button>
      )}
    </div>
  );
}

/** Shows once `step` reaches `from`, after `delay` ms. Everything is always rendered, so nothing jumps. */
function Reveal({ step, from, delay = 0, className, children }: { step: number; from: number; delay?: number; className?: string; children: React.ReactNode }) {
  const on = step >= from;
  return (
    <div
      className={cn('ve-reveal', on ? 'translate-y-0 opacity-100' : 'translate-y-1.5 opacity-0', className)}
      style={{ transitionDelay: on && step === from ? `${delay}ms` : '0ms' }}
    >
      {children}
    </div>
  );
}

function Books({ step, month }: { step: number; month: DemoMonth }) {
  const status = step === 0 ? { label: 'Draft', tone: 'bg-stone-100 text-stone-600' } : step === 1 ? { label: 'Sent', tone: 'bg-sky-50 text-sky-700' } : { label: 'Paid', tone: 'bg-brand-100 text-brand-800' };
  return (
    <div className="relative min-w-0 overflow-hidden rounded-lg border border-stone-200 bg-white shadow-[0_24px_60px_-36px_rgb(0_0_0/0.4)]">
      <div className="flex items-center justify-between gap-3 border-b border-stone-200 bg-stone-50 px-4 py-2.5">
        <span className="flex items-center gap-2 text-xs font-medium text-stone-600">
          <span className="flex flex-col gap-[2px]">
            <span className="block h-[2.5px] w-3 rounded-full bg-brand-600" />
            <span className="block h-[2.5px] w-3 rounded-full bg-brand-600" />
          </span>
          Juniper Studio · Invoices
        </span>
        <span className={cn('rounded-full px-2 py-0.5 text-[0.7rem] font-medium transition-colors duration-500', status.tone)}>{status.label}</span>
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-display text-lg font-semibold text-stone-900">INV-1042</p>
            <p className="truncate text-sm text-stone-500">Marlow Bakery · Brand refresh, phase 2</p>
          </div>
          <p className="tabular shrink-0 text-lg font-semibold text-stone-900">{fmtUsd(n(AMOUNT))}</p>
        </div>

        <div className="relative h-10">
          <div className={cn('ve-swap absolute inset-0 flex items-center', step === 0 ? 'opacity-100' : 'pointer-events-none opacity-0')}>
            <span key={`send-${step}`} className="ve-press relative inline-flex h-10 items-center gap-2 rounded-md bg-brand-600 px-4 text-sm font-medium text-white shadow-sm">
              <Mail className="size-4" />
              Send invoice
            </span>
            {step === 0 && <MousePointer2 key="cursor" className="ve-cursor absolute top-5 left-28 size-5 fill-white text-stone-900" />}
          </div>
          <p className={cn('ve-swap absolute inset-0 flex items-center gap-2 text-sm text-stone-600', step >= 1 ? 'opacity-100' : 'opacity-0')}>
            <Check className="size-4 shrink-0 text-brand-600" />
            <span className="truncate">Sent {dayLabel(month, SENT)} to orders@marlowbakery.com</span>
          </p>
        </div>

        <div className="grid">
          <Pending show={step < 2} label="The entry posts itself when they pay" />
          <Reveal step={step} from={2} delay={1000} className="col-start-1 row-start-1 rounded-md border border-stone-200 bg-stone-50 text-sm">
            <p className="flex justify-between border-b border-stone-200 px-3 py-1.5 text-xs text-stone-500">
              <span>Entry #151 · {dayLabel(month, PAID)} · posted automatically</span>
            </p>
            <dl className="space-y-0.5 px-3 py-2">
              <EntryLine side="Dr" account="Stripe balance" amount={n(NET)} />
              <EntryLine side="Dr" account="Stripe fees" amount={n(FEE)} />
              <EntryLine side="Cr" account="Accounts receivable" amount={n(AMOUNT)} />
            </dl>
            <p className="flex items-center gap-2 border-t border-stone-200 px-3 py-1.5 text-xs font-medium text-brand-700">
              <span className="flex flex-col gap-[2px]">
                <span className="block h-[2px] w-2.5 rounded-full bg-brand-600" />
                <span className="block h-[2px] w-2.5 rounded-full bg-brand-600" />
              </span>
              Balanced
            </p>
          </Reveal>
        </div>

        <div className="grid">
          <Pending show={step < 3} label="Payout expected in two business days" compact />
          <Reveal step={step} from={3} delay={200} className="col-start-1 row-start-1 flex items-center gap-3 rounded-md border border-brand-200 bg-brand-50 px-3 py-2.5 text-sm">
            <Landmark className="size-4 shrink-0 text-brand-700" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-stone-900">Stripe payout · {dayLabel(month, PAYOUT)}</span>
              <span className="block text-xs text-brand-800">Matched to your bank deposit · Stripe balance {fmtUsd(0)}</span>
            </span>
            <span className="tabular shrink-0 font-medium text-brand-700">+{fmtUsd(n(NET))}</span>
          </Reveal>
        </div>
      </div>
    </div>
  );
}

/** A dashed outline where something will land, so the empty window reads as waiting rather than blank. */
function Pending({ show, label, compact }: { show: boolean; label: string; compact?: boolean }) {
  return (
    <div
      className={cn(
        've-reveal pointer-events-none col-start-1 row-start-1 flex items-center justify-center rounded-md border border-dashed border-stone-300 text-xs text-stone-400',
        compact ? 'min-h-[3.4rem]' : 'min-h-[8.5rem]',
        show ? 'opacity-100' : 'opacity-0',
      )}
    >
      {label}
    </div>
  );
}

function EntryLine({ side, account, amount }: { side: 'Dr' | 'Cr'; account: string; amount: number }) {
  return (
    <div className={cn('flex justify-between gap-3 text-stone-800', side === 'Cr' && 'pl-4')}>
      <dt className="truncate">
        {side} {account}
      </dt>
      <dd className="tabular">{fmtUsd(amount)}</dd>
    </div>
  );
}

/** The path between the two screens, with the invoice going out and the money coming back. */
function Connector({ step }: { step: number }) {
  return (
    <div className="relative mx-auto h-20 w-0.5 lg:h-0.5 lg:w-full">
      <span className="ve-wire absolute inset-0" />
      {step === 1 && (
        <span key="out" className="ve-token ve-token-out absolute grid size-9 place-items-center rounded-full bg-white text-brand-700 shadow-md ring-1 ring-stone-200">
          <Mail className="size-4" />
        </span>
      )}
      {step === 2 && (
        <span key="back" className="ve-token ve-token-back absolute grid size-9 place-items-center rounded-full bg-brand-600 text-sm font-semibold text-white shadow-md">
          $
        </span>
      )}
    </div>
  );
}

function Phone({ step, month }: { step: number; month: DemoMonth }) {
  return (
    <div className="mx-auto w-[14.5rem] rounded-[2.25rem] border border-stone-300 bg-stone-900 p-2 shadow-[0_30px_70px_-30px_rgb(0_0_0/0.5)] sm:w-[17rem]">
      <div className="relative h-[24rem] overflow-hidden rounded-[1.8rem] bg-stone-50 sm:h-[29rem]">
        <div className="flex items-center justify-between px-6 pt-3 text-[0.65rem] font-semibold text-stone-700">
          <span className="tabular">9:41</span>
          <span className="h-4 w-16 rounded-full bg-stone-900" />
          <span className="flex gap-0.5">
            <span className="h-2 w-1 rounded-sm bg-stone-700" />
            <span className="h-2 w-1 rounded-sm bg-stone-700" />
            <span className="h-2 w-1 rounded-sm bg-stone-400" />
          </span>
        </div>

        {/* Before: an ordinary inbox. */}
        <Screen on={step === 0}>
          <p className="px-5 pt-6 font-display text-xl font-semibold text-stone-900">Inbox</p>
          <ul className="mt-3 space-y-2 px-4">
            {['Flour order confirmed', 'Farmers market, Saturday', 'Your oven service is due'].map((t) => (
              <li key={t} className="rounded-lg bg-white px-3 py-2.5 shadow-sm ring-1 ring-stone-200">
                <span className="block h-2 w-16 rounded-full bg-stone-200" />
                <span className="mt-1.5 block truncate text-xs text-stone-600">{t}</span>
              </li>
            ))}
          </ul>
        </Screen>

        {/* The invoice page your customer opens. */}
        <Screen on={step === 1} delay={900}>
          <div className="px-5 pt-5">
            <p className="text-[0.7rem] font-semibold tracking-wide text-stone-500 uppercase">Juniper Studio</p>
            <p className="mt-1 font-display text-lg font-semibold text-stone-900">Invoice INV-1042</p>
            <p className="text-xs text-stone-500">Due {dayLabel(month, SENT, 30)} · Marlow Bakery</p>
          </div>
          <div className="mx-4 mt-4 rounded-lg bg-white p-3 text-xs shadow-sm ring-1 ring-stone-200">
            <p className="flex justify-between text-stone-600">
              <span>Brand refresh, phase 2</span>
              <span className="tabular">{fmtUsd(n(AMOUNT))}</span>
            </p>
            <p className="mt-2 flex justify-between border-t border-stone-200 pt-2 font-semibold text-stone-900">
              <span>Amount due</span>
              <span className="tabular">{fmtUsd(n(AMOUNT))}</span>
            </p>
          </div>
          <div className="mt-4 space-y-2 px-4">
            <span className="relative flex h-10 items-center justify-center overflow-hidden rounded-md bg-brand-600 text-sm font-medium text-white">
              Pay from your bank account
              {step === 1 && <span key="tap" className="ve-tap absolute top-1/2 left-1/2 size-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/50" />}
            </span>
            <span className="flex h-10 items-center justify-center rounded-md border border-stone-300 bg-white text-sm font-medium text-stone-800">Pay by card</span>
          </div>
          <p className="mt-4 px-5 text-center text-[0.65rem] text-stone-400">Powered by evenbooks</p>
        </Screen>

        {/* Paid. */}
        <Screen on={step >= 2}>
          <div className="flex h-full flex-col items-center justify-center px-6 pb-10 text-center">
            <span className="ve-check grid size-16 place-items-center rounded-full bg-brand-600 text-white">
              <Check className="size-8" strokeWidth={2.5} />
            </span>
            <p className="mt-5 font-display text-xl font-semibold text-stone-900">Paid {fmtUsd(n(AMOUNT))}</p>
            <p className="mt-1 text-sm text-stone-500">Thank you. A receipt from Juniper Studio is on its way.</p>
          </div>
        </Screen>

        {/* A receipt arrives on the lock screen. */}
        <div className={cn('ve-reveal absolute inset-x-3 top-9', step === 3 ? 'translate-y-0 opacity-100' : '-translate-y-3 opacity-0')}>
          <div className="flex items-center gap-2.5 rounded-lg bg-white/95 px-3 py-2 shadow-md ring-1 ring-stone-200">
            <Mail className="size-4 shrink-0 text-brand-700" />
            <span className="min-w-0 text-[0.7rem] leading-tight">
              <span className="block font-semibold text-stone-900">Receipt from Juniper Studio</span>
              <span className="block truncate text-stone-500">INV-1042 · {fmtUsd(n(AMOUNT))} paid in full</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Screen({ on, delay = 0, children }: { on: boolean; delay?: number; children: React.ReactNode }) {
  return (
    <div
      className={cn('ve-screen absolute inset-x-0 top-8 bottom-0', on ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0')}
      style={{ transitionDelay: on ? `${delay}ms` : '0ms' }}
    >
      {children}
    </div>
  );
}
