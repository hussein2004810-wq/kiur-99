import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';

export const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https: blob:",
  "connect-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Injects required security hardening headers into the response headers.
 */
export function applySecurityHeaders(headers: Headers, isDebug = false): void {
  headers.set('Content-Security-Policy', CSP_POLICY);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');

  if (!isDebug) {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
}

/**
 * Centralized Security Headers Middleware (Stage 6).
 */
export const securityHeadersMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const isDebug = c.env?.DEBUG === 'true' || (c.env as any)?.DEBUG === true;
  applySecurityHeaders(c.res.headers, isDebug);
};

