import { NextResponse, type NextRequest, type NextFetchEvent } from 'next/server';

const useClerk = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) && process.env.AUTH_MODE !== 'dev';

/**
 * Next 16 request proxy. In Clerk mode it runs clerkMiddleware so `auth()` is
 * available in server code; route protection itself happens per resource
 * (`requirePrincipal`). In dev mode requests pass through and the dev cookie
 * is read server-side.
 */
export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  if (!useClerk) return NextResponse.next();
  const { clerkMiddleware } = await import('@clerk/nextjs/server');
  return clerkMiddleware()(request, event);
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/:path*',
  ],
};
