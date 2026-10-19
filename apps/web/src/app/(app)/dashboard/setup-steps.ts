/**
 * The "Set up your books" checklist, as data. Each step ticks itself off from what is
 * already in the books; the dashboard gathers those facts (setup-checklist.tsx).
 */
export type SetupStepId = 'about' | 'details' | 'bank' | 'balances' | 'invoice' | 'payments';

export interface SetupFacts {
  /** Business type and tax basis are both answered. */
  aboutDone: boolean;
  /** The company has an email and a street address for its invoices. */
  detailsDone: boolean;
  /** A bank account is connected, or one has transactions. */
  bankDone: boolean;
  /** Starting balances were entered, or past books were imported. */
  balancesDone: boolean;
  /** At least one invoice has been issued. */
  invoiceDone: boolean;
  /** Card payments: null when the server can't take them (the step is left out). */
  paymentsDone: boolean | null;
}

export interface SetupStep {
  id: SetupStepId;
  title: string;
  detail: string;
  href: string;
  done: boolean;
  optional: boolean;
}

export function setupSteps(f: SetupFacts): SetupStep[] {
  const steps: SetupStep[] = [
    { id: 'about', title: 'Tell us about your business', detail: 'Four quick questions so dates and reports fit your business.', href: '/settings/company', done: f.aboutDone, optional: false },
    { id: 'details', title: 'Add your business details', detail: 'Your address and email, shown on your invoices.', href: '/settings/company', done: f.detailsDone, optional: false },
    { id: 'bank', title: 'Connect your bank or upload a statement', detail: 'Your transactions come in for you to sort.', href: '/banking', done: f.bankDone, optional: false },
    { id: 'balances', title: 'Enter starting balances', detail: 'What was in the bank on the day you start.', href: '/settings/opening-balances', done: f.balancesDone, optional: false },
    { id: 'invoice', title: 'Add a customer and send your first invoice', detail: 'Customers can be added right on the invoice.', href: '/invoices/new', done: f.invoiceDone, optional: false },
  ];
  if (f.paymentsDone !== null)
    steps.push({ id: 'payments', title: 'Optional: let customers pay by card', detail: 'Connect Stripe and a Pay button appears on your invoices.', href: '/settings/payments', done: f.paymentsDone, optional: true });
  return steps;
}

export function setupProgress(steps: SetupStep[]): { done: number; total: number; complete: boolean } {
  const required = steps.filter((s) => !s.optional);
  const done = required.filter((s) => s.done).length;
  return { done, total: required.length, complete: done === required.length };
}

/** The checklist shows until it is dismissed or every required step is done. */
export function showSetupChecklist(opts: { dismissedAt: string | null; isAdmin: boolean; steps: SetupStep[] | null }): boolean {
  if (opts.dismissedAt || !opts.isAdmin || !opts.steps) return false;
  return !setupProgress(opts.steps).complete;
}
