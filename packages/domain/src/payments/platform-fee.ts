import { D, Money } from '../money/money';

export type CompanyPlan = 'free' | 'paid';
export type OnlinePaymentMethod = 'card' | 'ach';

/** The processor's own published fee schedule, used to size Evenbooks' share. */
export interface ProcessorFeeSchedule {
  /** Cards: percent plus a fixed amount per charge (Stripe US standard: 2.9 + 0.30). */
  cardPercent: string;
  cardFixed: string;
  /** ACH debits: percent with a per-charge cap (Stripe US standard: 0.8 capped at 5.00); null = no cap. */
  achPercent: string;
  achCap: string | null;
}

/**
 * What the business pays in total on a free-plan charge, processor fee
 * included. Evenbooks' application fee is the difference between that total and
 * the processor's estimated fee, so the business sees one all-in rate.
 */
export interface PlatformFeeConfig {
  cardTotalPercent: string;
  achTotalPercent: string;
  schedule: ProcessorFeeSchedule;
}

export const DEFAULT_PROCESSOR_FEE_SCHEDULE: ProcessorFeeSchedule = { cardPercent: '2.9', cardFixed: '0.30', achPercent: '0.8', achCap: '5' };
export const DEFAULT_PLATFORM_FEE: PlatformFeeConfig = { cardTotalPercent: '5', achTotalPercent: '1', schedule: DEFAULT_PROCESSOR_FEE_SCHEDULE };

/** Processor fee for a charge under the published schedule, rounded to currency precision. */
export function estimateProcessorFee(amount: Money, method: OnlinePaymentMethod, schedule: ProcessorFeeSchedule = DEFAULT_PROCESSOR_FEE_SCHEDULE): Money {
  if (!amount.isPositive()) return Money.zero(amount.currency);
  if (method === 'card') {
    return amount.multiply(new D(schedule.cardPercent).div(100)).add(Money.of(schedule.cardFixed, amount.currency));
  }
  const pct = amount.multiply(new D(schedule.achPercent).div(100));
  return schedule.achCap === null ? pct : pct.min(Money.of(schedule.achCap, amount.currency));
}

/** The all-in percent a company pays on a method ("0" on the paid plan, which pays only the processor). */
export function totalFeePercent(plan: CompanyPlan, method: OnlinePaymentMethod, config: PlatformFeeConfig = DEFAULT_PLATFORM_FEE): string {
  if (plan === 'paid') return '0';
  return method === 'card' ? config.cardTotalPercent : config.achTotalPercent;
}

/**
 * Evenbooks' application fee on a direct charge: the all-in percent of the amount
 * minus the processor's estimated fee, never below zero (on very small
 * charges the processor's fixed fee alone exceeds the all-in percent; the
 * business then pays the processor's fee and Evenbooks takes nothing). Paid-plan
 * companies pay nothing to Evenbooks.
 */
export function computePlatformFee(amount: Money, plan: CompanyPlan, method: OnlinePaymentMethod, config: PlatformFeeConfig = DEFAULT_PLATFORM_FEE): Money {
  const zero = Money.zero(amount.currency);
  if (plan === 'paid' || !amount.isPositive()) return zero;
  const pct = new D(totalFeePercent(plan, method, config));
  if (pct.lte(0)) return zero;
  const total = amount.multiply(pct.div(100));
  const ours = total.subtract(estimateProcessorFee(amount, method, config.schedule));
  return ours.max(zero).min(amount);
}

/** Share of the original application fee to give back when `refunded` of `charged` is refunded (the last refund gets whatever is left). */
export function proportionalFeeRefund(originalFee: Money, charged: Money, refunded: Money, alreadyRefundedFee: Money): Money {
  if (!charged.isPositive() || !originalFee.isPositive()) return Money.zero(originalFee.currency);
  const remainingFee = originalFee.subtract(alreadyRefundedFee);
  if (refunded.gte(charged)) return remainingFee;
  const share = Money.round(originalFee.decimal.times(refunded.decimal).div(charged.decimal), originalFee.currency);
  return share.min(remainingFee);
}

const num = (v: string | undefined, fallback: string): string => (v && /^\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : fallback);

export function platformFeeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PlatformFeeConfig {
  const d = DEFAULT_PLATFORM_FEE;
  const cap = env.PROCESSOR_ACH_FEE_CAP?.trim();
  return {
    cardTotalPercent: num(env.PLATFORM_FEE_CARD_PERCENT, d.cardTotalPercent),
    achTotalPercent: num(env.PLATFORM_FEE_ACH_PERCENT, d.achTotalPercent),
    schedule: {
      cardPercent: num(env.PROCESSOR_CARD_FEE_PERCENT, d.schedule.cardPercent),
      cardFixed: num(env.PROCESSOR_CARD_FEE_FIXED, d.schedule.cardFixed),
      achPercent: num(env.PROCESSOR_ACH_FEE_PERCENT, d.schedule.achPercent),
      achCap: cap === 'none' ? null : num(cap, d.schedule.achCap ?? '5'),
    },
  };
}
