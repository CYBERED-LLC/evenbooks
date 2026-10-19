import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';

/**
 * Payment processor adapter (Stripe Connect, Standard accounts, direct charges).
 *
 * Design notes (docs/payments-plan.md):
 *  - Evenbooks never holds funds. Every charge, refund and payout call carries the
 *    connected account id; the platform key only authorizes acting on its behalf.
 *  - The adapter returns narrow, provider-neutral shapes. Services never see
 *    Stripe types, and the fixture driver produces the same shapes so the whole
 *    ledger path is testable without network access.
 *  - Amounts cross this boundary as decimal strings in major units; conversion
 *    to Stripe's integer minor units happens here, per currency.
 */

export type PaymentMethodKind = 'card' | 'ach';

export interface ProcessorAccount {
  id: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  displayName: string | null;
  email: string | null;
  /** Stripe: requirements.disabled_reason, when the account is restricted. */
  disabledReason: string | null;
  /** Settlement currency (upper case), when the provider reports one. */
  defaultCurrency: string | null;
}

export interface LinkUrlInput {
  /** Opaque value the provider echoes back to the callback (CSRF protection). */
  state: string;
  redirectUri: string;
  /** Prefills the provider's sign-up form if the business has no account after all. */
  email: string | null;
  businessName: string;
}

export interface CreateCheckoutInput {
  accountId: string;
  amount: string;
  currency: string;
  methods: PaymentMethodKind[];
  /** Evenbooks' application fee in major units ("0" for none). */
  applicationFee: string;
  description: string;
  statementDescriptorSuffix?: string | null;
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  /** Stable per Evenbooks charge row so a retried request cannot open two sessions. */
  idempotencyKey: string;
  /** Sessions expire after this many minutes (Stripe minimum 30). */
  expiresInMinutes?: number;
}

export interface CheckoutSession {
  id: string;
  url: string;
  paymentIntentId: string | null;
  expiresAt: string;
}

export interface ProcessorCharge {
  paymentIntentId: string;
  chargeId: string | null;
  status: 'requires_payment_method' | 'requires_confirmation' | 'requires_action' | 'processing' | 'requires_capture' | 'canceled' | 'succeeded';
  amount: string;
  amountReceived: string;
  currency: string;
  method: PaymentMethodKind | 'unknown';
  /** Stripe's own fee (fee_details type stripe_fee), major units. */
  processorFee: string;
  /** Evenbooks' application fee actually collected, major units. */
  applicationFee: string;
  /**
   * The balance transaction that carries the fees. Stripe attaches it a few
   * seconds after the charge succeeds (announced by charge.updated); until then
   * it is null and both fees read as zero, which means "not known yet".
   */
  balanceTransactionId: string | null;
  /** When the charge was created (unix seconds). */
  createdAt: number;
  description: string | null;
  payerEmail: string | null;
  metadata: Record<string, string>;
  amountRefunded: string;
  failureMessage: string | null;
}

export interface CreateRefundInput {
  accountId: string;
  paymentIntentId: string;
  amount: string;
  currency: string;
  /** Return this much of the application fee to the connected account (major units). */
  applicationFeeRefund: string;
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface ProcessorRefund {
  id: string;
  paymentIntentId: string | null;
  chargeId: string | null;
  amount: string;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'requires_action';
  reason: string | null;
  metadata: Record<string, string>;
  createdAt: number;
  failureReason: string | null;
}

export interface ProcessorPayout {
  id: string;
  amount: string;
  currency: string;
  status: 'paid' | 'pending' | 'in_transit' | 'canceled' | 'failed';
  arrivalDate: number;
  description: string | null;
  failureMessage: string | null;
}

export interface ProcessorDispute {
  id: string;
  chargeId: string | null;
  paymentIntentId: string | null;
  amount: string;
  currency: string;
  status: string;
  reason: string | null;
  /** Dispute fee withdrawn with the funds (major units), 0 when unknown. */
  fee: string;
  createdAt: number;
}

/** Provider-neutral webhook event. `object` is the provider's raw data object. */
export interface ProcessorEvent {
  id: string;
  type: string;
  accountId: string | null;
  createdAt: number;
  object: Record<string, unknown>;
  livemode: boolean;
  raw: Record<string, unknown>;
}

export class PaymentProcessorError extends Error {
  constructor(
    message: string,
    public readonly kind: 'invalid_signature' | 'not_found' | 'invalid_request' | 'rate_limited' | 'network' | 'provider' | 'unsupported',
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'PaymentProcessorError';
  }
}

export interface PaymentProcessorClient {
  readonly driver: 'stripe' | 'fixture' | 'off';
  readonly provider: 'stripe';
  createConnectedAccount(input: { email: string | null; businessName: string; country?: string }): Promise<ProcessorAccount>;
  createOnboardingLink(input: { accountId: string; returnUrl: string; refreshUrl: string }): Promise<{ url: string; expiresAt: string }>;
  retrieveAccount(accountId: string): Promise<ProcessorAccount>;
  /** Whether an existing provider account can be linked (Stripe: Connect OAuth client id configured). */
  readonly supportsLinking: boolean;
  /** Where to send the administrator to sign in to their existing account and authorize the platform. */
  createLinkUrl(input: LinkUrlInput): string;
  /** Exchange the authorization code from the link callback for the account id. */
  completeLink(code: string): Promise<{ accountId: string }>;
  /** Available plus pending balance in `currency`, major units. */
  retrieveBalance(accountId: string, currency: string): Promise<string>;
  createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSession>;
  retrieveCheckoutSession(accountId: string, sessionId: string): Promise<{ id: string; paymentIntentId: string | null; status: 'open' | 'complete' | 'expired'; paymentStatus: 'paid' | 'unpaid' | 'no_payment_required' }>;
  expireCheckoutSession(accountId: string, sessionId: string): Promise<void>;
  retrievePaymentIntent(accountId: string, paymentIntentId: string): Promise<ProcessorCharge>;
  createRefund(input: CreateRefundInput): Promise<ProcessorRefund>;
  retrieveRefund(accountId: string, refundId: string): Promise<ProcessorRefund>;
  retrievePayout(accountId: string, payoutId: string): Promise<ProcessorPayout>;
  retrieveDispute(accountId: string, disputeId: string): Promise<ProcessorDispute>;
  /** Verify and parse a webhook delivery. Throws PaymentProcessorError('invalid_signature'). */
  constructEvent(rawBody: string, signature: string | null): ProcessorEvent;
  /** Where the connected business manages its Stripe account. */
  dashboardUrl(accountId: string): string;
}

// ---------------------------------------------------------------------------
// Minor-unit conversion (per currency; no two-decimal assumptions)
// ---------------------------------------------------------------------------
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
function minorUnitsFor(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}
export function toMinor(amount: string, currency: string): number {
  if (!/^-?\d+(\.\d+)?$/.test(amount)) throw new PaymentProcessorError(`Invalid amount ${amount}`, 'invalid_request');
  const scale = minorUnitsFor(currency);
  const neg = amount.startsWith('-');
  const [intPart = '0', frac = ''] = amount.replace('-', '').split('.');
  if (frac.replace(/0+$/, '').length > scale) throw new PaymentProcessorError(`Amount ${amount} has more precision than ${currency} allows`, 'invalid_request');
  const digits = intPart + frac.padEnd(scale, '0').slice(0, scale);
  const n = Number(digits.replace(/^0+(?=\d)/, ''));
  if (!Number.isSafeInteger(n)) throw new PaymentProcessorError('Amount too large', 'invalid_request');
  return neg ? -n : n;
}
export function fromMinor(minor: number | null | undefined, currency: string): string {
  const scale = minorUnitsFor(currency);
  const n = minor ?? 0;
  const neg = n < 0;
  const s = String(Math.abs(n)).padStart(scale + 1, '0');
  const int = s.slice(0, s.length - scale) || '0';
  const frac = scale ? '.' + s.slice(s.length - scale) : '';
  return `${neg ? '-' : ''}${int}${frac}`;
}

const INTENT_STATUSES: ReadonlySet<string> = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'requires_capture', 'canceled', 'succeeded']);

function metadataOf(m: Stripe.Metadata | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m ?? {})) if (typeof v === 'string') out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Live driver
// ---------------------------------------------------------------------------
export interface StripeClientOptions {
  secretKey: string;
  webhookSecret: string | null;
  /** Ignore events whose livemode differs (test events against production and vice versa). */
  livemode?: boolean | null;
  /** Connect OAuth client id (ca_…); linking existing accounts is off without it. */
  connectClientId?: string | null;
  /**
   * Secret key for the OAuth code exchange. Stripe refuses restricted keys at
   * connect.stripe.com/oauth/token, so a deployment on a restricted key needs
   * the full secret key here (used for nothing else). Defaults to secretKey.
   */
  oauthSecretKey?: string | null;
}

export class StripePaymentProcessor implements PaymentProcessorClient {
  readonly driver = 'stripe' as const;
  readonly provider = 'stripe' as const;
  private readonly stripe: Stripe;

  constructor(private readonly opts: StripeClientOptions) {
    this.stripe = new Stripe(opts.secretKey, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: 'Evenbooks', url: 'https://evenbooks.org' } });
  }

  private wrap<T>(p: Promise<T>): Promise<T> {
    return p.catch((err: unknown) => {
      if (err instanceof Stripe.errors.StripeError) {
        const kind: PaymentProcessorError['kind'] =
          err.type === 'StripeRateLimitError' ? 'rate_limited'
          : err.type === 'StripeConnectionError' || err.type === 'StripeAPIError' ? 'network'
          : err.statusCode === 404 || err.code === 'resource_missing' ? 'not_found'
          : err.type === 'StripeInvalidRequestError' ? 'invalid_request'
          : 'provider';
        throw new PaymentProcessorError(err.message, kind, err.statusCode);
      }
      throw err;
    });
  }

  private account(accountId: string): Stripe.RequestOptions {
    return { stripeAccount: accountId };
  }

  private toAccount(a: Stripe.Account): ProcessorAccount {
    return {
      id: a.id,
      chargesEnabled: Boolean(a.charges_enabled),
      payoutsEnabled: Boolean(a.payouts_enabled),
      detailsSubmitted: Boolean(a.details_submitted),
      displayName: a.business_profile?.name ?? a.settings?.dashboard?.display_name ?? null,
      email: a.email ?? null,
      disabledReason: a.requirements?.disabled_reason ?? null,
      defaultCurrency: a.default_currency ? a.default_currency.toUpperCase() : null,
    };
  }

  async createConnectedAccount(input: { email: string | null; businessName: string; country?: string }): Promise<ProcessorAccount> {
    const a = await this.wrap(
      this.stripe.accounts.create({
        type: 'standard',
        country: input.country ?? 'US',
        email: input.email ?? undefined,
        business_profile: { name: input.businessName.slice(0, 100) },
        metadata: { source: 'evenbooks' },
      }),
    );
    return this.toAccount(a);
  }

  async createOnboardingLink(input: { accountId: string; returnUrl: string; refreshUrl: string }): Promise<{ url: string; expiresAt: string }> {
    const link = await this.wrap(this.stripe.accountLinks.create({ account: input.accountId, return_url: input.returnUrl, refresh_url: input.refreshUrl, type: 'account_onboarding' }));
    return { url: link.url, expiresAt: new Date(link.expires_at * 1000).toISOString() };
  }

  async retrieveAccount(accountId: string): Promise<ProcessorAccount> {
    return this.toAccount(await this.wrap(this.stripe.accounts.retrieve(accountId)));
  }

  get supportsLinking(): boolean {
    return Boolean(this.opts.connectClientId);
  }

  createLinkUrl(input: LinkUrlInput): string {
    if (!this.opts.connectClientId) throw new PaymentProcessorError('STRIPE_CONNECT_CLIENT_ID is not configured', 'unsupported', 501);
    return this.stripe.oauth.authorizeUrl({
      response_type: 'code',
      client_id: this.opts.connectClientId,
      scope: 'read_write',
      redirect_uri: input.redirectUri,
      state: input.state,
      // Start on Stripe's sign-in page: the point of this path is an account the business already has.
      stripe_landing: 'login',
      stripe_user: { email: input.email ?? undefined, business_name: input.businessName.slice(0, 100) },
    });
  }

  async completeLink(code: string): Promise<{ accountId: string }> {
    const token = await this.wrap(this.stripe.oauth.token({ grant_type: 'authorization_code', code }, this.opts.oauthSecretKey ? { apiKey: this.opts.oauthSecretKey } : undefined));
    if (!token.stripe_user_id) throw new PaymentProcessorError('Stripe did not return an account id', 'provider');
    if (this.opts.livemode != null && token.livemode !== this.opts.livemode) {
      throw new PaymentProcessorError(`Stripe authorized a ${token.livemode ? 'live' : 'test'} account; this deployment expects the other mode`, 'invalid_request');
    }
    return { accountId: token.stripe_user_id };
  }

  async retrieveBalance(accountId: string, currency: string): Promise<string> {
    const cur = currency.toLowerCase();
    const b = await this.wrap(this.stripe.balance.retrieve({}, this.account(accountId)));
    const minor = [...b.available, ...b.pending].filter((x) => x.currency === cur).reduce((acc, x) => acc + x.amount, 0);
    return fromMinor(minor, currency);
  }

  async createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const currency = input.currency.toLowerCase();
    const types: Stripe.Checkout.SessionCreateParams.PaymentMethodType[] = [];
    if (input.methods.includes('card')) types.push('card');
    if (input.methods.includes('ach')) types.push('us_bank_account');
    if (types.length === 0) throw new PaymentProcessorError('At least one payment method is required', 'invalid_request');
    const fee = toMinor(input.applicationFee, input.currency);
    const expiresIn = Math.max(30, Math.min(24 * 60, input.expiresInMinutes ?? 60));
    const session = await this.wrap(
      this.stripe.checkout.sessions.create(
        {
          mode: 'payment',
          payment_method_types: types,
          ...(types.includes('us_bank_account') ? { payment_method_options: { us_bank_account: { verification_method: 'automatic' } } } : {}),
          line_items: [{ quantity: 1, price_data: { currency, unit_amount: toMinor(input.amount, input.currency), product_data: { name: input.description.slice(0, 250) } } }],
          customer_email: input.customerEmail ?? undefined,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          expires_at: Math.floor(Date.now() / 1000) + expiresIn * 60,
          metadata: input.metadata,
          payment_intent_data: {
            ...(fee > 0 ? { application_fee_amount: fee } : {}),
            description: input.description.slice(0, 1000),
            metadata: input.metadata,
            ...(input.statementDescriptorSuffix ? { statement_descriptor_suffix: input.statementDescriptorSuffix.slice(0, 22) } : {}),
          },
        },
        { ...this.account(input.accountId), idempotencyKey: input.idempotencyKey },
      ),
    );
    if (!session.url) throw new PaymentProcessorError('Checkout session has no URL', 'provider');
    return {
      id: session.id,
      url: session.url,
      paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null,
      expiresAt: new Date(session.expires_at * 1000).toISOString(),
    };
  }

  async retrieveCheckoutSession(accountId: string, sessionId: string) {
    const s = await this.wrap(this.stripe.checkout.sessions.retrieve(sessionId, {}, this.account(accountId)));
    return {
      id: s.id,
      paymentIntentId: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id ?? null,
      status: (s.status ?? 'open') as 'open' | 'complete' | 'expired',
      paymentStatus: (['paid', 'unpaid', 'no_payment_required'].includes(s.payment_status) ? s.payment_status : 'unpaid') as 'paid' | 'unpaid' | 'no_payment_required',
    };
  }

  async expireCheckoutSession(accountId: string, sessionId: string): Promise<void> {
    await this.wrap(this.stripe.checkout.sessions.expire(sessionId, {}, this.account(accountId))).catch((err: PaymentProcessorError) => {
      if (err.kind === 'invalid_request') return; // already complete/expired
      throw err;
    });
  }

  private toCharge(pi: Stripe.PaymentIntent): ProcessorCharge {
    const charge = pi.latest_charge && typeof pi.latest_charge !== 'string' ? pi.latest_charge : null;
    const bt = charge?.balance_transaction && typeof charge.balance_transaction !== 'string' ? charge.balance_transaction : null;
    const cur = pi.currency.toUpperCase();
    let processorFee = 0;
    let applicationFee = 0;
    for (const d of bt?.fee_details ?? []) {
      if (d.type === 'application_fee') applicationFee += d.amount;
      else processorFee += d.amount;
    }
    const pmType = charge?.payment_method_details?.type;
    const method: ProcessorCharge['method'] = pmType === 'card' ? 'card' : pmType === 'us_bank_account' ? 'ach' : 'unknown';
    return {
      paymentIntentId: pi.id,
      chargeId: charge?.id ?? (typeof pi.latest_charge === 'string' ? pi.latest_charge : null),
      status: INTENT_STATUSES.has(pi.status) ? (pi.status as ProcessorCharge['status']) : 'requires_payment_method',
      amount: fromMinor(pi.amount, cur),
      amountReceived: fromMinor(pi.amount_received, cur),
      currency: cur,
      method,
      processorFee: fromMinor(processorFee, cur),
      applicationFee: fromMinor(applicationFee, cur),
      balanceTransactionId: bt?.id ?? (typeof charge?.balance_transaction === 'string' ? charge.balance_transaction : null),
      createdAt: charge?.created ?? pi.created,
      description: pi.description ?? charge?.description ?? null,
      payerEmail: charge?.billing_details?.email ?? pi.receipt_email ?? null,
      metadata: metadataOf(pi.metadata),
      amountRefunded: fromMinor(charge?.amount_refunded ?? 0, cur),
      failureMessage: charge?.failure_message ?? pi.last_payment_error?.message ?? null,
    };
  }

  async retrievePaymentIntent(accountId: string, paymentIntentId: string): Promise<ProcessorCharge> {
    const pi = await this.wrap(this.stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge.balance_transaction'] }, this.account(accountId)));
    return this.toCharge(pi);
  }

  private toRefund(r: Stripe.Refund): ProcessorRefund {
    const cur = r.currency.toUpperCase();
    return {
      id: r.id,
      paymentIntentId: typeof r.payment_intent === 'string' ? r.payment_intent : r.payment_intent?.id ?? null,
      chargeId: typeof r.charge === 'string' ? r.charge : r.charge?.id ?? null,
      amount: fromMinor(r.amount, cur),
      currency: cur,
      status: (r.status ?? 'pending') as ProcessorRefund['status'],
      reason: r.reason ?? null,
      metadata: metadataOf(r.metadata),
      createdAt: r.created,
      failureReason: r.failure_reason ?? null,
    };
  }

  async createRefund(input: CreateRefundInput): Promise<ProcessorRefund> {
    const feeRefund = toMinor(input.applicationFeeRefund, input.currency);
    const r = await this.wrap(
      this.stripe.refunds.create(
        {
          payment_intent: input.paymentIntentId,
          amount: toMinor(input.amount, input.currency),
          // Return Evenbooks' share proportionally: the whole fee when refund_application_fee is true, else none.
          // Partial application-fee refunds are done separately below.
          refund_application_fee: false,
          reason: input.reason,
          metadata: input.metadata,
        },
        { ...this.account(input.accountId), idempotencyKey: input.idempotencyKey },
      ),
    );
    if (feeRefund > 0) {
      // Application fees live on the platform account: refund our share explicitly.
      const pi = await this.wrap(this.stripe.paymentIntents.retrieve(input.paymentIntentId, { expand: ['latest_charge'] }, this.account(input.accountId)));
      const charge = pi.latest_charge && typeof pi.latest_charge !== 'string' ? pi.latest_charge : null;
      const appFeeId = typeof charge?.application_fee === 'string' ? charge.application_fee : charge?.application_fee?.id ?? null;
      if (appFeeId) {
        await this.wrap(this.stripe.applicationFees.createRefund(appFeeId, { amount: feeRefund, metadata: input.metadata }, { idempotencyKey: `${input.idempotencyKey}:appfee` })).catch((err: PaymentProcessorError) => {
          // A fee refund failure must not hide the customer refund that already succeeded.
          if (err.kind === 'invalid_request') return;
          throw err;
        });
      }
    }
    return this.toRefund(r);
  }

  async retrieveRefund(accountId: string, refundId: string): Promise<ProcessorRefund> {
    return this.toRefund(await this.wrap(this.stripe.refunds.retrieve(refundId, {}, this.account(accountId))));
  }

  async retrievePayout(accountId: string, payoutId: string): Promise<ProcessorPayout> {
    const p = await this.wrap(this.stripe.payouts.retrieve(payoutId, {}, this.account(accountId)));
    const cur = p.currency.toUpperCase();
    return { id: p.id, amount: fromMinor(p.amount, cur), currency: cur, status: p.status as ProcessorPayout['status'], arrivalDate: p.arrival_date, description: p.description ?? null, failureMessage: p.failure_message ?? null };
  }

  async retrieveDispute(accountId: string, disputeId: string): Promise<ProcessorDispute> {
    const d = await this.wrap(this.stripe.disputes.retrieve(disputeId, { expand: ['balance_transactions'] }, this.account(accountId)));
    const cur = d.currency.toUpperCase();
    let fee = 0;
    for (const bt of d.balance_transactions ?? []) fee += bt.fee;
    return {
      id: d.id,
      chargeId: typeof d.charge === 'string' ? d.charge : d.charge?.id ?? null,
      paymentIntentId: typeof d.payment_intent === 'string' ? d.payment_intent : d.payment_intent?.id ?? null,
      amount: fromMinor(d.amount, cur),
      currency: cur,
      status: d.status,
      reason: d.reason ?? null,
      fee: fromMinor(fee, cur),
      createdAt: d.created,
    };
  }

  constructEvent(rawBody: string, signature: string | null): ProcessorEvent {
    if (!this.opts.webhookSecret) throw new PaymentProcessorError('STRIPE_WEBHOOK_SECRET is not configured', 'invalid_signature');
    if (!signature) throw new PaymentProcessorError('Missing Stripe-Signature header', 'invalid_signature');
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.opts.webhookSecret);
    } catch (err) {
      throw new PaymentProcessorError((err as Error).message, 'invalid_signature');
    }
    if (this.opts.livemode != null && event.livemode !== this.opts.livemode) {
      throw new PaymentProcessorError(`Event livemode=${event.livemode} does not match this deployment`, 'invalid_signature');
    }
    return normalizeStripeEvent(event as unknown as Record<string, unknown>);
  }

  dashboardUrl(accountId: string): string {
    return `https://dashboard.stripe.com/${encodeURIComponent(accountId)}`;
  }
}

/** Turn a Stripe event JSON (live or fixture-generated) into the neutral shape. */
export function normalizeStripeEvent(raw: Record<string, unknown>): ProcessorEvent {
  const data = (raw.data as { object?: Record<string, unknown> } | undefined) ?? {};
  if (typeof raw.id !== 'string' || typeof raw.type !== 'string' || !data.object || typeof data.object !== 'object') {
    throw new PaymentProcessorError('Malformed event', 'invalid_request');
  }
  return {
    id: raw.id,
    type: raw.type,
    accountId: typeof raw.account === 'string' ? raw.account : null,
    createdAt: typeof raw.created === 'number' ? raw.created : Math.floor(Date.now() / 1000),
    object: data.object,
    livemode: Boolean(raw.livemode),
    raw,
  };
}

// ---------------------------------------------------------------------------
// Fixture driver: in-memory Stripe stand-in for development and tests
// ---------------------------------------------------------------------------
interface FixtureSession {
  id: string;
  accountId: string;
  paymentIntentId: string;
  amount: number;
  currency: string;
  applicationFee: number;
  methods: PaymentMethodKind[];
  metadata: Record<string, string>;
  description: string;
  customerEmail: string | null;
  successUrl: string;
  cancelUrl: string;
  status: 'open' | 'complete' | 'expired';
  paymentStatus: 'paid' | 'unpaid';
  expiresAt: number;
}
interface FixtureIntent {
  id: string;
  accountId: string;
  chargeId: string | null;
  status: ProcessorCharge['status'];
  amount: number;
  amountReceived: number;
  currency: string;
  method: PaymentMethodKind | 'unknown';
  processorFee: number;
  applicationFee: number;
  applicationFeeRefunded: number;
  balanceTransactionId: string | null;
  createdAt: number;
  description: string | null;
  payerEmail: string | null;
  metadata: Record<string, string>;
  amountRefunded: number;
  failureMessage: string | null;
}

/** Stripe-like fee schedule so fixture books look realistic: cards 2.9% + 30c, ACH 0.8% capped at $5. */
export function fixtureProcessorFee(amountMinor: number, method: PaymentMethodKind): number {
  if (method === 'ach') return Math.min(Math.round(amountMinor * 0.008), 500);
  return Math.round(amountMinor * 0.029) + 30;
}

export class FixturePaymentProcessor implements PaymentProcessorClient {
  readonly driver = 'fixture' as const;
  readonly provider = 'stripe' as const;
  accounts = new Map<string, ProcessorAccount>();
  sessions = new Map<string, FixtureSession>();
  intents = new Map<string, FixtureIntent>();
  refunds = new Map<string, ProcessorRefund & { accountId: string; applicationFeeRefund: number }>();
  payouts = new Map<string, ProcessorPayout & { accountId: string }>();
  disputes = new Map<string, ProcessorDispute & { accountId: string }>();
  /** Every event this driver has produced; tests feed them to the webhook route/ingest service. */
  events: ProcessorEvent[] = [];
  /**
   * Behave like live Stripe: a succeeded charge has no balance transaction (and
   * so no fees) until attachBalanceTransaction() emits charge.updated.
   */
  deferBalanceTransactions = false;
  private seq = 0;

  constructor(private readonly publicBaseUrl = 'http://localhost:3000') {}

  private nextId(prefix: string): string {
    this.seq++;
    return `${prefix}_fx${this.seq.toString(36)}${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  }

  private requireAccount(accountId: string): ProcessorAccount {
    const a = this.accounts.get(accountId);
    if (!a) throw new PaymentProcessorError(`No such account: ${accountId}`, 'not_found', 404);
    return a;
  }

  /** Build a Stripe-shaped event, remember it, and return the neutral form. */
  emit(type: string, accountId: string, object: Record<string, unknown>): ProcessorEvent {
    const raw = { id: this.nextId('evt'), object: 'event', type, account: accountId, created: Math.floor(Date.now() / 1000), livemode: false, data: { object } };
    const evt = normalizeStripeEvent(raw);
    this.events.push(evt);
    return evt;
  }

  async createConnectedAccount(input: { email: string | null; businessName: string }): Promise<ProcessorAccount> {
    const a: ProcessorAccount = { id: this.nextId('acct'), chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false, displayName: input.businessName, email: input.email, disabledReason: 'requirements.past_due', defaultCurrency: 'USD' };
    this.accounts.set(a.id, a);
    return a;
  }

  readonly supportsLinking = true;
  /** Authorization codes handed out by authorizeLink(), redeemable once. */
  linkCodes = new Map<string, string>();
  /** Balances of accounts that existed before they were linked (major units, per currency). */
  balances = new Map<string, Map<string, string>>();

  createLinkUrl(input: LinkUrlInput): string {
    const u = new URL(`${this.publicBaseUrl}/pay/fixture/link`);
    u.searchParams.set('state', input.state);
    u.searchParams.set('redirect_uri', input.redirectUri);
    return u.toString();
  }

  /**
   * Simulate the business signing in to an existing, fully onboarded Stripe
   * account and authorizing the platform. Returns the code the callback gets.
   */
  authorizeLink(opts: { accountId?: string; displayName?: string; currency?: string; balance?: string; chargesEnabled?: boolean } = {}): { code: string; accountId: string } {
    const id = opts.accountId ?? this.nextId('acct');
    if (!this.accounts.has(id)) {
      const enabled = opts.chargesEnabled ?? true;
      this.accounts.set(id, { id, chargesEnabled: enabled, payoutsEnabled: enabled, detailsSubmitted: true, displayName: opts.displayName ?? 'Existing Stripe business', email: null, disabledReason: enabled ? null : 'requirements.past_due', defaultCurrency: (opts.currency ?? 'USD').toUpperCase() });
    }
    if (opts.balance) this.balances.set(id, new Map([[(opts.currency ?? 'USD').toUpperCase(), opts.balance]]));
    const code = this.nextId('ac');
    this.linkCodes.set(code, id);
    return { code, accountId: id };
  }

  async completeLink(code: string): Promise<{ accountId: string }> {
    const accountId = this.linkCodes.get(code);
    if (!accountId) throw new PaymentProcessorError('Authorization code does not exist or was already used', 'invalid_request', 400);
    this.linkCodes.delete(code);
    return { accountId };
  }

  async retrieveBalance(accountId: string, currency: string): Promise<string> {
    this.requireAccount(accountId);
    return this.balances.get(accountId)?.get(currency.toUpperCase()) ?? fromMinor(0, currency);
  }

  /** Simulate the business revoking Evenbooks' access from their Stripe dashboard. */
  deauthorize(accountId: string): ProcessorEvent {
    this.requireAccount(accountId);
    return this.emit('account.application.deauthorized', accountId, { id: 'ca_fixture', object: 'application', name: 'Evenbooks' });
  }

  async createOnboardingLink(input: { accountId: string; returnUrl: string }): Promise<{ url: string; expiresAt: string }> {
    this.requireAccount(input.accountId);
    const u = new URL(`${this.publicBaseUrl}/pay/fixture/onboard`);
    u.searchParams.set('account', input.accountId);
    u.searchParams.set('return', input.returnUrl);
    return { url: u.toString(), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
  }

  /** Simulate the business finishing Stripe onboarding. */
  completeOnboarding(accountId: string): ProcessorEvent {
    const a = this.requireAccount(accountId);
    const updated = { ...a, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, disabledReason: null };
    this.accounts.set(accountId, updated);
    return this.emit('account.updated', accountId, this.accountObject(updated));
  }

  /** Simulate Stripe restricting the account (e.g. missing information). */
  restrictAccount(accountId: string, reason = 'requirements.past_due'): ProcessorEvent {
    const a = this.requireAccount(accountId);
    const updated = { ...a, chargesEnabled: false, payoutsEnabled: false, disabledReason: reason };
    this.accounts.set(accountId, updated);
    return this.emit('account.updated', accountId, this.accountObject(updated));
  }

  private accountObject(a: ProcessorAccount): Record<string, unknown> {
    return { id: a.id, object: 'account', charges_enabled: a.chargesEnabled, payouts_enabled: a.payoutsEnabled, details_submitted: a.detailsSubmitted, business_profile: { name: a.displayName }, email: a.email, requirements: { disabled_reason: a.disabledReason }, default_currency: a.defaultCurrency?.toLowerCase() ?? null };
  }

  async retrieveAccount(accountId: string): Promise<ProcessorAccount> {
    return this.requireAccount(accountId);
  }

  async createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSession> {
    this.requireAccount(input.accountId);
    // idempotency: same key returns the same session
    for (const s of this.sessions.values()) if (s.metadata.__idem === input.idempotencyKey) return this.sessionOut(s);
    const id = this.nextId('cs');
    const piId = this.nextId('pi');
    const s: FixtureSession = {
      id,
      accountId: input.accountId,
      paymentIntentId: piId,
      amount: toMinor(input.amount, input.currency),
      currency: input.currency.toUpperCase(),
      applicationFee: toMinor(input.applicationFee, input.currency),
      methods: input.methods,
      metadata: { ...input.metadata, __idem: input.idempotencyKey },
      description: input.description,
      customerEmail: input.customerEmail ?? null,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      status: 'open',
      paymentStatus: 'unpaid',
      expiresAt: Math.floor(Date.now() / 1000) + Math.max(30, input.expiresInMinutes ?? 60) * 60,
    };
    this.sessions.set(id, s);
    this.intents.set(piId, {
      id: piId,
      accountId: input.accountId,
      chargeId: null,
      status: 'requires_payment_method',
      amount: s.amount,
      amountReceived: 0,
      currency: s.currency,
      method: 'unknown',
      processorFee: 0,
      applicationFee: 0,
      applicationFeeRefunded: 0,
      balanceTransactionId: null,
      createdAt: Math.floor(Date.now() / 1000),
      description: input.description,
      payerEmail: s.customerEmail,
      metadata: input.metadata,
      amountRefunded: 0,
      failureMessage: null,
    });
    return this.sessionOut(s);
  }

  private sessionOut(s: FixtureSession): CheckoutSession {
    return { id: s.id, url: `${this.publicBaseUrl}/pay/fixture/${s.id}`, paymentIntentId: s.paymentIntentId, expiresAt: new Date(s.expiresAt * 1000).toISOString() };
  }

  async retrieveCheckoutSession(accountId: string, sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s || s.accountId !== accountId) throw new PaymentProcessorError('No such session', 'not_found', 404);
    return { id: s.id, paymentIntentId: s.paymentIntentId, status: s.status, paymentStatus: s.paymentStatus as 'paid' | 'unpaid' };
  }

  async expireCheckoutSession(accountId: string, sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || s.accountId !== accountId) throw new PaymentProcessorError('No such session', 'not_found', 404);
    if (s.status === 'open') {
      s.status = 'expired';
      this.emit('checkout.session.expired', s.accountId, this.sessionObject(s));
    }
  }

  private sessionObject(s: FixtureSession): Record<string, unknown> {
    const { __idem: _omit, ...metadata } = s.metadata;
    return { id: s.id, object: 'checkout.session', payment_intent: s.paymentIntentId, status: s.status, payment_status: s.paymentStatus, amount_total: s.amount, currency: s.currency.toLowerCase(), metadata, customer_details: { email: s.customerEmail } };
  }

  private intentObject(pi: FixtureIntent): Record<string, unknown> {
    return { id: pi.id, object: 'payment_intent', status: pi.status, amount: pi.amount, amount_received: pi.amountReceived, currency: pi.currency.toLowerCase(), latest_charge: pi.chargeId, metadata: pi.metadata, description: pi.description };
  }

  /**
   * Customer pays. Cards settle immediately (session completed + paid); ACH
   * completes the session unpaid and settles (or fails) later via `settleAch`.
   */
  completeCheckout(sessionId: string, opts: { method?: PaymentMethodKind; payerEmail?: string | null } = {}): ProcessorEvent[] {
    const s = this.sessions.get(sessionId);
    if (!s) throw new PaymentProcessorError('No such session', 'not_found', 404);
    if (s.status !== 'open') throw new PaymentProcessorError(`Session is ${s.status}`, 'invalid_request');
    const method = opts.method ?? (s.methods.includes('card') ? 'card' : 'ach');
    if (!s.methods.includes(method)) throw new PaymentProcessorError(`Method ${method} not allowed on this session`, 'invalid_request');
    const pi = this.intents.get(s.paymentIntentId)!;
    pi.method = method;
    pi.payerEmail = opts.payerEmail ?? pi.payerEmail;
    pi.chargeId = this.nextId('ch');
    s.status = 'complete';
    const out: ProcessorEvent[] = [];
    if (method === 'card') {
      this.settle(pi);
      s.paymentStatus = 'paid';
      out.push(this.emit('checkout.session.completed', s.accountId, this.sessionObject(s)));
      out.push(this.emit('payment_intent.succeeded', s.accountId, this.intentObject(pi)));
    } else {
      pi.status = 'processing';
      s.paymentStatus = 'unpaid';
      out.push(this.emit('checkout.session.completed', s.accountId, this.sessionObject(s)));
    }
    return out;
  }

  private settle(pi: FixtureIntent) {
    pi.status = 'succeeded';
    pi.amountReceived = pi.amount;
    pi.processorFee = fixtureProcessorFee(pi.amount, pi.method === 'ach' ? 'ach' : 'card');
    const session = [...this.sessions.values()].find((x) => x.paymentIntentId === pi.id);
    pi.applicationFee = session?.applicationFee ?? 0;
    pi.balanceTransactionId = this.deferBalanceTransactions ? null : this.nextId('txn');
    pi.createdAt = Math.floor(Date.now() / 1000);
  }

  /** Stripe attaching the fees to a succeeded charge (live Stripe does this seconds later). */
  attachBalanceTransaction(paymentIntentId: string): ProcessorEvent[] {
    const pi = this.intents.get(paymentIntentId);
    if (!pi || pi.status !== 'succeeded') throw new PaymentProcessorError('No succeeded payment intent', 'invalid_request');
    if (pi.balanceTransactionId) return [];
    pi.balanceTransactionId = this.nextId('txn');
    return [this.emit('charge.updated', pi.accountId, { ...this.chargeObject(pi), balance_transaction: pi.balanceTransactionId })];
  }

  /** ACH settles days later: succeed or fail the pending debit. */
  settleAch(sessionId: string, outcome: 'succeeded' | 'failed', failureMessage = 'The bank account has insufficient funds.'): ProcessorEvent[] {
    const s = this.sessions.get(sessionId);
    if (!s) throw new PaymentProcessorError('No such session', 'not_found', 404);
    const pi = this.intents.get(s.paymentIntentId)!;
    if (pi.status !== 'processing') throw new PaymentProcessorError(`Payment is ${pi.status}`, 'invalid_request');
    if (outcome === 'succeeded') {
      this.settle(pi);
      s.paymentStatus = 'paid';
      return [this.emit('checkout.session.async_payment_succeeded', s.accountId, this.sessionObject(s)), this.emit('payment_intent.succeeded', s.accountId, this.intentObject(pi))];
    }
    pi.status = 'requires_payment_method';
    pi.failureMessage = failureMessage;
    return [this.emit('checkout.session.async_payment_failed', s.accountId, this.sessionObject(s)), this.emit('payment_intent.payment_failed', s.accountId, this.intentObject(pi))];
  }

  /** A charge made outside Evenbooks (dashboard, payment link) on the connected account. */
  externalCharge(accountId: string, amount: string, currency: string, opts: { description?: string; method?: PaymentMethodKind; payerEmail?: string | null } = {}): ProcessorEvent {
    this.requireAccount(accountId);
    const pi: FixtureIntent = {
      id: this.nextId('pi'),
      accountId,
      chargeId: this.nextId('ch'),
      status: 'requires_payment_method',
      amount: toMinor(amount, currency),
      amountReceived: 0,
      currency: currency.toUpperCase(),
      method: opts.method ?? 'card',
      processorFee: 0,
      applicationFee: 0,
      applicationFeeRefunded: 0,
      balanceTransactionId: null,
      createdAt: Math.floor(Date.now() / 1000),
      description: opts.description ?? 'Payment link',
      payerEmail: opts.payerEmail ?? null,
      metadata: {},
      amountRefunded: 0,
      failureMessage: null,
    };
    this.intents.set(pi.id, pi);
    this.settle(pi);
    return this.emit('payment_intent.succeeded', accountId, this.intentObject(pi));
  }

  async retrievePaymentIntent(accountId: string, paymentIntentId: string): Promise<ProcessorCharge> {
    const pi = this.intents.get(paymentIntentId);
    if (!pi || pi.accountId !== accountId) throw new PaymentProcessorError('No such payment intent', 'not_found', 404);
    const cur = pi.currency;
    return {
      paymentIntentId: pi.id,
      chargeId: pi.chargeId,
      status: pi.status,
      amount: fromMinor(pi.amount, cur),
      amountReceived: fromMinor(pi.amountReceived, cur),
      currency: cur,
      method: pi.method,
      // like Stripe: no balance transaction yet means no fee details yet
      processorFee: fromMinor(pi.balanceTransactionId ? pi.processorFee : 0, cur),
      applicationFee: fromMinor(pi.balanceTransactionId ? pi.applicationFee : 0, cur),
      balanceTransactionId: pi.balanceTransactionId,
      createdAt: pi.createdAt,
      description: pi.description,
      payerEmail: pi.payerEmail,
      metadata: pi.metadata,
      amountRefunded: fromMinor(pi.amountRefunded, cur),
      failureMessage: pi.failureMessage,
    };
  }

  private chargeObject(pi: FixtureIntent): Record<string, unknown> {
    const refunds = [...this.refunds.values()].filter((r) => r.paymentIntentId === pi.id).map((r) => ({ id: r.id, object: 'refund', amount: toMinor(r.amount, r.currency), currency: r.currency.toLowerCase(), status: r.status, reason: r.reason, metadata: r.metadata, created: r.createdAt, payment_intent: pi.id, charge: pi.chargeId }));
    return { id: pi.chargeId, object: 'charge', payment_intent: pi.id, amount: pi.amount, amount_refunded: pi.amountRefunded, currency: pi.currency.toLowerCase(), refunded: pi.amountRefunded >= pi.amount, refunds: { object: 'list', data: refunds }, metadata: pi.metadata };
  }

  async createRefund(input: CreateRefundInput): Promise<ProcessorRefund> {
    const pi = this.intents.get(input.paymentIntentId);
    if (!pi || pi.accountId !== input.accountId) throw new PaymentProcessorError('No such payment intent', 'not_found', 404);
    for (const r of this.refunds.values()) if (r.metadata.__idem === input.idempotencyKey) return r;
    if (pi.status !== 'succeeded') throw new PaymentProcessorError('Charge has not succeeded', 'invalid_request', 400);
    const amount = toMinor(input.amount, input.currency);
    if (amount <= 0 || amount + pi.amountRefunded > pi.amount) throw new PaymentProcessorError('Refund exceeds the refundable amount', 'invalid_request', 400);
    const r = {
      id: this.nextId('re'),
      accountId: input.accountId,
      paymentIntentId: pi.id,
      chargeId: pi.chargeId,
      amount: fromMinor(amount, pi.currency),
      currency: pi.currency,
      status: 'succeeded' as const,
      reason: input.reason ?? null,
      metadata: { ...input.metadata, __idem: input.idempotencyKey },
      createdAt: Math.floor(Date.now() / 1000),
      failureReason: null,
      applicationFeeRefund: toMinor(input.applicationFeeRefund, input.currency),
    };
    pi.amountRefunded += amount;
    pi.applicationFeeRefunded += r.applicationFeeRefund;
    this.refunds.set(r.id, r);
    this.emit('charge.refunded', input.accountId, this.chargeObject(pi));
    return r;
  }

  /** Refund issued from the Stripe dashboard (not through Evenbooks). */
  externalRefund(accountId: string, paymentIntentId: string, amount: string): ProcessorEvent {
    const pi = this.intents.get(paymentIntentId);
    if (!pi || pi.accountId !== accountId) throw new PaymentProcessorError('No such payment intent', 'not_found', 404);
    const minor = toMinor(amount, pi.currency);
    if (minor + pi.amountRefunded > pi.amount) throw new PaymentProcessorError('Refund exceeds the refundable amount', 'invalid_request', 400);
    const r = { id: this.nextId('re'), accountId, paymentIntentId: pi.id, chargeId: pi.chargeId, amount: fromMinor(minor, pi.currency), currency: pi.currency, status: 'succeeded' as const, reason: 'requested_by_customer', metadata: {}, createdAt: Math.floor(Date.now() / 1000), failureReason: null, applicationFeeRefund: 0 };
    pi.amountRefunded += minor;
    this.refunds.set(r.id, r);
    return this.emit('charge.refunded', accountId, this.chargeObject(pi));
  }

  async retrieveRefund(accountId: string, refundId: string): Promise<ProcessorRefund> {
    const r = this.refunds.get(refundId);
    if (!r || r.accountId !== accountId) throw new PaymentProcessorError('No such refund', 'not_found', 404);
    return r;
  }

  /** Stripe pays the balance out to the bank. */
  payout(accountId: string, amount: string, currency: string, arrivalDate: string, opts: { status?: 'paid' | 'in_transit' | 'pending'; description?: string } = {}): ProcessorEvent {
    this.requireAccount(accountId);
    const p = { id: this.nextId('po'), accountId, amount, currency: currency.toUpperCase(), status: opts.status ?? ('paid' as const), arrivalDate: Math.floor(Date.parse(`${arrivalDate}T00:00:00Z`) / 1000), description: opts.description ?? 'STRIPE PAYOUT', failureMessage: null };
    this.payouts.set(p.id, p);
    return this.emit(`payout.${p.status}`, accountId, this.payoutObject(p));
  }

  failPayout(payoutId: string, message = 'The bank account has been closed.'): ProcessorEvent {
    const p = this.payouts.get(payoutId);
    if (!p) throw new PaymentProcessorError('No such payout', 'not_found', 404);
    p.status = 'failed';
    p.failureMessage = message;
    return this.emit('payout.failed', p.accountId, this.payoutObject(p));
  }

  private payoutObject(p: ProcessorPayout): Record<string, unknown> {
    return { id: p.id, object: 'payout', amount: toMinor(p.amount, p.currency), currency: p.currency.toLowerCase(), status: p.status, arrival_date: p.arrivalDate, description: p.description, failure_message: p.failureMessage };
  }

  async retrievePayout(accountId: string, payoutId: string): Promise<ProcessorPayout> {
    const p = this.payouts.get(payoutId);
    if (!p || p.accountId !== accountId) throw new PaymentProcessorError('No such payout', 'not_found', 404);
    return p;
  }

  /** Customer disputes a charge: funds and a fee are withdrawn. */
  openDispute(accountId: string, paymentIntentId: string, opts: { amount?: string; fee?: string; reason?: string } = {}): ProcessorEvent {
    const pi = this.intents.get(paymentIntentId);
    if (!pi || pi.accountId !== accountId) throw new PaymentProcessorError('No such payment intent', 'not_found', 404);
    const d = { id: this.nextId('dp'), accountId, chargeId: pi.chargeId, paymentIntentId: pi.id, amount: opts.amount ?? fromMinor(pi.amount, pi.currency), currency: pi.currency, status: 'needs_response', reason: opts.reason ?? 'fraudulent', fee: opts.fee ?? '15.00', createdAt: Math.floor(Date.now() / 1000) };
    this.disputes.set(d.id, d);
    return this.emit('charge.dispute.created', accountId, this.disputeObject(d));
  }

  closeDispute(disputeId: string, outcome: 'won' | 'lost'): ProcessorEvent {
    const d = this.disputes.get(disputeId);
    if (!d) throw new PaymentProcessorError('No such dispute', 'not_found', 404);
    d.status = outcome;
    return this.emit('charge.dispute.closed', d.accountId, this.disputeObject(d));
  }

  private disputeObject(d: ProcessorDispute): Record<string, unknown> {
    return { id: d.id, object: 'dispute', charge: d.chargeId, payment_intent: d.paymentIntentId, amount: toMinor(d.amount, d.currency), currency: d.currency.toLowerCase(), status: d.status, reason: d.reason, created: d.createdAt, balance_transactions: [{ fee: toMinor(d.fee, d.currency) }] };
  }

  async retrieveDispute(accountId: string, disputeId: string): Promise<ProcessorDispute> {
    const d = this.disputes.get(disputeId);
    if (!d || d.accountId !== accountId) throw new PaymentProcessorError('No such dispute', 'not_found', 404);
    return d;
  }

  /** Fixture deliveries are unsigned JSON; the route only accepts them outside production. */
  constructEvent(rawBody: string): ProcessorEvent {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new PaymentProcessorError('Malformed JSON', 'invalid_request');
    }
    return normalizeStripeEvent(raw);
  }

  dashboardUrl(accountId: string): string {
    return `${this.publicBaseUrl}/pay/fixture/dashboard?account=${encodeURIComponent(accountId)}`;
  }
}

/**
 * PAYMENTS_DRIVER=off: online payments are not offered on this server. Every
 * call fails with a clear error; the UI checks `driver === 'off'` (exposed as
 * SessionDto.features.onlinePayments) and hides the Connect button. Lets a
 * production deployment run before the Stripe platform is approved.
 */
export class DisabledPaymentProcessor implements PaymentProcessorClient {
  readonly driver = 'off' as const;
  readonly provider = 'stripe' as const;
  private fail(): never {
    throw new PaymentProcessorError('Online payments are not enabled on this server', 'unsupported', 501);
  }
  createConnectedAccount(): Promise<ProcessorAccount> { return Promise.reject(this.safeError()); }
  createOnboardingLink(): Promise<{ url: string; expiresAt: string }> { return Promise.reject(this.safeError()); }
  retrieveAccount(): Promise<ProcessorAccount> { return Promise.reject(this.safeError()); }
  readonly supportsLinking = false;
  createLinkUrl(): string { return this.fail(); }
  completeLink(): Promise<{ accountId: string }> { return Promise.reject(this.safeError()); }
  retrieveBalance(): Promise<string> { return Promise.reject(this.safeError()); }
  createCheckoutSession(): Promise<CheckoutSession> { return Promise.reject(this.safeError()); }
  retrieveCheckoutSession(): Promise<{ id: string; paymentIntentId: string | null; status: 'open' | 'complete' | 'expired'; paymentStatus: 'paid' | 'unpaid' | 'no_payment_required' }> { return Promise.reject(this.safeError()); }
  expireCheckoutSession(): Promise<void> { return Promise.reject(this.safeError()); }
  retrievePaymentIntent(): Promise<ProcessorCharge> { return Promise.reject(this.safeError()); }
  createRefund(): Promise<ProcessorRefund> { return Promise.reject(this.safeError()); }
  retrieveRefund(): Promise<ProcessorRefund> { return Promise.reject(this.safeError()); }
  retrievePayout(): Promise<ProcessorPayout> { return Promise.reject(this.safeError()); }
  retrieveDispute(): Promise<ProcessorDispute> { return Promise.reject(this.safeError()); }
  constructEvent(): ProcessorEvent { return this.fail(); }
  dashboardUrl(): string { return '#'; }
  private safeError(): PaymentProcessorError { return new PaymentProcessorError('Online payments are not enabled on this server', 'unsupported', 501); }
}

export function createPaymentProcessorFromEnv(env: NodeJS.ProcessEnv = process.env): PaymentProcessorClient {
  const driver = env.PAYMENTS_DRIVER ?? 'fixture';
  if (driver === 'off') return new DisabledPaymentProcessor();
  if (driver === 'stripe') {
    if (!env.STRIPE_SECRET_KEY) throw new Error('PAYMENTS_DRIVER=stripe requires STRIPE_SECRET_KEY');
    const isProduction = (env.APP_ENV ?? env.NODE_ENV) === 'production';
    return new StripePaymentProcessor({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null, livemode: isProduction ? true : null, connectClientId: env.STRIPE_CONNECT_CLIENT_ID || null, oauthSecretKey: env.STRIPE_OAUTH_SECRET_KEY || null });
  }
  if ((env.APP_ENV ?? env.NODE_ENV) === 'production' && env.ALLOW_FIXTURE_PAYMENTS_IN_PRODUCTION !== 'i-understand') {
    throw new Error('PAYMENTS_DRIVER=fixture is not allowed in production');
  }
  return new FixturePaymentProcessor(env.PUBLIC_BASE_URL ?? 'http://localhost:3000');
}
