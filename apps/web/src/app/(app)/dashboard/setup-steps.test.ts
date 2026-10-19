import { describe, expect, it } from 'vitest';
import { setupProgress, setupSteps, showSetupChecklist, type SetupFacts } from './setup-steps';

const none: SetupFacts = { aboutDone: false, detailsDone: false, bankDone: false, balancesDone: false, invoiceDone: false, paymentsDone: false };

describe('setup checklist', () => {
  it('lists five required steps and the optional card payments step', () => {
    const steps = setupSteps(none);
    expect(steps.map((s) => s.id)).toEqual(['about', 'details', 'bank', 'balances', 'invoice', 'payments']);
    expect(steps.at(-1)).toMatchObject({ optional: true, href: '/settings/payments' });
    expect(setupProgress(steps)).toEqual({ done: 0, total: 5, complete: false });
  });

  it('leaves card payments out when the server cannot take them', () => {
    expect(setupSteps({ ...none, paymentsDone: null }).map((s) => s.id)).not.toContain('payments');
  });

  it('counts only required steps, and the optional one never holds the list open', () => {
    const steps = setupSteps({ ...none, aboutDone: true, bankDone: true, paymentsDone: true });
    expect(setupProgress(steps)).toEqual({ done: 2, total: 5, complete: false });
    const all = setupSteps({ aboutDone: true, detailsDone: true, bankDone: true, balancesDone: true, invoiceDone: true, paymentsDone: false });
    expect(setupProgress(all).complete).toBe(true);
    expect(showSetupChecklist({ dismissedAt: null, isAdmin: true, steps: all })).toBe(false);
  });

  it('shows for admins until dismissed, and never while still loading', () => {
    const steps = setupSteps(none);
    expect(showSetupChecklist({ dismissedAt: null, isAdmin: true, steps })).toBe(true);
    expect(showSetupChecklist({ dismissedAt: '2026-10-13T12:00:00Z', isAdmin: true, steps })).toBe(false);
    expect(showSetupChecklist({ dismissedAt: null, isAdmin: false, steps })).toBe(false);
    expect(showSetupChecklist({ dismissedAt: null, isAdmin: true, steps: null })).toBe(false);
  });
});
