import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { recordAuditEvent } from '../services/audit';

export interface RateLimitOptions {
  max: number;
  windowSeconds: number;
  keyPrefix: string;
  /**
   * Optional tighter limit for a request-specific identity.  This is useful
   * before authentication exists (for example, an email address at login),
   * where a low IP-only limit would block an entire university NAT.
   */
  identity?: {
    max: number;
    windowSeconds: number;
    key: (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => string | null | Promise<string | null>;
  };
}

/**
 * Produces a non-PII, stable bucket for password-based login attempts.
 * The request is cloned so the route can still parse its own JSON body.
 */
async function loginEmailIdentity(c: Parameters<MiddlewareHandler<AppEnv>>[0]): Promise<string | null> {
  if (!c.req.header('content-type')?.toLowerCase().includes('application/json')) return null;
  const body = await c.req.raw.clone().json<{ email?: unknown }>().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > 320) return null;

  const bytes = new TextEncoder().encode(`login-email:${email}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Creates endpoint-specific rate limiting middleware (Stage 8).
 */
export function rateLimiter(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const { max, windowSeconds, keyPrefix, identity } = options;

  return async (c, next) => {
    const now = Date.now();

    const ip =
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-real-ip') ||
      c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
      '127.0.0.1';

    // D1 is shared by all Worker isolates.  Count both the originating IP and
    // the authenticated account (when present): IP-only limits prevent bulk
    // abuse from one source, while account limits prevent a user escaping the
    // limit by changing IP addresses.  Unauthenticated routes use IP only.
    const accountId = c.get('user')?.id;
    const limits: Array<{ key: string; max: number; windowSeconds: number }> = [
      { key: `${keyPrefix}:ip:${ip}`, max, windowSeconds },
    ];
    if (accountId) limits.push({ key: `${keyPrefix}:account:${accountId}`, max, windowSeconds });

    const identityKey = identity ? await identity.key(c) : null;
    if (identityKey) {
      limits.push({
        key: `${keyPrefix}:identity:${identityKey}`,
        max: identity!.max,
        windowSeconds: identity!.windowSeconds,
      });
    }

    const records = await Promise.all(limits.map((limit) => {
      const newResetAt = now + limit.windowSeconds * 1000;
      return c.env.DB.prepare(`
        INSERT INTO rate_limit_windows (key, count, reset_at) VALUES (?, 1, ?)
        ON CONFLICT(key) DO UPDATE SET
          count = CASE WHEN rate_limit_windows.reset_at <= ? THEN 1 ELSE rate_limit_windows.count + 1 END,
          reset_at = CASE WHEN rate_limit_windows.reset_at <= ? THEN excluded.reset_at ELSE rate_limit_windows.reset_at END
        RETURNING count, reset_at
      `).bind(limit.key, newResetAt, now, now).first<{ count: number; reset_at: number }>();
    }));
    if (records.some((record) => !record)) {
      return c.json({ detail: 'تعذر التحقق من حد الطلبات' }, 503);
    }
    const evaluated = records.map((record, index) => ({
      count: Number(record!.count),
      resetAt: Number(record!.reset_at),
      max: limits[index].max,
    }));
    const violations = evaluated.filter((record) => record.count > record.max);
    const mostConstrained = evaluated.reduce((current, record) =>
      record.max - record.count < current.max - current.count ? record : current
    );

    const remaining = Math.max(0, mostConstrained.max - mostConstrained.count);
    const retryAfter = Math.max(1, Math.ceil((Math.max(...(violations.length ? violations : evaluated).map((record) => record.resetAt)) - now) / 1000));

    c.header('X-RateLimit-Limit', String(mostConstrained.max));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(mostConstrained.resetAt / 1000)));

    if (violations.length) {
      recordAuditEvent({
        event: 'SECURITY_RATE_LIMITED',
        status: 'DENIED',
        ip,
        details: {
          keyPrefix,
          limit: Math.min(...violations.map((record) => record.max)),
          retryAfter,
          path: c.req.path,
          accountBound: Boolean(accountId),
          identityBound: Boolean(identityKey),
        },
      });
      c.header('Retry-After', String(retryAfter));
      return c.json(
        {
          detail: 'تجاوزت الحد المسموح من المحاولات. الرجاء المحاولة لاحقاً',
          retry_after: retryAfter,
        },
        429
      );
    }

    await next();
  };
}

// Pre-configured rate limiters for abuse-prone endpoints
// A university lab commonly presents hundreds of students behind one public
// IP. Keep a network-wide abuse ceiling while enforcing the tighter limit on
// the attempted account itself, rather than locking out the whole lab.
export const loginRateLimiter = rateLimiter({
  max: 120,
  windowSeconds: 60,
  keyPrefix: 'rl:login',
  identity: { max: 10, windowSeconds: 60, key: loginEmailIdentity },
});
export const registerRateLimiter = rateLimiter({ max: 5, windowSeconds: 600, keyPrefix: 'rl:register' });
export const forgotPasswordRateLimiter = rateLimiter({ max: 3, windowSeconds: 600, keyPrefix: 'rl:forgot-pw' });
export const resetPasswordRateLimiter = rateLimiter({ max: 5, windowSeconds: 600, keyPrefix: 'rl:reset-pw' });
export const verifyEmailRateLimiter = rateLimiter({ max: 10, windowSeconds: 60, keyPrefix: 'rl:verify-email' });
export const twoFaVerifyRateLimiter = rateLimiter({ max: 5, windowSeconds: 300, keyPrefix: 'rl:2fa-verify' });
export const examAttemptRateLimiter = rateLimiter({ max: 10, windowSeconds: 60, keyPrefix: 'rl:exam-start' });
export const resendVerificationRateLimiter = rateLimiter({ max: 3, windowSeconds: 3600, keyPrefix: 'rl:resend-verif' });
export const firebaseAuthRateLimiter = rateLimiter({ max: 10, windowSeconds: 60, keyPrefix: 'rl:firebase' });
export const googleIdentityRateLimiter = rateLimiter({ max: 10, windowSeconds: 60, keyPrefix: 'rl:google-identity' });
export const oauthHandoffRateLimiter = rateLimiter({ max: 10, windowSeconds: 60, keyPrefix: 'rl:oauth-handoff' });
export const redeemRateLimiter = rateLimiter({ max: 10, windowSeconds: 60, keyPrefix: 'rl:redeem' });

/**
 * Resets the rate limiter store (used for test isolation).
 */
export function resetRateLimitStore(): void {
  // Kept as a compatibility no-op for test harnesses.  Each test creates a
  // fresh in-memory D1 database, so counters cannot leak between tests.
}
