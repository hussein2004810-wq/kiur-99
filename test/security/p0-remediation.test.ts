import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { apiRequest } from '../harness/app';
import mainApp from '../../src/index';

describe('P0 Security Vulnerability Remediation Suite', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = mainApp;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // P0-1: Google Authentication Bypass & Admin Privilege Escalation
  // ──────────────────────────────────────────────────────────────────────────
  describe('P0-1: Google Auth Bypass & Admin Escalation Hardening', () => {
    it('rejects unauthenticated email login via POST /auth/google/login with 405 Method Not Allowed', async () => {
      const res = await apiRequest(app, 'POST', '/auth/google/login', {
        body: {
          email: 'attacker@evil.com',
          next: 'admin',
        },
      }, ctx);

      expect(res.status).toBe(405);
      const data = await res.json();
      expect(data.detail).toContain('غير مدعومة');

      // Verify no user was created
      const user = await ctx.db.prepare('SELECT * FROM users WHERE email = ?').bind('attacker@evil.com').first();
      expect(user).toBeNull();
    });

    it('rejects POST /auth/google/verify with direct email payload and no cryptographic token', async () => {
      const res = await apiRequest(app, 'POST', '/auth/google/verify', {
        body: {
          email: 'attacker@evil.com',
          name: 'Hacker',
          next: 'admin',
        },
      }, ctx);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.detail).toContain('مفقود');

      // Verify no admin account was created
      const user = await ctx.db.prepare('SELECT * FROM users WHERE email = ?').bind('attacker@evil.com').first();
      expect(user).toBeNull();
    });

    it('rejects forged JWT with fake_signature on POST /auth/google/verify with 401 Unauthorized', async () => {
      const forgedPayload = {
        email: 'forged_admin@gmail.com',
        name: 'Forged Admin',
        sub: 'google_forged_999999',
        picture: 'https://lh3.googleusercontent.com/test.jpg',
        email_verified: true,
      };
      const headerB64 = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const payloadB64 = Buffer.from(JSON.stringify(forgedPayload)).toString('base64url');
      const forgedJwt = `${headerB64}.${payloadB64}.completely_fake_signature_bytes`;

      const res = await apiRequest(app, 'POST', '/auth/google/verify', {
        body: {
          credential: forgedJwt,
          next: 'admin',
        },
      }, ctx);

      expect([401, 503]).toContain(res.status);

      // Verify no admin user was created in database
      const user = await ctx.db.prepare('SELECT * FROM users WHERE email = ?').bind('forged_admin@gmail.com').first();
      expect(user).toBeNull();
    });

    it('returns 503 fail-closed on GET /auth/google/login when Google OAuth is not configured', async () => {
      // ctx.bindings has no GOOGLE_CLIENT_ID
      const res = await apiRequest(app, 'GET', '/auth/google/login?next=admin', {}, ctx);
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.detail).toContain('غير مهيأة');
    });

    it('rejects GET /auth/google/callback when oauth_state cookie is missing (CSRF defense)', async () => {
      (ctx.bindings as any).GOOGLE_CLIENT_ID = 'test-client-id';
      (ctx.bindings as any).GOOGLE_CLIENT_SECRET = 'test-client-secret';

      const res = await apiRequest(app, 'GET', '/auth/google/callback?code=some_oauth_code&state=admin:fake_nonce', {
        // No Cookie header sent
      }, ctx);

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.detail).toContain('CSRF Detected');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // P0-2: JWT Secret & Production Fail-Closed Configuration
  // ──────────────────────────────────────────────────────────────────────────
  describe('P0-2: Production Secret & Fail-Closed Bootstrapping Validation', () => {
    it('fails closed with 500 when JWT_SECRET is empty in production mode (DEBUG=false)', async () => {
      const prodCtx = {
        ...ctx,
        bindings: {
          ...ctx.bindings,
          DEBUG: 'false',
          JWT_SECRET: '',
        },
      };

      const res = await apiRequest(app, 'GET', '/health', {}, prodCtx);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.detail).toBeDefined();
    });

    it('fails closed when a known insecure secret placeholder is used in production', async () => {
      const prodCtx = {
        ...ctx,
        bindings: {
          ...ctx.bindings,
          DEBUG: 'false',
          JWT_SECRET: 'super-secret-secure-random-token-kiur-99-prod-2026',
        },
      };

      const res = await apiRequest(app, 'GET', '/health', {}, prodCtx);
      expect(res.status).toBe(500);
    });

    it('fails closed when JWT_SECRET is shorter than 32 characters in production', async () => {
      const prodCtx = {
        ...ctx,
        bindings: {
          ...ctx.bindings,
          DEBUG: 'false',
          JWT_SECRET: 'too-short-secret',
        },
      };

      const res = await apiRequest(app, 'GET', '/health', {}, prodCtx);
      expect(res.status).toBe(500);
    });

    it('allows valid requests when JWT_SECRET is >= 32 characters in production', async () => {
      const prodCtx = {
        ...ctx,
        bindings: {
          ...ctx.bindings,
          DEBUG: 'false',
          JWT_SECRET: 'valid-secure-production-secret-with-at-least-32-characters!',
        },
      };

      const res = await apiRequest(app, 'GET', '/health', {}, prodCtx);
      expect(res.status).toBe(200);
    });
  });
});
