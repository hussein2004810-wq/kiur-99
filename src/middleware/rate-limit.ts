import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { recordAuditEvent } from '../services/audit';

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

// In-memory sliding window storage
const store = new Map<string, RateLimitRecord>();

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

    // Periodic cleanup of stale records
    if (store.size > 2000) {
      for (const [k, v] of store.entries()) {
        if (now > v.resetAt) store.delete(k);
      }
    }

    const ip =
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-real-ip') ||
      c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
      '127.0.0.1';

    const key = `${keyPrefix}:${ip}`;
    let record = store.get(key);

    if (!record || now > record.resetAt) {
      record = { count: 1, resetAt: now + windowSeconds * 1000 };
      store.set(key, record);
    } else {
      record.count += 1;
    }

    const remaining = Math.max(0, max - record.count);
    const retryAfter = Math.ceil((record.resetAt - now) / 1000);

    c.header('X-RateLimit-Limit', String(max));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(record.resetAt / 1000)));

    if (record.count > max) {
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

/**
 * Resets the rate limiter store (used for test isolation).
 */
export function resetRateLimitStore(): void {
  store.clear();
}
