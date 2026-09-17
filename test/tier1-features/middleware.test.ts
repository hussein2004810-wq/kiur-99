import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import app from '../../src/index';
import type { AppEnv } from '../../src/types';
import { errorHandler, notFoundHandler, validate, formatZodError } from '../../src/middleware/error';
import { corsMiddleware, resolveAllowedOrigin } from '../../src/middleware/cors';

describe('Tier 1: Middleware & Foundation Suite', () => {
  describe('Health and Static SPA Serving', () => {
    it('GET /health returns 200 {"status": "ok"}', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ status: 'ok' });
    });

    it('GET / returns 200 HTML with Cache-Control: no-cache', async () => {
      const res = await app.request('/');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      const text = await res.text();
      expect(text.length).toBeGreaterThan(1000);
      expect(text).toContain('Kiur');
    });

    it('GET /admin returns 200 HTML with Cache-Control: no-cache', async () => {
      const res = await app.request('/admin');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      const text = await res.text();
      expect(text.length).toBeGreaterThan(1000);
      expect(text).toContain('لوحة التحكم');
    });

    it('GET /admin/ (with trailing slash) also returns 200 HTML with Cache-Control: no-cache', async () => {
      const res = await app.request('/admin/');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      const text = await res.text();
      expect(text.length).toBeGreaterThan(1000);
      expect(text).toContain('لوحة التحكم');
    });
  });

  describe('Error Handling and Standard { detail: string } Contract', () => {
    it('Unmatched route returns 404 with {"detail": string}', async () => {
      const res = await app.request('/api/non-existent-route-path');
      expect(res.status).toBe(404);
      const json = (await res.json()) as { detail: string };
      expect(json).toHaveProperty('detail');
      expect(typeof json.detail).toBe('string');
      expect(json.detail).toBe('المسار المطلوب غير موجود');
    });

    it('Handles HTTPException with custom status and detail message', async () => {
      const testApp = new Hono<AppEnv>();
      testApp.onError(errorHandler);
      testApp.get('/test-http-error', () => {
        throw new HTTPException(403, { message: 'هذا الحساب محظور' });
      });

      const res = await testApp.request('/test-http-error');
      expect(res.status).toBe(403);
      const json = (await res.json()) as { detail: string };
      expect(json).toEqual({ detail: 'هذا الحساب محظور' });
    });

    it('Handles ZodError with flattened human-readable string (never [object Object])', async () => {
      const testSchema = z.object({
        email: z.string({ required_error: 'Required' }).email(),
        count: z.number(),
      });

      const testApp = new Hono<AppEnv>();
      testApp.onError(errorHandler);
      testApp.post('/test-zod', validate('json', testSchema), (c) => c.json({ ok: true }));

      const res = await testApp.request('/test-zod', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email' }),
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as { detail: string };
      expect(typeof json.detail).toBe('string');
      expect(json.detail).toContain('email');
      expect(json.detail).toContain('count');
      expect(json.detail).not.toContain('[object Object]');
    });

    it('Sanitizes SQLite UNIQUE constraint failures into friendly Arabic message', async () => {
      const testApp = new Hono<AppEnv>();
      testApp.onError(errorHandler);
      testApp.get('/test-unique', () => {
        throw new Error('D1_ERROR: UNIQUE constraint failed: users.email');
      });

      const res = await testApp.request('/test-unique');
      expect(res.status).toBe(400);
      const json = (await res.json()) as { detail: string };
      expect(json.detail).toBe('القيمة المدخلة مستخدمة بالفعل ومسجلة مسبقاً');
    });

    it('Sanitizes SQLite FOREIGN KEY constraint failures into friendly Arabic message', async () => {
      const testApp = new Hono<AppEnv>();
      testApp.onError(errorHandler);
      testApp.get('/test-fk', () => {
        throw new Error('D1_ERROR: FOREIGN KEY constraint failed');
      });

      const res = await testApp.request('/test-fk');
      expect(res.status).toBe(400);
      const json = (await res.json()) as { detail: string };
      expect(json.detail).toBe('البيانات المرتبطة غير موجودة أو غير صالحة');
    });

    it('Returns 500 for unexpected errors and logs safely', async () => {
      const testApp = new Hono<AppEnv>();
      testApp.onError(errorHandler);
      testApp.get('/test-crash', () => {
        throw new Error('Unexpected catastrophic failure');
      });

      const res = await testApp.request('/test-crash', {}, { DEBUG: 'false' });
      expect(res.status).toBe(500);
      const json = (await res.json()) as { detail: string };
      expect(json.detail).toBe('حدث خطأ غير متوقع في الخادم');
    });
  });

  describe('CORS Architecture & Origin Resolution', () => {
    it('Permits localhost origins on arbitrary ports when DEBUG=true', async () => {
      const res = await app.request('/health', {
        headers: { Origin: 'http://localhost:5500' },
      }, { DEBUG: 'true' });

      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5500');
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('Permits 127.0.0.1 origins when DEBUG=true', async () => {
      const res = await app.request('/health', {
        headers: { Origin: 'http://127.0.0.1:3000' },
      }, { DEBUG: 'true' });

      expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3000');
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('Rejects unauthorized origins when not matching CORS_ORIGINS in production', async () => {
      const res = await app.request('/health', {
        headers: { Origin: 'https://malicious-site.example.com' },
      }, { DEBUG: 'false', CORS_ORIGINS: 'http://localhost:5500' });

      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('Handles CORS preflight OPTIONS requests with 204 and required headers', async () => {
      const res = await app.request('/health', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5500',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type,Authorization,Range',
        },
      }, { DEBUG: 'true' });

      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5500');
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    });

    it('Attaches CORS headers even on 404 error responses so browsers do not mask error details', async () => {
      const res = await app.request('/api/not-found-endpoint', {
        headers: { Origin: 'http://localhost:5500' },
      }, { DEBUG: 'true' });

      expect(res.status).toBe(404);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5500');
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      const json = await res.json();
      expect(json).toEqual({ detail: 'المسار المطلوب غير موجود' });
    });

    it('Attaches CORS headers on 500 errors', async () => {
      const testApp = new Hono<AppEnv>();
      testApp.use('*', corsMiddleware);
      testApp.onError(errorHandler);
      testApp.get('/error-route', () => {
        throw new Error('Boom');
      });

      const res = await testApp.request('/error-route', {
        headers: { Origin: 'http://localhost:5500' },
      }, { DEBUG: 'true' });

      expect(res.status).toBe(500);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5500');
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });
  });
});
