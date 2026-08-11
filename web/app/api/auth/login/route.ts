import { NextRequest, NextResponse } from 'next/server';
import { checkCredentials, createToken, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/auth';
import { clientIp, loginKey, isBlocked, recordFailure, clearFailures, sweep } from '@/lib/login-throttle';

export async function POST(req: NextRequest) {
  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Bad request' }, { status: 400 });
  }

  const username = (body.username || '').trim();
  const password = body.password || '';

  sweep();
  const key = loginKey(username, clientIp(req));
  if (isBlocked(key)) {
    return NextResponse.json(
      { ok: false, error: 'Too many failed attempts. Please try again in 15 minutes.' },
      { status: 429 },
    );
  }

  if (!checkCredentials(username, password)) {
    recordFailure(key);
    return NextResponse.json({ ok: false, error: 'Invalid username or password' }, { status: 401 });
  }
  clearFailures(key);

  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: SESSION_COOKIE,
    value: createToken(username),
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
