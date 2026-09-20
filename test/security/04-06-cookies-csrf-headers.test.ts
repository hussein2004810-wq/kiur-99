import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, type TestContext } from '../harness/test-context';
import { apiRequest } from '../harness/app';
import app from '../../src/index';

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
      expect(res.headers.get('Content-Security-Policy')).toContain('https://accounts.google.com');
      expect(res.headers.get('Content-Security-Policy')).not.toContain('cdn.jsdelivr.net');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
      expect(res.headers.get('Permissions-Policy')).toContain('camera=()');
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

    it('security.headers.hsts: attaches HSTS when DEBUG=false', async () => {
      const prodBindings = { ...ctx.bindings, DEBUG: 'false' };
      const res = await app.request('/health', {}, prodBindings);
      expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
    });
  });
});
