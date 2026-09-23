import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestContext, type TestContext } from '../harness/test-context';
import { apiRequest } from '../harness/app';
import app from '../../src/index';
import { CSP_POLICY } from '../../src/middleware/security-headers';

describe('Stages 4, 5 & 6: Cookies, CSRF, CORS and Security Headers', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  describe('Stage 4: Cookie Policy', () => {
    it('security.cookie.attributes: sets HttpOnly, SameSite=Lax, and narrow Path=/auth/session', async () => {
      const res = await apiRequest(app, 'POST', '/auth/login', {
        body: { email: ctx.fixtures.users.student.email, password: 'Nabd@2026' },
      }, ctx);

      expect(res.status).toBe(200);
      const cookie = res.headers.get('set-cookie');
      expect(cookie).toBeDefined();
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/auth/session');
    });
  });

  describe('Stage 5: Origin, CSRF and CORS', () => {
    it('security.http.cross-site-mutation: rejects cross-site state-changing request', async () => {
      const res = await app.request('/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Sec-Fetch-Site': 'cross-site',
        },
        body: JSON.stringify({
          email: 'evil@attacker.com',
          password: 'Password@2026',
          full_name: 'Attacker',
        }),
      }, ctx.bindings);

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.detail).toContain('Cross-Site Request Rejected');
    });

    it('security.http.untrusted-origin: rejects mutation from untrusted Origin', async () => {
      const res = await app.request('/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://malicious-phishing-site.com',
        },
        body: JSON.stringify({
          email: 'phish@target.com',
          password: 'Password@2026',
          full_name: 'Victim',
        }),
      }, ctx.bindings);

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.detail).toContain('Untrusted Origin Rejected');
    });

    it('security.http.cookie-mutation-without-browser-provenance: rejects an ambiguous session-cookie mutation', async () => {
      const res = await app.request('/auth/session/restore', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'nabd_session=untrusted-session-token',
        },
        body: '{}',
      }, ctx.bindings);

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.detail).toContain('مصدر المتصفح غير متحقق');
    });

    it('allows mutation from approved origin', async () => {
      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'http://localhost:8787',
        },
        body: JSON.stringify({
          email: ctx.fixtures.users.student.email,
          password: 'Nabd@2026',
        }),
      }, ctx.bindings);

      expect(res.status).toBe(200);
    });
  });

  describe('Stage 6: Centralized Security Headers & CSP', () => {
    it('security.headers.baseline: attaches CSP, nosniff, frame-options, and permissions-policy on 200 response', async () => {
      const res = await app.request('/health', {}, ctx.bindings);
      expect(res.status).toBe(200);

      expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
      expect(res.headers.get('Content-Security-Policy')).toContain("object-src 'none'");
      expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('Content-Security-Policy')).toContain("form-action 'self'");
      expect(res.headers.get('Content-Security-Policy')).toContain("base-uri 'none'");
      expect(res.headers.get('Content-Security-Policy')).toContain('https://accounts.google.com');
      expect(res.headers.get('Content-Security-Policy')).toContain("script-src-attr 'unsafe-inline'");
      expect(res.headers.get('Content-Security-Policy')).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(res.headers.get('Content-Security-Policy')).not.toContain('cdn.jsdelivr.net');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(res.headers.get('Permissions-Policy')).toContain('camera=()');
      expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin-allow-popups');
      expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
      expect(res.headers.get('Origin-Agent-Cluster')).toBe('?1');
    });

    it('security.headers.inline-script-hashes: allows only the served SPA inline scripts', () => {
      for (const file of ['public/nabd-home-quiz-prototype.html', 'public/nabd-admin-dashboard.html']) {
        const html = readFileSync(resolve(process.cwd(), file), 'utf8');
        const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
        for (const script of scripts) {
          if (!script[1]) continue; // external script tag
          // The HTML parser normalizes CRLF/CR to LF before CSP hashes are
          // checked against an inline script's text content.
          const normalizedScript = script[1].replace(/\r\n?/g, '\n');
          const hash = createHash('sha256').update(normalizedScript, 'utf8').digest('base64');
          expect(CSP_POLICY).toContain(`'sha256-${hash}'`);
        }
      }
    });

    it('security.headers.errors: attaches security headers on 404 responses', async () => {
      const res = await app.request('/non-existent-route-99', {}, ctx.bindings);
      expect(res.status).toBe(404);

      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Content-Security-Policy')).toBeDefined();
    });

    it('security.headers.spa: attaches the CSP to the served student SPA', async () => {
      const res = await app.request('/', {}, ctx.bindings);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Security-Policy')).toContain("form-action 'self'");
    });

    it('security.headers.spa-assets: serves both SPA entry points through the Worker Assets binding when available', async () => {
      const requestedPaths: string[] = [];
      const bindings = {
        ...ctx.bindings,
        ASSETS: {
          fetch: async (request: Request) => {
            const path = new URL(request.url).pathname;
            requestedPaths.push(path);
            return new Response(`asset:${path}`, {
              headers: {
                'Content-Type': 'text/html',
                'Content-Security-Policy': "default-src 'none'; script-src 'self'",
                ETag: '"asset-version"',
              },
            });
          },
        },
      };

      const [studentRes, adminRes] = await Promise.all([
        app.request('/', {}, bindings),
        app.request('/admin/', {}, bindings),
      ]);

      expect(requestedPaths.sort()).toEqual([
        '/nabd-admin-dashboard.html',
        '/nabd-home-quiz-prototype.html',
      ]);
      expect(await studentRes.text()).toBe('asset:/nabd-home-quiz-prototype.html');
      expect(await adminRes.text()).toBe('asset:/nabd-admin-dashboard.html');
      expect(studentRes.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(adminRes.headers.get('Cache-Control')).toBe('no-cache');
      expect(studentRes.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
      expect(adminRes.headers.get('Content-Security-Policy')).toContain('https://www.gstatic.com');
      expect(studentRes.headers.get('ETag')).toBeNull();
    });

    it('security.headers.hsts: attaches HSTS when DEBUG=false', async () => {
      const prodBindings = { ...ctx.bindings, DEBUG: 'false' };
      const res = await app.request('/health', {}, prodBindings);
      expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
    });
  });
});
