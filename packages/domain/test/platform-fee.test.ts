import { describe, expect, it } from 'vitest';
import { Money } from '../src/money/index';
import { computePlatformFee, estimateProcessorFee, platformFeeConfigFromEnv, proportionalFeeRefund, totalFeePercent } from '../src/payments/index';

const usd = (v: string) => Money.of(v, 'USD');

describe('processor fee estimate (Stripe US standard schedule)', () => {
  it('cards: 2.9 percent plus 0.30', () => {
    expect(estimateProcessorFee(usd('100.00'), 'card').toString()).toBe('3.20');
    expect(estimateProcessorFee(usd('1000.00'), 'card').toString()).toBe('29.30');
  });
  it('ACH: 0.8 percent capped at 5.00', () => {
    expect(estimateProcessorFee(usd('100.00'), 'ach').toString()).toBe('0.80');
    expect(estimateProcessorFee(usd('625.00'), 'ach').toString()).toBe('5.00');
    expect(estimateProcessorFee(usd('5000.00'), 'ach').toString()).toBe('5.00');
  });
});

describe('platform fee: the business pays one all-in rate, processor fee included', () => {
  it('cards on the free plan cost 5 percent in total; Evenbooks takes the rest after Stripe', () => {
    expect(computePlatformFee(usd('100.00'), 'free', 'card').toString()).toBe('1.80'); // 5.00 - 3.20
    expect(computePlatformFee(usd('1000.00'), 'free', 'card').toString()).toBe('20.70'); // 50.00 - 29.30
    expect(computePlatformFee(usd('300.00'), 'free', 'card').toString()).toBe('6.00'); // 15.00 - 9.00
    expect(totalFeePercent('free', 'card')).toBe('5');
  });
  it('ACH on the free plan costs 1 percent in total', () => {
    expect(computePlatformFee(usd('350.00'), 'free', 'ach').toString()).toBe('0.70'); // 3.50 - 2.80
    expect(computePlatformFee(usd('1000.00'), 'free', 'ach').toString()).toBe('5.00'); // 10.00 - 5.00 (cap)
    expect(computePlatformFee(usd('5000.00'), 'free', 'ach').toString()).toBe('45.00'); // 50.00 - 5.00, no cap on our side
    expect(totalFeePercent('free', 'ach')).toBe('1');
  });
  it('never goes negative when the processor fee alone exceeds the all-in rate', () => {
    // 5.00 card: 5% = 0.25, Stripe takes 0.45 -> Evenbooks takes nothing
    expect(computePlatformFee(usd('5.00'), 'free', 'card').toString()).toBe('0.00');
  });
  it('paid plan pays Evenbooks nothing on either method', () => {
    expect(computePlatformFee(usd('1000.00'), 'paid', 'card').isZero()).toBe(true);
    expect(computePlatformFee(usd('1000.00'), 'paid', 'ach').isZero()).toBe(true);
    expect(totalFeePercent('paid', 'card')).toBe('0');
  });
  it('refunds the application fee proportionally and exactly in total', () => {
    const fee = usd('8.10');
    const charged = usd('400.00');
    const first = proportionalFeeRefund(fee, charged, usd('100.00'), usd('0'));
    expect(first.toString()).toBe('2.03'); // 8.10 * 100/400 = 2.025 -> half up
    const rest = proportionalFeeRefund(fee, charged, usd('300.00'), first);
    expect(rest.toString()).toBe('6.07');
    expect(first.add(rest).toString()).toBe('8.10');
    expect(proportionalFeeRefund(fee, charged, usd('400.00'), usd('0')).toString()).toBe('8.10');
  });
  it('reads configuration from the environment with safe defaults', () => {
    expect(platformFeeConfigFromEnv({})).toEqual({ cardTotalPercent: '5', achTotalPercent: '1', schedule: { cardPercent: '2.9', cardFixed: '0.30', achPercent: '0.8', achCap: '5' } });
    const custom = platformFeeConfigFromEnv({ PLATFORM_FEE_CARD_PERCENT: '4', PLATFORM_FEE_ACH_PERCENT: 'abc', PROCESSOR_ACH_FEE_CAP: 'none', PROCESSOR_CARD_FEE_FIXED: '0.25' });
    expect(custom.cardTotalPercent).toBe('4');
    expect(custom.achTotalPercent).toBe('1');
    expect(custom.schedule.achCap).toBeNull();
    expect(custom.schedule.cardFixed).toBe('0.25');
  });
});
