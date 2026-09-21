import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';
import type { AppBindings, AppEnv } from '../types';

/**
 * Determines whether the incoming request Origin is allowed.
 * Supports:
 * 1. Any localhost / 127.0.0.1 port in DEBUG mode (matching Python allow_origin_regex).
 * 2. Comma-separated list of origins from env.CORS_ORIGINS.
 */
export function resolveAllowedOrigin(
  origin: string | undefined,
  env?: AppBindings
): string | null {
  if (!origin) return null;

  const isDebug = env?.DEBUG === 'true' || env?.DEBUG === '1';

  // Localhost regex for dev mode (ports 5500, 3000, 5173, 8787, etc.)
  if (isDebug) {
    const localhostRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
    if (localhostRegex.test(origin)) {
      return origin;
    }
  }

  // Configured allowed origins
  const rawOrigins = env?.CORS_ORIGINS ?? (isDebug
    ? 'http://localhost:5500,http://127.0.0.1:5500,http://localhost:8787,http://127.0.0.1:8787'
    : '');
  const allowedList = rawOrigins
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (allowedList.includes(origin.toLowerCase())) {
    return origin;
  }

  return null;
}

/**
 * Dynamic CORS Middleware Handler.
 * Reads environment variables per-request from `c.env`.
 */
export const corsMiddleware: MiddlewareHandler<AppEnv> = (c, next) => {
  const handler = cors({
    origin: (origin) => resolveAllowedOrigin(origin, c.env) || '',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'Origin',
      'X-Requested-With',
      'Range',
      'Cache-Control',
    ],
    exposeHeaders: [
      'Content-Length',
      'Content-Range',
      'ETag',
      'Accept-Ranges',
    ],
    credentials: true,
    maxAge: 86400,
  });

  return handler(c, next);
};
