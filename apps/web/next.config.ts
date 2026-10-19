import type { NextConfig } from 'next';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../');
// Share one .env at the repository root across web, worker and scripts (local wins).
loadEnv({ path: [path.join(root, '.env'), path.join(root, 'apps/web/.env.local')], quiet: true });

// Next dev blocks its own scripts for any origin other than localhost, which makes pages
// render without hydrating when the server is reached by hostname or IP. Allow this
// machine's hostname plus anything listed in DEV_ALLOWED_ORIGINS (comma separated).
const devOrigins = [os.hostname(), ...(process.env.DEV_ALLOWED_ORIGINS ?? '').split(',')].map((h) => h.trim()).filter(Boolean);

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins,
  // Served with `next start` inside the pnpm workspace image (Railway); standalone output is not used.
  outputFileTracingRoot: root,
  transpilePackages: ['@evenbooks/contracts', '@evenbooks/db', '@evenbooks/domain', '@evenbooks/services', '@evenbooks/integrations'],
  serverExternalPackages: ['pg', 'pino', 'pdfkit', 'stripe'],
  typedRoutes: false,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
