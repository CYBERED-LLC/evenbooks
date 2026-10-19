import Link from 'next/link';
import { Wordmark } from '@/components/brand/mark';
import { LinkButton } from '@/components/ui/button';
import { AppearanceToggle } from '@/components/appearance-toggle';

const nav = [
  { href: '/pricing', label: 'Pricing' },
  { href: '/how-we-make-money', label: 'How we make money' },
  { href: '/source-available', label: 'Source' },
];

/** Shell for every public page: header with sign-in, footer with the commitments. */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-stone-50 text-stone-900">
      <header className="sticky top-0 z-30 border-b border-stone-200/80 bg-stone-50/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link href="/" aria-label="Evenbooks home" className="rounded-md">
            <Wordmark size="sm" />
          </Link>
          <nav aria-label="Site" className="hidden items-center gap-5 text-sm text-stone-600 md:flex">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className="hover:text-stone-900">
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <LinkButton href="/sign-in" variant="ghost" size="sm">
              Sign in
            </LinkButton>
            <LinkButton href="/sign-up" size="sm">
              Start for free
            </LinkButton>
          </div>
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
      <footer className="border-t border-stone-200 bg-white">
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-4">
          <div className="md:col-span-2">
            <Wordmark size="sm" />
            <p className="mt-3 max-w-sm text-sm text-stone-600">Honest double-entry bookkeeping for small companies. Books that balance. Prices that don&apos;t move.</p>
            <AppearanceToggle className="mt-4" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Product</p>
            <ul className="mt-3 space-y-2 text-sm text-stone-700">
              <li>
                <Link href="/pricing" className="hover:text-stone-900">Pricing</Link>
              </li>
              <li>
                <Link href="/how-we-make-money" className="hover:text-stone-900">How we make money</Link>
              </li>
              <li>
                <Link href="/source-available" className="hover:text-stone-900">Source-available and self-hosting</Link>
              </li>
              <li>
                <Link href="/sign-in" className="hover:text-stone-900">Sign in</Link>
              </li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Company</p>
            <ul className="mt-3 space-y-2 text-sm text-stone-700">
              <li>
                <Link href="/legal/terms" className="hover:text-stone-900">Terms of service</Link>
              </li>
              <li>
                <Link href="/legal/privacy" className="hover:text-stone-900">Privacy</Link>
              </li>
              <li>
                <a href="mailto:hello@evenbooks.org" className="hover:text-stone-900">hello@evenbooks.org</a>
              </li>
            </ul>
          </div>
        </div>
        <div className="border-t border-stone-200">
          <p className="mx-auto w-full max-w-6xl px-4 py-4 text-xs text-stone-500 sm:px-6">© 2026 Evenbooks. Evenbooks is source-available software; the hosted service is run from the United States.</p>
        </div>
      </footer>
    </div>
  );
}
