import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, verifyToken } from '@/lib/auth';

// Paths reachable without a session: the login page itself, the auth endpoints,
// and the self-serve booking page + its API (each is gated by a per-lead HMAC
// token, so it is safe — and intended — to be reachable without logging in).
const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/auth/logout', '/book', '/api/proxy/book'];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  const session = verifyToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  // Unauthenticated: API requests get a 401, page loads bounce to /login.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });
  }
  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  // Run on everything except Next's own static assets and the favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
