import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import './globals.css';
import { fontVariables } from './fonts';
import { DEFAULT_MODE, THEME_BOOT_SCRIPT, THEME_COOKIE, initialThemeFor, isThemeMode } from '@/lib/themes';
import { RootProviders } from '@/components/providers';
import { authModeFromEnv } from '@/server/env';
import { clerkAppearance, clerkLocalization } from '@/lib/clerk-appearance';

export const metadata: Metadata = {
  title: { default: 'Evenbooks', template: '%s · Evenbooks' },
  description: 'Honest double-entry bookkeeping for small companies. Fair prices, open books.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const authMode = authModeFromEnv();
  const themeCookie = (await cookies()).get(THEME_COOKIE)?.value;
  const mode = isThemeMode(themeCookie) ? themeCookie : DEFAULT_MODE;
  let content = <RootProviders>{children}</RootProviders>;
  if (authMode === 'clerk') {
    const { ClerkProvider } = await import('@clerk/nextjs');
    content = (
      <ClerkProvider afterSignOutUrl="/" signInUrl="/sign-in" signUpUrl="/sign-up" appearance={clerkAppearance} localization={clerkLocalization}>
        {content}
      </ClerkProvider>
    );
  }
  return (
    <html lang="en" data-mode={mode} data-theme={initialThemeFor(mode)} className={`h-full ${fontVariables}`} suppressHydrationWarning>
      <body className="min-h-full">
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        {content}
      </body>
    </html>
  );
}
