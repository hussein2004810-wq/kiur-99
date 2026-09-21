import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';

export const CSP_POLICY = [
  "default-src 'self'",
  // Inline application scripts are pinned by hash.  Legacy inline event
  // handlers remain isolated in script-src-attr until the UI migration ends.
  "script-src 'self' https://accounts.google.com",
  "script-src-elem 'self' 'sha256-0cwir9scgk8Tr207EpgU7MEuXqiutRFI9tGc33wBn4A=' 'sha256-696+bBrH8mwvpN1fRY0gAUWZjLAQcdS3yrPLkchKZ04=' https://accounts.google.com",
  "script-src-attr 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://lh3.googleusercontent.com",
  "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://accounts.google.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Injects required security hardening headers into the response headers.
 */
export function applySecurityHeaders(headers: Headers, isDebug = false): void {
  if (!headers.has('Content-Security-Policy')) {
    headers.set('Content-Security-Policy', CSP_POLICY);
  }
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // Keep popup compatibility for Google Identity while isolating the opener
  // relationship from unrelated cross-origin windows.
  headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('Origin-Agent-Cluster', '?1');

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
