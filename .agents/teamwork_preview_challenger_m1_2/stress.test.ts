import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z, ZodError } from 'zod';
import app from '../../src/index';
import type { AppEnv, AppBindings } from '../../src/types';
import { errorHandler, notFoundHandler, validate, formatZodError } from '../../src/middleware/error';
import { corsMiddleware, resolveAllowedOrigin } from '../../src/middleware/cors';
import { registerStaticRoutes } from '../../src/routes/static';

describe('Adversarial Stress Test: M1 Entrypoint & Middleware', () => {
  // =========================================================================
  // 1. MALFORMED JSON & BODY PARSING ATTACKS
  // =========================================================================
  describe('Category 1: Malformed JSON & Body Parsing Stress', () => {
    const testSchema = z.object({
      username: z.string().min(3),
      age: z.number().int().positive(),
    });

    const createTestApp = () => {
      const a = new Hono<AppEnv>();
      a.use('*', corsMiddleware);
      a.onError(errorHandler);
      a.notFound(notFoundHandler);

      // Route using validate helper
      a.post('/api/validated', validate('json', testSchema), (c) => {
        const body = c.req.valid('json' as any);
        return c.json({ success: true, body });
      });

      // Route using direct c.req.json()
      a.post('/api/raw-json', async (c) => {
        try {
          const body = await c.req.json();
          return c.json({ success: true, body });
        } catch (e: any) {
          // If a handler catches and rethrows an HTTPException or lets it bubble
          throw new HTTPException(400, { message: 'تنسيق JSON غير صالح' });
        }
      });

      // Route using unhandled c.req.json() to test default error handler
      a.post('/api/unhandled-raw-json', async (c) => {
        const body = await c.req.json();
        return c.json({ success: true, body });
      });

      return a;
    };

    const testApp = createTestApp();

    it('rejects broken/unclosed JSON with Content-Type: application/json', async () => {
      const res = await testApp.request('/api/validated', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"username": "alice", "age": ',
      });

      // Body parsing failure in validator or error handler
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get('content-type')).toContain('application/json');
      const json = await res.json() as any;
      expect(json).toHaveProperty('detail');
      expect(typeof json.detail).toBe('string');
      expect(json.detail).not.toContain('stack');
      expect(json.detail).not.toContain('node_modules');
    });

    it('rejects malformed JSON with single quotes', async () => {
      const res = await testApp.request('/api/validated', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: "{'username': 'alice', 'age': 25}",
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
      const json = await res.json() as any;
      expect(json).toHaveProperty('detail');
      expect(typeof json.detail).toBe('string');
    });

    it('rejects malformed JSON with trailing commas', async () => {
      const res = await testApp.request('/api/validated', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"username": "alice", "age": 25,}',
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
      const json = await res.json() as any;
      expect(json).toHaveProperty('detail');
      expect(typeof json.detail).toBe('string');
    });

    it('rejects empty string body with Content-Type: application/json', async () => {
      const res = await testApp.request('/api/validated', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '',
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
      const json = await res.json() as any;
      expect(json).toHaveProperty('detail');
      expect(typeof json.detail).toBe('string');
    });

    it('rejects non-object JSON primitive (number) when object is expected', async () => {
      const res = await testApp.request('/api/validated', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '12345',
      });

      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json).toHaveProperty('detail');
      expect(typeof json.detail).toBe('string');
    });

    it('rejects non-object JSON primitive (array) when object is expected', async () => {
      const res = await testApp.request('/api/validated', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '["username", "alice"]',
      });

      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json).toHaveProperty('detail');
      expect(typeof json.detail).toBe('string');
    });

    it('handles prototype pollution attempts safely without crashing', async () => {
      const res = await testApp.request('/api/validated', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          __proto__: { polluted: true },
          constructor: { prototype: { polluted: true } },
          username: 'valid_user',
          age: 30,
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.success).toBe(true);
      expect((Object.prototype as any).polluted).toBeUndefined();
    });

    it('handles unicode null bytes and Arabic text in JSON payloads', async () => {
      const res = await testApp.request('/api/validated', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'مستخدم_تجريبي_\u0000',
          age: 22,
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.success).toBe(true);
      expect(json.body.username).toContain('مستخدم_تجريبي');
    });

    it('handled raw json route returns 400 with custom detail on malformed json', async () => {
      const res = await testApp.request('/api/raw-json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{broken',
      });

      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json).toEqual({ detail: 'تنسيق JSON غير صالح' });
    });

    it('handles JSON with Byte Order Mark (BOM) safely', async () => {
      const bomBody = '\uFEFF' + JSON.stringify({ username: 'bom_user', age: 28 });
      const res = await testApp.request('/api/validated', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bomBody,
      });

      // Validated endpoint or body parser should either accept or cleanly return 400 without crashing
      expect(res.status).toBeLessThan(500);
      const json = await res.json() as any;
      if (res.status === 200) {
        expect(json.success).toBe(true);
      } else {
        expect(json).toHaveProperty('detail');
      }
    });

    it('handles large JSON payloads (100KB) without crashing', async () => {
      const largeData = {
        username: 'large_user',
        age: 35,
        extra: 'x'.repeat(100 * 1024),
      };

      const res = await testApp.request('/api/validated', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(largeData),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.success).toBe(true);
    });
  });

  // =========================================================================
  // 2. 404 ROUTE PROBING & METHOD MISMATCHES
  // =========================================================================
  describe('Category 2: 404 Route Probing & Method Mismatches', () => {
    it('returns 404 JSON for non-existent simple path', async () => {
      const res = await app.request('/api/nonexistent');
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      const json = await res.json() as any;
      expect(json).toEqual({ detail: 'المسار المطلوب غير موجود' });
    });

    it('returns 404 JSON for deeply nested non-existent path', async () => {
      const res = await app.request('/a/b/c/d/e/f/g/h/i/j/k');
      expect(res.status).toBe(404);
      const json = await res.json() as any;
      expect(json).toEqual({ detail: 'المسار المطلوب غير موجود' });
    });

    it('returns 404 JSON for static file extension probe', async () => {
      const res = await app.request('/favicon.ico');
      expect(res.status).toBe(404);
      const json = await res.json() as any;
      expect(json).toEqual({ detail: 'المسار المطلوب غير موجود' });
    });

    it('returns 404 JSON for POST on GET-only /health route', async () => {
      const res = await app.request('/health', { method: 'POST' });
      expect(res.status).toBe(404);
      const json = await res.json() as any;
      expect(json).toEqual({ detail: 'المسار المطلوب غير موجود' });
    });

    it('returns 404 JSON for POST on GET-only / route', async () => {
      const res = await app.request('/', { method: 'POST' });
      expect(res.status).toBe(404);
      const json = await res.json() as any;
      expect(json).toEqual({ detail: 'المسار المطلوب غير موجود' });
    });

    it('returns 404 JSON for DELETE on GET-only /admin route', async () => {
      const res = await app.request('/admin', { method: 'DELETE' });
      expect(res.status).toBe(404);
      const json = await res.json() as any;
      expect(json).toEqual({ detail: 'المسار المطلوب غير موجود' });
    });

    it('handles path traversal attempts safely with 404 JSON', async () => {
      const paths = [
        '/../../etc/passwd',
        '/..%2f..%2fpackage.json',
        '/%2e%2e/%2e%2e/wrangler.toml',
        '/admin/../secret',
      ];

      for (const p of paths) {
        const res = await app.request(p);
        expect(res.status).toBe(404);
        const json = await res.json() as any;
        expect(json).toEqual({ detail: 'المسار المطلوب غير موجود' });
      }
    });

    it('injects CORS headers on 404 responses for allowed origins', async () => {
      const res = await app.request('/api/completely-unknown-path', {
        headers: { Origin: 'http://localhost:5500' },
      }, { DEBUG: 'true' });

      expect(res.status).toBe(404);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5500');
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      expect(res.headers.get('vary')).toContain('Origin');
      const json = await res.json() as any;
      expect(json).toEqual({ detail: 'المسار المطلوب غير موجود' });
    });

    it('does NOT inject CORS headers on 404 for disallowed origins', async () => {
      const res = await app.request('/api/completely-unknown-path', {
        headers: { Origin: 'https://evil-attacker.com' },
      }, { DEBUG: 'false', CORS_ORIGINS: 'http://localhost:5500' });

      expect(res.status).toBe(404);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      const json = await res.json() as any;
      expect(json).toEqual({ detail: 'المسار المطلوب غير موجود' });
    });
  });

  // =========================================================================
  // 3. ERROR RESPONSE FORMAT & STACK TRACE PRIVACY
  // =========================================================================
  describe('Category 3: Error Handling Contract & Information Privacy', () => {
    it('guarantees 100% of HTTPException codes return { detail: string }', async () => {
      const testCodes = [400, 401, 403, 404, 409, 422, 429, 500, 503] as const;

      for (const code of testCodes) {
        const localApp = new Hono<AppEnv>();
        localApp.onError(errorHandler);
        localApp.get(`/test-${code}`, () => {
          throw new HTTPException(code, { message: `اختبار رمز الخطأ ${code}` });
        });

        const res = await localApp.request(`/test-${code}`);
        expect(res.status).toBe(code);
        expect(res.headers.get('content-type')).toContain('application/json');
        const json = await res.json() as any;
        expect(json).toEqual({ detail: `اختبار رمز الخطأ ${code}` });
      }
    });

    it('formats complex nested Zod validation errors into a single Arabic/field string', async () => {
      const schema = z.object({
        user: z.object({
          email: z.string({ required_error: 'Required' }).email(),
          profile: z.object({
            displayName: z.string({ required_error: 'Required' }),
            age: z.number({ required_error: 'Required' }),
          }),
        }),
      });

      const localApp = new Hono<AppEnv>();
      localApp.onError(errorHandler);
      localApp.post('/test-nested-zod', validate('json', schema), (c) => c.json({ ok: true }));

      const res = await localApp.request('/test-nested-zod', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: { email: 'bad-email', profile: {} } }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(typeof json.detail).toBe('string');
      expect(json.detail).toContain('user.email');
      expect(json.detail).toContain('user.profile.displayName');
      expect(json.detail).toContain('user.profile.age');
      expect(json.detail).not.toContain('[object Object]');
    });

    it('formatZodError returns default fallback message when error has no issues', () => {
      const emptyZodError = new ZodError([]);
      expect(formatZodError(emptyZodError)).toBe('بيانات الطلب غير صالحة');
    });

    it('sanitizes unexpected 500 error in production (DEBUG=false) - never leaks stack trace', async () => {
      const localApp = new Hono<AppEnv>();
      localApp.onError(errorHandler);
      localApp.get('/crash', () => {
        const err = new Error('Secret internal DB connection string: postgres://admin:secret123@10.0.0.1/prod');
        (err as any).stack = 'Error at /workspace/src/db/internal.ts:42:15\n    at internalQuery()';
        throw err;
      });

      const res = await localApp.request('/crash', {}, { DEBUG: 'false' });
      expect(res.status).toBe(500);
      const json = await res.json() as any;
      expect(json).toEqual({ detail: 'حدث خطأ غير متوقع في الخادم' });
      expect(JSON.stringify(json)).not.toContain('secret123');
      expect(JSON.stringify(json)).not.toContain('postgres://');
      expect(JSON.stringify(json)).not.toContain('/workspace');
    });

    it('handles various Error instances (empty message, custom Error subclass) safely', async () => {
      class CustomAppError extends Error {
        constructor(msg: string) {
          super(msg);
          this.name = 'CustomAppError';
        }
      }

      const localApp = new Hono<AppEnv>();
      localApp.onError(errorHandler);
      localApp.get('/throw-custom-error', () => {
        throw new CustomAppError('Custom database driver failed');
      });
      localApp.get('/throw-empty-error', () => {
        throw new Error();
      });

      // 1. Custom Error subclass throw (in prod, debug=false)
      const res1 = await localApp.request('/throw-custom-error', {}, { DEBUG: 'false' });
      expect(res1.status).toBe(500);
      const json1 = await res1.json() as any;
      expect(json1).toEqual({ detail: 'حدث خطأ غير متوقع في الخادم' });

      // 2. Custom Error subclass throw (in dev, debug=true)
      const res2 = await localApp.request('/throw-custom-error', {}, { DEBUG: 'true' });
      expect(res2.status).toBe(500);
      const json2 = await res2.json() as any;
      expect(json2).toEqual({ detail: 'Custom database driver failed' });

      // 3. Empty Error throw
      const res3 = await localApp.request('/throw-empty-error', {}, { DEBUG: 'false' });
      expect(res3.status).toBe(500);
      const json3 = await res3.json() as any;
      expect(json3).toEqual({ detail: 'حدث خطأ غير متوقع في الخادم' });
    });
  });

  // =========================================================================
  // 4. CORS BEHAVIOR & ADVERSARIAL ORIGIN RESOLUTION
  // =========================================================================
  describe('Category 4: CORS Behavior & Origin Resolution', () => {
    describe('resolveAllowedOrigin logic tests', () => {
      it('returns null for undefined origin', () => {
        expect(resolveAllowedOrigin(undefined)).toBeNull();
      });

      it('returns null for empty origin string', () => {
        expect(resolveAllowedOrigin('')).toBeNull();
      });

      it('rejects origin spoofing: http://localhost.evil.com when DEBUG=true', () => {
        const env = { DEBUG: 'true' } as AppBindings;
        expect(resolveAllowedOrigin('http://localhost.evil.com', env)).toBeNull();
      });

      it('rejects origin spoofing: http://127.0.0.1.evil.com when DEBUG=true', () => {
        const env = { DEBUG: 'true' } as AppBindings;
        expect(resolveAllowedOrigin('http://127.0.0.1.evil.com', env)).toBeNull();
      });

      it('rejects origin spoofing: http://evil.com?origin=http://localhost:5500', () => {
        const env = { DEBUG: 'true' } as AppBindings;
        expect(resolveAllowedOrigin('http://evil.com?origin=http://localhost:5500', env)).toBeNull();
      });

      it('rejects "null" origin string (sandboxed iframes)', () => {
        const env = { DEBUG: 'true' } as AppBindings;
        expect(resolveAllowedOrigin('null', env)).toBeNull();
      });

      it('allows varied valid localhost ports when DEBUG=true', () => {
        const env = { DEBUG: 'true' } as AppBindings;
        expect(resolveAllowedOrigin('http://localhost', env)).toBe('http://localhost');
        expect(resolveAllowedOrigin('http://localhost:3000', env)).toBe('http://localhost:3000');
        expect(resolveAllowedOrigin('http://localhost:5173', env)).toBe('http://localhost:5173');
        expect(resolveAllowedOrigin('http://localhost:8787', env)).toBe('http://localhost:8787');
        expect(resolveAllowedOrigin('https://localhost:443', env)).toBe('https://localhost:443');
        expect(resolveAllowedOrigin('http://127.0.0.1:8080', env)).toBe('http://127.0.0.1:8080');
      });

      it('allows custom CORS_ORIGINS list case-insensitively and trimmed', () => {
        const env = {
          DEBUG: 'false',
          CORS_ORIGINS: ' https://App.Nabd.Edu , https://Admin.Nabd.Edu ',
        } as AppBindings;

        expect(resolveAllowedOrigin('https://app.nabd.edu', env)).toBe('https://app.nabd.edu');
        expect(resolveAllowedOrigin('https://admin.nabd.edu', env)).toBe('https://admin.nabd.edu');
        expect(resolveAllowedOrigin('https://evil.nabd.edu', env)).toBeNull();
      });
    });

    describe('CORS HTTP Middleware integration', () => {
      it('handles preflight OPTIONS request for allowed origin with status 204 and full headers', async () => {
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
        expect(res.headers.get('access-control-max-age')).toBe('86400');
        const methods = res.headers.get('access-control-allow-methods');
        expect(methods).toContain('GET');
        expect(methods).toContain('POST');
        expect(methods).toContain('PUT');
        expect(methods).toContain('DELETE');
        expect(methods).toContain('OPTIONS');
      });

      it('does NOT set Access-Control-Allow-Origin on preflight for disallowed origin in prod', async () => {
        const res = await app.request('/health', {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://attacker.com',
            'Access-Control-Request-Method': 'POST',
          },
        }, { DEBUG: 'false', CORS_ORIGINS: 'http://localhost:5500' });

        const allowOrigin = res.headers.get('access-control-allow-origin');
        expect(allowOrigin === null || allowOrigin === '').toBe(true);
      });

      it('exposes essential streaming and pagination headers (Content-Length, Content-Range, ETag, Accept-Ranges, Set-Cookie)', async () => {
        const res = await app.request('/health', {
          headers: { Origin: 'http://localhost:5500' },
        }, { DEBUG: 'true' });

        const exposed = res.headers.get('access-control-expose-headers');
        expect(exposed).toContain('Content-Length');
        expect(exposed).toContain('Content-Range');
        expect(exposed).toContain('ETag');
        expect(exposed).toContain('Accept-Ranges');
        expect(exposed).toContain('Set-Cookie');
      });
    });
  });

  // =========================================================================
  // 5. STATIC SPA SERVING & CACHE-CONTROL HEADERS
  // =========================================================================
  describe('Category 5: Static SPA Serving & Headers', () => {
    it('GET / serves student SPA with status 200 and exact Cache-Control: no-cache', async () => {
      const res = await app.request('/');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      const body = await res.text();
      expect(body).toContain('<!DOCTYPE html>');
      expect(body).toContain('Kiur');
      expect(body.length).toBeGreaterThan(5000);
    });

    it('GET /admin serves admin dashboard SPA with status 200 and exact Cache-Control: no-cache', async () => {
      const res = await app.request('/admin');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      const body = await res.text();
      expect(body).toContain('<!DOCTYPE html>');
      expect(body).toContain('لوحة التحكم');
      expect(body.length).toBeGreaterThan(5000);
    });

    it('GET /admin/ (trailing slash) serves admin dashboard SPA identically', async () => {
      const res = await app.request('/admin/');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      const body = await res.text();
      expect(body).toContain('<!DOCTYPE html>');
      expect(body).toContain('لوحة التحكم');
    });

    it('GET /health returns 200 {"status": "ok"} with application/json', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const json = await res.json();
      expect(json).toEqual({ status: 'ok' });
    });

    it('supports c.env.ASSETS fallback mock when running inside Cloudflare Workers', async () => {
      const mockAssetFetcher: any = {
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          if (url.pathname === '/nabd-home-quiz-prototype.html') {
            return new Response('<html><body>ASSETS Student SPA</body></html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            });
          }
          if (url.pathname === '/nabd-admin-dashboard.html') {
            return new Response('<html><body>ASSETS Admin SPA</body></html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            });
          }
          return new Response('Not found in assets', { status: 404 });
        },
      };

      const resStudent = await app.request('/', {}, { ASSETS: mockAssetFetcher });
      expect(resStudent.status).toBe(200);
      expect(resStudent.headers.get('cache-control')).toBe('no-cache');
      expect(resStudent.headers.get('content-type')).toBe('text/html; charset=utf-8');
      const bodyStudent = await resStudent.text();
      expect(bodyStudent).toBe('<html><body>ASSETS Student SPA</body></html>');

      const resAdmin = await app.request('/admin', {}, { ASSETS: mockAssetFetcher });
      expect(resAdmin.status).toBe(200);
      expect(resAdmin.headers.get('cache-control')).toBe('no-cache');
      expect(resAdmin.headers.get('content-type')).toBe('text/html; charset=utf-8');
      const bodyAdmin = await resAdmin.text();
      expect(bodyAdmin).toBe('<html><body>ASSETS Admin SPA</body></html>');
    });

    it('HEAD requests on /, /admin, and /health return 200 with headers but empty body', async () => {
      const resRoot = await app.request('/', { method: 'HEAD' });
      expect(resRoot.status).toBe(200);
      expect(resRoot.headers.get('cache-control')).toBe('no-cache');
      const textRoot = await resRoot.text();
      expect(textRoot).toBe('');

      const resAdmin = await app.request('/admin', { method: 'HEAD' });
      expect(resAdmin.status).toBe(200);
      expect(resAdmin.headers.get('cache-control')).toBe('no-cache');
      const textAdmin = await resAdmin.text();
      expect(textAdmin).toBe('');

      const resHealth = await app.request('/health', { method: 'HEAD' });
      expect(resHealth.status).toBe(200);
      const textHealth = await resHealth.text();
      expect(textHealth).toBe('');
    });
  });
});
