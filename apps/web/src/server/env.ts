import 'server-only';

export type AuthMode = 'clerk' | 'dev';

export interface WebEnv {
  authMode: AuthMode;
  databaseUrl: string;
  appEncryptionKey: string | null;
  devSessionSecret: string;
  publicBaseUrl: string;
  clerkPublishableKey: string | null;
  clerkSecretKey: string | null;
  clerkWebhookSecret: string | null;
  /** Clerk Billing plan slugs that count as the paid tier (organization plans). */
  clerkPaidPlanSlugs: string[];
  /** Members allowed per company on each tier; pushed to Clerk as the organization's membership limit. */
  planMemberLimits: { free: number; paid: number };
  isProduction: boolean;
}

let cached: WebEnv | null = null;

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function env(): WebEnv {
  if (cached) return cached;
  // Deployment environment (not the build mode). Railway sets APP_ENV=production.
  const isProduction = (process.env.APP_ENV ?? process.env.NODE_ENV) === 'production';
  const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null;
  const clerkSecretKey = process.env.CLERK_SECRET_KEY ?? null;
  const authMode: AuthMode = (process.env.AUTH_MODE as AuthMode | undefined) ?? (clerkPublishableKey ? 'clerk' : 'dev');
  if (authMode === 'clerk' && (!clerkPublishableKey || !clerkSecretKey)) {
    throw new Error('AUTH_MODE=clerk requires NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY');
  }
  if (authMode === 'dev' && isProduction && process.env.ALLOW_DEV_AUTH_IN_PRODUCTION !== 'i-understand') {
    // Never run the cookie-based dev auth against real data.
    throw new Error('Dev auth mode is not allowed in production. Configure Clerk keys.');
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  cached = {
    authMode,
    databaseUrl,
    appEncryptionKey: process.env.APP_ENCRYPTION_KEY ?? null,
    devSessionSecret: process.env.DEV_SESSION_SECRET ?? 'dev-only-secret-not-for-production',
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
    clerkPublishableKey,
    clerkSecretKey,
    clerkWebhookSecret: process.env.CLERK_WEBHOOK_SIGNING_SECRET ?? null,
    clerkPaidPlanSlugs: (process.env.CLERK_PAID_PLAN_SLUGS ?? 'paid,pro').split(',').map((x) => x.trim()).filter(Boolean),
    planMemberLimits: { free: positiveInt(process.env.CLERK_FREE_PLAN_MEMBERS, 1), paid: positiveInt(process.env.CLERK_PAID_PLAN_MEMBERS, 20) },
    isProduction,
  };
  return cached;
}

/** Safe to call at build time / in client-visible code paths. */
export function authModeFromEnv(): AuthMode {
  const mode = process.env.AUTH_MODE as AuthMode | undefined;
  if (mode) return mode;
  return process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? 'clerk' : 'dev';
}
