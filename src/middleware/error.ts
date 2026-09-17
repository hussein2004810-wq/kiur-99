import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { ZodSchema } from 'zod';
import type { ValidationTargets } from 'hono';
import type { AppEnv } from '../types';
import { resolveAllowedOrigin } from './cors';
import { applySecurityHeaders } from './security-headers';

/**
 * Flattens Zod validation issues into a single, clean, human-readable string.
 * This guarantees the frontend's `showToast(e.detail)` never receives an object or array.
 */
export function formatZodError(error: ZodError): string {
  if (!error.issues || error.issues.length === 0) {
    return 'بيانات الطلب غير صالحة';
  }
  return error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : 'body';
      let msg = issue.message;
      if (msg === 'Required') msg = 'هذا الحقل مطلوب';
      if (msg.includes('Expected string, received')) msg = 'نوع القيمة غير صالح';
      return `${field}: ${msg}`;
    })
    .join('; ');
}

/**
 * Wrapped zValidator that guarantees invalid inputs immediately return
 * HTTP 400 with `{ "detail": string }` rather than bypassing app.onError.
 */
export const validate = <T extends keyof ValidationTargets>(
  target: T,
  schema: ZodSchema
) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const detail = formatZodError(result.error);
      return c.json({ detail }, 400);
    }
  });

/**
 * Centralized Application Error Handler.
 * Guarantees that EVERY exception returns `{ "detail": string }` and attaches CORS headers.
 */
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  console.error('[Unhandled Error]', err);

  // Ensure CORS headers are injected on error responses so browsers do not mask errors
  // Ensure CORS and Security headers are injected on error responses so browsers do not mask errors
  const isDebug = c.env?.DEBUG === 'true' || (c.env as any)?.DEBUG === true;
  applySecurityHeaders(c.res.headers, isDebug);

  const origin = c.req.header('Origin');
  const allowedOrigin = resolveAllowedOrigin(origin, c.env);
  if (allowedOrigin) {
    c.header('Access-Control-Allow-Origin', allowedOrigin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Vary', 'Origin');
  }

  // 1. Explicit Hono / FastAPI-style HTTPException
  if (err instanceof HTTPException) {
    return c.json({ detail: err.message }, err.status);
  }

  // 2. Direct ZodError thrown from schema.parse()
  if (err instanceof ZodError) {
    return c.json({ detail: formatZodError(err) }, 400);
  }

  // 3. SQLite / D1 database constraint violations
  const msg = err.message || '';
  if (msg.includes('UNIQUE constraint failed')) {
    return c.json({ detail: 'القيمة المدخلة مستخدمة بالفعل ومسجلة مسبقاً' }, 400);
  }
  if (msg.includes('FOREIGN KEY constraint failed')) {
    return c.json({ detail: 'البيانات المرتبطة غير موجودة أو غير صالحة' }, 400);
  }

  // 4. Catch-all unexpected runtime crashes (500)
  const isDebug = c.env?.DEBUG === 'true' || (c.env as any)?.DEBUG === true;
  const detail = isDebug
    ? (err.message || 'Internal Server Error')
    : 'حدث خطأ غير متوقع في الخادم';

  return c.json({ detail }, 500);
};

/**
 * Centralized 404 Route Handler.
 * Returns `{ "detail": "المسار المطلوب غير موجود" }` instead of plain text "404 Not Found".
 */
export const notFoundHandler: NotFoundHandler<AppEnv> = (c) => {
  const isDebug = c.env?.DEBUG === 'true' || (c.env as any)?.DEBUG === true;
  applySecurityHeaders(c.res.headers, isDebug);

  const origin = c.req.header('Origin');
  const allowedOrigin = resolveAllowedOrigin(origin, c.env);
  if (allowedOrigin) {
    c.header('Access-Control-Allow-Origin', allowedOrigin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Vary', 'Origin');
  }
  return c.json({ detail: 'المسار المطلوب غير موجود' }, 404);
};
