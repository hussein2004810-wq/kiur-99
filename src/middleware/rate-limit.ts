import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { recordAuditEvent } from '../services/audit';

export interface RateLimitOptions {
  max: number;
  windowSeconds: number;
  keyPrefix: string;
}

/**
 * Creates endpoint-specific rate limiting middleware (Stage 8).
 */
export function rateLimiter(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const { max, windowSeconds, keyPrefix } = options;

  return async (c, next) => {
    const now = Date.now();

    const ip =
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-real-ip') ||
      c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
      '127.0.0.1';

    // D1 is shared by all Worker isolates.  This single UPSERT avoids the
    // per-isolate Map bypass and atomically starts a fresh window when expired.
    const key = `${keyPrefix}:${ip}`;
    const newResetAt = now + windowSeconds * 1000;
    const record = await c.env.DB.prepare(`
      INSERT INTO rate_limit_windows (key, count, reset_at) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN rate_limit_windows.reset_at <= ? THEN 1 ELSE rate_limit_windows.count + 1 END,
        reset_at = CASE WHEN rate_limit_windows.reset_at <= ? THEN excluded.reset_at ELSE rate_limit_windows.reset_at END
      RETURNING count, reset_at
    `).bind(key, newResetAt, now, now).first<{ count: number; reset_at: number }>();
    if (!record) return c.json({ detail: 'تعذر التحقق من حد الطلبات' }, 503);
    const resetAt = Number(record.reset_at);
    const count = Number(record.count);

    const remaining = Math.max(0, max - count);
    const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));

    c.header('X-RateLimit-Limit', String(max));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));

    if (count > max) {
      recordAuditEvent({
        event: 'SECURITY_RATE_LIMITED',
        status: 'DENIED',
        ip,
        details: { keyPrefix, limit: max, retryAfter, path: c.req.path },
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
export const loginRateLimiter = rateLimiter({ max: 10, windowSeconds: 60, keyPrefix: 'rl:login' });
export const registerRateLimiter = rateLimiter({ max: 5, windowSeconds: 600, keyPrefix: 'rl:register' });
export const forgotPasswordRateLimiter = rateLimiter({ max: 3, windowSeconds: 600, keyPrefix: 'rl:forgot-pw' });
export const twoFaVerifyRateLimiter = rateLimiter({ max: 5, windowSeconds: 300, keyPrefix: 'rl:2fa-verify' });
export const examAttemptRateLimiter = rateLimiter({ max: 10, windowSeconds: 60, keyPrefix: 'rl:exam-start' });
export const resendVerificationRateLimiter = rateLimiter({ max: 3, windowSeconds: 3600, keyPrefix: 'rl:resend-verif' });
export const firebaseAuthRateLimiter = rateLimiter({ max: 10, windowSeconds: 60, keyPrefix: 'rl:firebase' });
export const redeemRateLimiter = rateLimiter({ max: 10, windowSeconds: 60, keyPrefix: 'rl:redeem' });

/**
 * Resets the rate limiter store (used for test isolation).
 */
export function resetRateLimitStore(): void {
  // Kept as a compatibility no-op for test harnesses.  Each test creates a
  // fresh in-memory D1 database, so counters cannot leak between tests.
}
