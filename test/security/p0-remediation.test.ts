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

  // ──────────────────────────────────────────────────────────────────────────
  // P0-3: Atomic Session sid to sub Binding Enforcement
  // ──────────────────────────────────────────────────────────────────────────
  describe('P0-3: Strict Atomic Session sid to sub Binding Enforcement', () => {
    it('rejects JWT where sid belongs to user A but sub is set to user B', async () => {
      const userA = ctx.fixtures.users.student;
      const userB = ctx.fixtures.users.admin;

      // Forged cross-session token: sub = user B (admin), but sid = user A (student session)
      const forgedToken = ctx.createAuthToken(userB.id, 'admin', userA.sessionId);

      const res = await apiRequest(app, 'GET', '/auth/me', {
        token: forgedToken,
      }, ctx);

      // Must be rejected with 401 Unauthorized because session.user_id !== sub
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.detail).toContain('تم تسجيل الدخول من جهاز آخر');
    });

    it('accepts JWT where sid belongs to sub and session is active', async () => {
      const userA = ctx.fixtures.users.student;
      const validToken = ctx.createAuthToken(userA.id, 'student', userA.sessionId);

      const res = await apiRequest(app, 'GET', '/auth/me', {
        token: validToken,
      }, ctx);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe(userA.id);
    });

    it('rejects /auth/session/restore when token sid belongs to a different user', async () => {
      const userA = ctx.fixtures.users.student;
      const userB = ctx.fixtures.users.admin;

      // Mismatched token
      const forgedToken = ctx.createAuthToken(userB.id, 'admin', userA.sessionId);

      const res = await apiRequest(app, 'POST', '/auth/session/restore', {
        headers: {
          Cookie: `nabd_session=${forgedToken}`,
        },
      }, ctx);

      expect(res.status).toBe(401);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // P0-4: Cryptographic Firebase JWT Verification & No Parse-Only Fallback
  // ──────────────────────────────────────────────────────────────────────────
  describe('P0-4: Cryptographic Firebase JWT Verification Enforcement', () => {
    it('returns 503 fail-closed when Firebase is not configured on server', async () => {
      // 1. Get flow nonce
      const flowRes = await apiRequest(app, 'POST', '/auth/firebase/flow', {}, ctx);
      const cookie = flowRes.headers.get('set-cookie')?.split(';')[0] || '';
      const flowData = await flowRes.json();

      // Ensure FIREBASE_AUTH_PROJECT_ID is empty
      const noFbCtx = {
        ...ctx,
        bindings: {
          ...ctx.bindings,
          FIREBASE_AUTH_PROJECT_ID: '',
        },
      };

      const res = await apiRequest(app, 'POST', '/auth/firebase/verify', {
        headers: { Cookie: cookie },
        body: { idToken: 'some.valid-looking.jwt', nonce: flowData.flow_nonce },
      }, noFbCtx);

      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.code).toBe('FIREBASE_NOT_CONFIGURED');
    });

    it('rejects self-signed or forged token with 401 when verified against Google JWKS (no parse-only fallback)', async () => {
      // 1. Get flow nonce
      const flowRes = await apiRequest(app, 'POST', '/auth/firebase/flow', {}, ctx);
      const cookie = flowRes.headers.get('set-cookie')?.split(';')[0] || '';
      const flowData = await flowRes.json();

      const fbCtx = {
        ...ctx,
        bindings: {
          ...ctx.bindings,
          FIREBASE_AUTH_PROJECT_ID: 'kiur-medical-prod',
        },
      };

      const fakeHeader = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const fakePayload = Buffer.from(JSON.stringify({
        aud: 'kiur-medical-prod',
        iss: 'https://securetoken.google.com/kiur-medical-prod',
        sub: 'forged_firebase_uid',
        email: 'forged@firebase.com',
        email_verified: true,
        firebase: { sign_in_provider: 'google.com' },
      })).toString('base64url');
      const forgedToken = `${fakeHeader}.${fakePayload}.fake_signature_bytes`;

      const res = await apiRequest(app, 'POST', '/auth/firebase/verify', {
        headers: { Cookie: cookie },
        body: { idToken: forgedToken, nonce: flowData.flow_nonce },
      }, fbCtx);

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.code).toBe('INVALID_ID_TOKEN_SIGNATURE');
    });
  });
});
