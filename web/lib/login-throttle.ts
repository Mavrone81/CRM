/**
 * Login throttle: 5 FAILED attempts per (username, IP) per 15 minutes.
 *
 * Keyed on the pair, deliberately. Per-IP alone misses credential stuffing that
 * rotates addresses while walking a list of accounts. Per-username alone hands
 * anyone a denial-of-service against a known account -- fail five times and the
 * real operator is locked out, no password required. The pair stops distributed
 * stuffing from grinding one account while confining any lockout to the
 * attacker's own address.
 *
 * Counts failures only and clears on success, so someone who mistypes once and
 * then gets it right is never penalised. The window self-clears, so nothing here
 * can leave an operator locked out waiting on an admin.
 *
 * State is in this process's memory. Correct while `web` is a single container,
 * which it is. Scaling to multiple instances would divide the count across them
 * and quietly raise the real limit -- if that ever happens, this needs a shared
 * store, not more instances.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

type Entry = { n: number; resetAt: number };
const fails = new Map<string, Entry>();

/**
 * The source address, from `X-Real-IP`.
 *
 * nginx sets `X-Real-IP $remote_addr` with `proxy_set_header`, which REPLACES
 * whatever the client sent, so this value is the peer nginx actually saw. The
 * app port is bound to 127.0.0.1, so nginx is the only path in and the header
 * cannot be forged from outside.
 *
 * Deliberately NOT the first `X-Forwarded-For` entry: nginx builds that header
 * with `$proxy_add_x_forwarded_for`, which APPENDS the real peer to whatever
 * the client already sent. The first entry is therefore attacker-supplied, and
 * a throttle keyed on it can be walked straight through by sending a different
 * fake address on every request.
 */
export function clientIp(req: { headers: { get(name: string): string | null } }): string {
  const realIp = req.headers.get('x-real-ip');
  if (realIp && realIp.trim()) return realIp.trim();

  // Fallback for any path that does not set X-Real-IP: take the LAST
  // X-Forwarded-For entry, which is the one the trusted proxy appended.
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return 'unknown';
}

export function loginKey(username: string, ip: string): string {
  return `${username.trim().toLowerCase().slice(0, 128)}|${ip}`;
}

export function isBlocked(key: string): boolean {
  const e = fails.get(key);
  return !!e && Date.now() <= e.resetAt && e.n >= MAX_FAILS;
}

export function recordFailure(key: string): void {
  const now = Date.now();
  const e = fails.get(key);
  if (!e || now > e.resetAt) fails.set(key, { n: 1, resetAt: now + WINDOW_MS });
  else e.n += 1;
}

export function clearFailures(key: string): void {
  fails.delete(key);
}

/** Drop expired entries so the map cannot grow without bound. */
export function sweep(now: number = Date.now()): void {
  for (const [k, e] of fails) if (now > e.resetAt) fails.delete(k);
}

/** Test seam: reset all state between cases. */
export function __resetForTests(): void {
  fails.clear();
}

export const LOGIN_WINDOW_MS = WINDOW_MS;
export const LOGIN_MAX_FAILS = MAX_FAILS;
