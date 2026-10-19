/**
 * Database environment variables.
 *
 * DATABASE_URL        application role (evenbooks_app) — used by web and worker
 * DATABASE_OWNER_URL  owner role (evenbooks_owner) — migrations only
 * DATABASE_ADMIN_URL  superuser — bootstrap and tests only (never in production runtime)
 */
export interface DbEnv {
  appUrl: string;
  ownerUrl?: string;
  adminUrl?: string;
}

export function readDbEnv(env: NodeJS.ProcessEnv = process.env): DbEnv {
  const appUrl = env.DATABASE_URL;
  if (!appUrl) throw new Error('DATABASE_URL is not set');
  return { appUrl, ownerUrl: env.DATABASE_OWNER_URL, adminUrl: env.DATABASE_ADMIN_URL };
}

export function needsSsl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.searchParams.get('sslmode') === 'require' || (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1' && !u.hostname.endsWith('.railway.internal'));
  } catch {
    return false;
  }
}
