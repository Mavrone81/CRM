import crypto from 'node:crypto';

// Single-password gate. Credentials and the cookie-signing secret come from the
// environment; the defaults below are dev fallbacks — override them in prod.
const USER = process.env.AUTH_USER || 'petsadmin';
const PASS = process.env.AUTH_PASSWORD || 'P@55w0rd888';
const SECRET = process.env.AUTH_SECRET || 'watapp-dev-secret-change-me';

export const SESSION_COOKIE = 'watapp_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days, in seconds

function sha256(s: string): Buffer {
  return crypto.createHash('sha256').update(s, 'utf8').digest();
}

// Constant-time compare via fixed-length digests (avoids leaking string length).
function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

export function checkCredentials(username: string, password: string): boolean {
  // Evaluate both halves regardless of the first result to keep timing flat.
  const u = safeEqual(username, USER);
  const p = safeEqual(password, PASS);
  return u && p;
}

const sign = (payload: string): string =>
  crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

export function createToken(username: string): string {
  const exp = Date.now() + SESSION_MAX_AGE * 1000;
  const payload = Buffer.from(JSON.stringify({ u: username, exp })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined | null): { u: string; exp: number } | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;

  const expected = sign(payload);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}
