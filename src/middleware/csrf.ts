import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { resolveAllowedOrigin } from './cors';
import { recordAuditEvent } from '../services/audit';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * Cross-Site Request Forgery & Origin Validation Middleware (Stage 5).
 * Rejects untrusted cross-site mutations and verifies Origin headers.
 */
export const csrfProtectionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method.toUpperCase();

  if (MUTATION_METHODS.has(method)) {
    const origin = c.req.header('Origin');
    const secFetchSite = c.req.header('Sec-Fetch-Site');

    // 1. Explicit cross-site rejection for sensitive mutations
    if (secFetchSite === 'cross-site') {
      recordAuditEvent({
        event: 'SECURITY_CSRF_DENIAL',
        status: 'DENIED',
        ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
        details: { reason: 'Sec-Fetch-Site: cross-site', origin, path: c.req.path, method },
      });
      return c.json(
        { detail: 'تم رفض الطلب: عملية غير مصرح بها عبر المواقع (Cross-Site Request Rejected)' },
        403
      );
    }

    // 2. Origin verification for browser requests sending Origin header
    if (origin) {
      const allowedOrigin = resolveAllowedOrigin(origin, c.env);
      const url = new URL(c.req.url);
      const isSameOrigin = origin.toLowerCase() === url.origin.toLowerCase();

      if (!allowedOrigin && !isSameOrigin) {
        recordAuditEvent({
          event: 'SECURITY_CSRF_DENIAL',
          status: 'DENIED',
          ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
          details: { reason: 'Untrusted Origin', origin, path: c.req.path, method },
        });
        return c.json(
          { detail: 'تم رفض الطلب: مصدر غير مصرح به (Untrusted Origin Rejected)' },
          403
        );
      }
    }
  }

  await next();
};
