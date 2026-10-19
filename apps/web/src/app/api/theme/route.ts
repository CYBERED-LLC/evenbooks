import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_MODE, THEME_COOKIE, isThemeMode } from '@/lib/themes';

const ONE_YEAR = 60 * 60 * 24 * 365;

function cookieOptions() {
  return { path: '/', maxAge: ONE_YEAR, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', httpOnly: false };
}

function setMode(res: NextResponse, mode: string) {
  if (mode === 'reset' || mode === DEFAULT_MODE) res.cookies.set(THEME_COOKIE, '', { ...cookieOptions(), maxAge: 0 });
  else res.cookies.set(THEME_COOKIE, mode, cookieOptions());
}

/** GET /api/theme?set=light|dark|system&next=/path — pick an appearance from a plain link, then redirect. */
export async function GET(req: NextRequest) {
  const set = req.nextUrl.searchParams.get('set') ?? '';
  const next = req.nextUrl.searchParams.get('next') ?? '/';
  // Relative Location: behind Railway's proxy the request origin is the container's, not the public host.
  const target = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  const res = new NextResponse(null, { status: 303, headers: { location: target } });
  if (set === 'reset' || isThemeMode(set)) setMode(res, set);
  return res;
}

/** POST /api/theme { mode } — same, for the in-app toggle. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { mode?: unknown } | null;
  const mode = body?.mode;
  if (mode !== 'reset' && !isThemeMode(mode)) return NextResponse.json({ error: 'unknown mode' }, { status: 400 });
  const res = NextResponse.json({ mode: mode === 'reset' ? DEFAULT_MODE : mode });
  setMode(res, mode);
  return res;
}
