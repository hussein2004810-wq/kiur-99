import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createTestContext, TestContext } from '../harness/test-context';
import { apiRequest } from '../harness/app';
import mainApp from '../../src/index';
import { hashResetToken } from '../../src/services/crypto';
import { emailConfigured } from '../../src/services/mailer';
import { resolveAllowedOrigin } from '../../src/middleware/cors';

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

  it('consumes an email-verification link through the GET callback', async () => {
    const rawToken = 'verify_callback_token_0123456789';
    const tokenHash = await hashResetToken(rawToken);
    await ctx.db.prepare("INSERT INTO users (id, email, full_name, password_hash, role) VALUES ('usr_verify_link', 'verify-link@nabd.app', 'طالب التحقق', 'hash', 'student')").run();
    await ctx.db.prepare("INSERT INTO email_verifications (id, user_id, token_hash, expires_at) VALUES ('ver_verify_link', 'usr_verify_link', ?, ?)").bind(tokenHash, new Date(Date.now() + 3600000).toISOString()).run();

    const res = await app.request(`/auth/verify-email?token=${rawToken}`, {}, ctx.bindings);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/#email_verified=1');
    expect(await ctx.db.prepare("SELECT email_verified_at FROM users WHERE id = 'usr_verify_link'").first('email_verified_at')).toBeTruthy();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // P0-1: Google Authentication Bypass & Admin Privilege Escalation
  // ──────────────────────────────────────────────────────────────────────────
  describe('P0-1: Google Auth Bypass & Admin Escalation Hardening', () => {
    it('registers an unverified caller only as a student and without a usable session', async () => {
      const res = await apiRequest(app, 'POST', '/auth/register', {
        body: {
          email: 'role-escalation@nabd.app',
          full_name: 'طالب غير موثق',
          password: 'Password123!',
          role: 'admin',
        },
      }, ctx);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.role).toBe('student');
      expect(data.requires_email_verification).toBe(true);
      expect(data.access_token).toBeUndefined();
      expect(res.headers.get('set-cookie')).toBeNull();

      const user = await ctx.db.prepare('SELECT id, role, email_verified_at FROM users WHERE email = ?').bind('role-escalation@nabd.app').first<any>();
      expect(user).toMatchObject({ role: 'student', email_verified_at: null });
      const sessions = await ctx.db.prepare('SELECT COUNT(*) AS count FROM user_sessions WHERE user_id = ?').bind(user.id).first<number>('count');
      expect(sessions).toBe(0);

      const login = await apiRequest(app, 'POST', '/auth/login', {
        body: { email: 'role-escalation@nabd.app', password: 'Password123!' },
      }, ctx);
      expect(login.status).toBe(403);
    });

    it('rejects passwords outside the shared 10-to-128-character policy', async () => {
      for (const password of ['Short123!', 'a'.repeat(129)]) {
        const res = await apiRequest(app, 'POST', '/auth/register', {
          body: { email: `policy-${password.length}@nabd.app`, full_name: 'اختبار السياسة', password },
        }, ctx);
        expect(res.status).toBe(400);
      }
    });

    it('fails closed when DEBUG is missing, including the development-only login route', async () => {
      const res = await app.request('/auth/dev-login?email=debug-missing@nabd.app', { method: 'POST' }, {
        ...ctx.bindings,
        DEBUG: undefined,
        JWT_SECRET: 'valid-secure-production-secret-with-at-least-32-characters!',
        CORS_ORIGINS: 'https://app.kiur.edu.iq',
      });
      expect(res.status).toBe(404);

      const authSource = await readFile(new URL('../../src/routes/auth.ts', import.meta.url), 'utf8');
      expect(authSource).not.toContain("DEBUG ?? 'true'");
    });

    it('never returns a password-reset token when DEBUG is false', async () => {
      const res = await app.request('/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'student@nabd.app' }),
      }, {
        ...ctx.bindings,
        DEBUG: 'false',
        JWT_SECRET: 'valid-secure-production-secret-with-at-least-32-characters!',
        CORS_ORIGINS: 'https://app.kiur.edu.iq',
      });
      expect(res.status).toBe(200);
      expect((await res.json()).debug_token).toBeUndefined();
    });

    it('fails closed for localhost CORS origins when production origins are unset', () => {
      expect(resolveAllowedOrigin('http://localhost:8787', { DEBUG: 'false', CORS_ORIGINS: '' } as any)).toBeNull();
      expect(resolveAllowedOrigin('http://localhost:8787', { DEBUG: 'true', CORS_ORIGINS: '' } as any)).toBe('http://localhost:8787');
    });

    it('does not create an unactivatable password account in production when mail is unavailable', async () => {
      const res = await apiRequest(app, 'POST', '/auth/register', {
        body: {
          email: 'mail-unavailable@nabd.app',
          full_name: 'طالب بلا بريد',
          password: 'Password123!',
        },
      }, {
        ...ctx,
        bindings: {
          ...ctx.bindings,
          DEBUG: 'false',
          JWT_SECRET: 'valid-secure-production-secret-with-at-least-32-characters!',
          CORS_ORIGINS: 'https://app.kiur.edu.iq',
          SMTP_HOST: '',
          SMTP_PASSWORD: '',
        },
      });

      expect(res.status).toBe(503);
      expect(await ctx.db.prepare('SELECT id FROM users WHERE email = ?').bind('mail-unavailable@nabd.app').first()).toBeNull();
    });

    it('requires a supported mail provider and secret before treating email delivery as configured', () => {
      expect(emailConfigured({ smtpHost: 'resend', smtpFrom: 'no-reply@kiur.edu', smtpPassword: '' })).toBe(false);
      expect(emailConfigured({ smtpHost: 'smtp.example.test', smtpFrom: 'no-reply@kiur.edu', smtpPassword: 'key' })).toBe(false);
      expect(emailConfigured({ smtpHost: 'resend', smtpFrom: 'no-reply@kiur.edu', smtpPassword: 'key' })).toBe(true);
    });

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

    it('rate-limits both Google Identity flow endpoints before they can be abused', async () => {
      const [authSource, limiterSource] = await Promise.all([
        readFile(new URL('../../src/routes/auth.ts', import.meta.url), 'utf8'),
        readFile(new URL('../../src/middleware/rate-limit.ts', import.meta.url), 'utf8'),
      ]);

      expect(authSource).toContain("authRouter.post('/google/flow', googleIdentityRateLimiter");
      expect(authSource).toContain("authRouter.post('/google/verify', googleIdentityRateLimiter");
      expect(limiterSource).toContain("googleIdentityRateLimiter = rateLimiter({ max: 10, windowSeconds: 60, keyPrefix: 'rl:google-identity' })");
    });

    it('rejects a Google access token because it is not an audience-bound ID credential', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch');
      try {
        const res = await apiRequest(app, 'POST', '/auth/google/verify', {
          body: { access_token: 'google_access_token_from_another_client' },
        }, ctx);

        expect(res.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        fetchMock.mockRestore();
      }
    });

    it('rejects a Google credential with no browser-bound GIS flow nonce before consulting JWKS', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch');
      try {
        const res = await apiRequest(app, 'POST', '/auth/google/verify', {
          body: { credential: 'not-used-without-flow-cookie' },
        }, {
          ...ctx,
          bindings: { ...ctx.bindings, GOOGLE_CLIENT_ID: 'kiur-client-id.apps.googleusercontent.com' },
        });

        expect(res.status).toBe(403);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        fetchMock.mockRestore();
      }
    });

    it('rejects a cryptographically valid Google ID token issued for another OAuth client', async () => {
      const googleBindings = { ...ctx.bindings, GOOGLE_CLIENT_ID: 'kiur-client-id.apps.googleusercontent.com' };
      const flowRes = await app.request('/auth/google/flow', { method: 'POST' }, googleBindings);
      expect(flowRes.status).toBe(200);
      const flowCookie = flowRes.headers.get('set-cookie')?.split(';')[0] || '';
      const flow = await flowRes.json<{ flow_nonce: string }>();
      const { publicKey, privateKey } = await generateKeyPair('RS256');
      const jwk = await exportJWK(publicKey);
      Object.assign(jwk, { kid: 'google-test-key-wrong-audience', use: 'sig', alg: 'RS256' });
      const credential = await new SignJWT({
        email: 'wrong-audience@nabd.app',
        name: 'رمز لجمهور آخر',
        email_verified: true,
        nonce: flow.flow_nonce,
      })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
        .setSubject('google_wrong_audience')
        .setIssuer('https://accounts.google.com')
        .setAudience('other-client-id.apps.googleusercontent.com')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));

      try {
        const res = await apiRequest(app, 'POST', '/auth/google/verify', {
          headers: { Cookie: flowCookie },
          body: { credential },
        }, {
          ...ctx,
          bindings: googleBindings,
        });

        expect(res.status).toBe(401);
        expect((await res.json()).detail).toContain('غير صالح');
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(await ctx.db.prepare('SELECT id FROM users WHERE email = ?').bind('wrong-audience@nabd.app').first()).toBeNull();
        const [authSource, verifierSource] = await Promise.all([
          readFile(new URL('../../src/routes/auth.ts', import.meta.url), 'utf8'),
          readFile(new URL('../../src/services/google-identity.ts', import.meta.url), 'utf8'),
        ]);
        expect(authSource).not.toContain('oauth2.googleapis.com/tokeninfo');
        expect(verifierSource).toContain('createRemoteJWKSet');
        expect(verifierSource).toContain("algorithms: ['RS256']");
        expect(verifierSource).toContain('maxTokenAge');
        expect(verifierSource).toContain('payload.nonce !== expectedNonce');
      } finally {
        fetchMock.mockRestore();
      }
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

    it('does not create or sign in a user when the OAuth userinfo email is unverified', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'google_access_token' }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          email: 'unverified-oauth@nabd.app',
          name: 'طالب غير موثق عبر Google',
          sub: 'google_unverified_oauth',
          email_verified: false,
        }), { status: 200 }));

      try {
        const res = await apiRequest(app, 'GET', '/auth/google/callback?code=valid_code&state=student:valid_nonce', {
          headers: { Cookie: 'oauth_state=student:valid_nonce' },
        }, {
          ...ctx,
          bindings: {
            ...ctx.bindings,
            GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
            GOOGLE_CLIENT_SECRET: 'test-client-secret',
          },
        });

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('#google_error=email_unverified');
        expect(await ctx.db.prepare('SELECT id FROM users WHERE email = ?').bind('unverified-oauth@nabd.app').first()).toBeNull();
      } finally {
        fetchMock.mockRestore();
      }
    });

    it('marks an existing password account verified only after a verified OAuth callback', async () => {
      await ctx.db.prepare("INSERT INTO users (id, email, full_name, password_hash, role) VALUES ('usr_oauth_upgrade', 'oauth-upgrade@nabd.app', 'طالب OAuth', 'hash', 'student')").run();
      const fetchMock = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'google_access_token' }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          email: 'oauth-upgrade@nabd.app',
          name: 'طالب OAuth',
          sub: 'google_verified_upgrade',
          email_verified: true,
        }), { status: 200 }));

      try {
        const res = await apiRequest(app, 'GET', '/auth/google/callback?code=valid_code&state=student:verified_nonce', {
          headers: { Cookie: 'oauth_state=student:verified_nonce' },
        }, {
          ...ctx,
          bindings: {
            ...ctx.bindings,
            GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
            GOOGLE_CLIENT_SECRET: 'test-client-secret',
          },
        });

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('#access_token=');
        expect(await ctx.db.prepare("SELECT email_verified_at FROM users WHERE id = 'usr_oauth_upgrade'").first('email_verified_at')).toBeTruthy();
      } finally {
        fetchMock.mockRestore();
      }
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
          CORS_ORIGINS: 'https://app.kiur.edu.iq',
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

  // ──────────────────────────────────────────────────────────────────────────
  // P0-5: Stored XSS Prevention & CSP Hardening
  // ──────────────────────────────────────────────────────────────────────────
  describe('P0-5: Stored XSS Prevention & CSP Hardening', () => {
    it('escapes persisted text before interpolating it into the served SPA HTML', async () => {
      const [homeHtml, adminHtml] = await Promise.all([
        readFile(new URL('../../public/nabd-home-quiz-prototype.html', import.meta.url), 'utf8'),
        readFile(new URL('../../public/nabd-admin-dashboard.html', import.meta.url), 'utf8'),
      ]);

      // These sources are served directly by src/routes/static.ts.  Keep the
      // escaping at the rendering boundary so malicious profile, catalogue,
      // and question text stays text even if old database data predates the
      // server-side input validator.
      expect(homeHtml).toContain('tags.map(tg => `<span class="prof-tag">${esc(tg)}</span>`).join(\'\')');
      expect(homeHtml).toContain("p.uni ? ' · ' + esc(p.uni) : ''");
      expect(adminHtml).toContain('<div class="item-title">${esc(name)}</div>');
      expect(adminHtml).toContain("(c.is_correct ? '✓ ' : '• ') + esc(c.text)");
      expect(homeHtml).toContain('function jsArg(value)');
      expect(homeHtml).toContain('bsQuickStart(${jsArg(sub.id)}, ${jsArg(sub.name)})');
      expect(homeHtml).toContain('openProfessor(${jsArg(p.id)})');
      expect(homeHtml).toContain('recordRecentView(\'booklet\',${jsArg(b.id)})');
      expect(homeHtml).toContain("return esc(clean.split(' ').map(w => w[0]).slice(0, 2).join(''));");
      expect(homeHtml).toContain("initials(currentUser.full_name || '')");
      expect(homeHtml).toContain("initials(s.full_name || '')");
      expect(homeHtml).toContain("initials(p.full_name || '')");
      expect(homeHtml).toContain('order.granted_activation_codes.map(c => `<div class="mono" style="font-size:.85rem;">${esc(c)}</div>`).join(\'\')');
      expect(homeHtml).toContain('<span class="mono">${esc(order.id)}</span>');
      expect(homeHtml).toContain('${esc(PRODUCT_TYPE_BADGE[p.type] || p.type)}');
      expect(homeHtml).not.toContain("startExam('${e.id}')");
      expect(homeHtml).not.toContain("body: JSON.stringify({ email, name, next: 'student' })");
      expect(adminHtml).toContain('function jsArg(value)');
      expect(adminHtml).toContain("function initialsOf(name){ return esc((name||'').trim().split(' ').map(w=>w[0]).slice(0,2).join('')); }");
      expect(adminHtml).toContain("const safeRole = Object.hasOwn(map, role) ? role : 'unknown';");
      expect(adminHtml).toContain('${esc(statusLabel[c.status] || c.status)}');
      expect(adminHtml).toContain('${esc(data.secret)}');
      expect(adminHtml).toContain("const safeInputTypes = new Set(['text', 'password', 'number', 'email', 'url', 'tel']);");
      expect(adminHtml).toContain("const rows = Number.isInteger(Number(f.rows)) ? Math.max(1, Math.min(20, Number(f.rows))) : 8;");
      expect(adminHtml).toContain('<span class="weak-label">${esc(label)}</span>');
      expect(adminHtml).toContain('deleteUniversity(${jsArg(u.id)}, ${jsArg(u.name)})');

      // URL values need a separate allowlist: entity escaping does not stop
      // javascript:, data:, or off-origin URLs when placed in src/href.
      for (const html of [homeHtml, adminHtml]) {
        expect(html).toContain('function safeMediaUrl(value)');
        expect(html).toContain("if (!/^\\/(?:media-files|api\\/media)\\//.test(path)) return '';");
      }
      expect(homeHtml).toContain('esc(safeMediaUrl(currentUser.photo_url))');
      expect(homeHtml).toContain('const videoUrl = safeMediaUrl(lec.videoUrl);');
      expect(adminHtml).toContain('esc(safeMediaUrl(d.professor.photo_url))');
      expect(adminHtml).toContain('value="${esc(o.value)}"');
      expect(adminHtml).toContain('subjects.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join(\'\')');
      expect(homeHtml).toContain('tree.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join(\'\')');
      expect(homeHtml).not.toContain('<option value="${s.id}">${esc(s.name)}</option>');
      expect(adminHtml).not.toContain('msgEl.innerHTML = opts.html');
      expect(adminHtml).toContain('promptEditUser(${jsArg(a.id)})');
      expect(adminHtml).toContain('actGlimpse(${jsArg(p.id)}, \'archive\')');
      expect(adminHtml).toContain('triggerBookletUpload(${jsArg(b.id)})');
      expect(adminHtml).toContain('triggerLectureUpload(${jsArg(l.id)})');
      expect(adminHtml).toContain('actGlimpse(${jsArg(p.id)}, \'approve\')');
      expect(adminHtml).toContain('updateOrderStatus(${jsArg(o.id)}, this.value)');
      expect(adminHtml).toContain('id="uni-card-${esc(u.id)}"');
    });

    it('rejects skill input containing HTML or script tags with 400', async () => {
      const student = ctx.fixtures.users.student;
      const token = ctx.createAuthToken(student.id, 'student', student.sessionId);

      const maliciousPayloads = [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        'javascript:alert(1)',
        'Cardiology<b onmouseover=alert(1)>',
      ];

      for (const payload of maliciousPayloads) {
        const res = await apiRequest(app, 'POST', '/auth/me/skills', {
          token,
          body: { text: payload },
        }, ctx);

        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.detail).toBe('النص يحتوي على أحرف أو وسوم غير مسموح بها');
      }
    });

    it('enforces hardened Content-Security-Policy without wildcard https: for connect-src and img-src', async () => {
      const res = await apiRequest(app, 'GET', '/health', {}, ctx);
      const csp = res.headers.get('content-security-policy') || '';
      expect(csp).toBeTruthy();

      // Ensure connect-src does NOT have wild 'https:'
      const directives = csp.split(';').map(d => d.trim());
      const connectSrc = directives.find(d => d.startsWith('connect-src '));
      expect(connectSrc).toBeDefined();
      // Should not contain ' https: ' or end with ' https:'
      expect(connectSrc!.split(/\s+/)).not.toContain('https:');
      expect(connectSrc).toContain('https://identitytoolkit.googleapis.com');

      const imgSrc = directives.find(d => d.startsWith('img-src '));
      expect(imgSrc).toBeDefined();
      expect(imgSrc!.split(/\s+/)).not.toContain('https:');
      expect(imgSrc).toContain('https://lh3.googleusercontent.com');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // P0-7: Admin media uploads must be content-validated and non-overwriting
  // ──────────────────────────────────────────────────────────────────────────
  describe('P0-7: Admin Media Upload Hardening', () => {
    it('rejects a forged file before it reaches R2 even when its filename is allowed', async () => {
      const admin = ctx.fixtures.users.admin;
      const res = await apiRequest(app, 'POST', '/api/admin/media/upload', {
        token: admin.token,
        headers: { 'X-Filename': 'looks-valid.pdf', 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array([0x3c, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74]),
      }, ctx);

      expect(res.status).toBe(400);
      expect((await ctx.r2.list()).objects).toHaveLength(0);
    });

    it('stores a valid upload under a random server filename rather than the requested path', async () => {
      const admin = ctx.fixtures.users.admin;
      const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const res = await apiRequest(app, 'POST', '/api/admin/media/upload', {
        token: admin.token,
        headers: { 'X-Filename': '../../admin-photo.jpg', 'Content-Type': 'application/octet-stream' },
        body: pngHeader,
      }, ctx);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.filename).toMatch(/^admin_media_[a-f0-9]{12}\.png$/);
      expect(data.filename).not.toContain('..');
      expect(data.content_type).toBe('image/png');
      expect(await ctx.r2.head(data.filename)).not.toBeNull();
    });

    it('fails closed before reading an admin upload when R2 is unavailable', async () => {
      const admin = ctx.fixtures.users.admin;
      const res = await apiRequest(app, 'POST', '/api/admin/media/upload', {
        token: admin.token,
        headers: { 'X-Filename': 'file.png', 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      }, {
        ...ctx,
        bindings: { ...ctx.bindings, R2_BUCKET: undefined },
      });

      expect(res.status).toBe(503);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // P0-6: Correct Answer & Rationale Leakage Prevention
  // ──────────────────────────────────────────────────────────────────────────
  describe('P0-6: Correct Answer & Rationale Leakage Prevention', () => {
    it('does NOT expose is_correct or rationale in GET /api/subjects/:subject_id/questions', async () => {
      const student = ctx.fixtures.users.student;
      const token = ctx.createAuthToken(student.id, 'student', student.sessionId);

      const res = await apiRequest(app, 'GET', '/api/subjects/sub_anat/questions', {
        token,
      }, ctx);

      expect(res.status).toBe(200);
      const questions = await res.json();
      expect(Array.isArray(questions)).toBe(true);
      expect(questions.length).toBeGreaterThan(0);

      for (const q of questions) {
        // Must NOT leak rationale
        expect(q.rationale).toBeUndefined();
        expect(Array.isArray(q.choices)).toBe(true);
        expect(q.choices.length).toBeGreaterThan(0);

        for (const choice of q.choices) {
          // Must NOT leak is_correct
          expect(choice.is_correct).toBeUndefined();
          expect(choice.id).toBeDefined();
          expect(choice.text).toBeDefined();
        }
      }
    });

    it('does NOT expose is_correct or rationale in GET /api/me/saved-questions', async () => {
      const student = ctx.fixtures.users.student;
      const token = ctx.createAuthToken(student.id, 'student', student.sessionId);

      // Save a question first
      const saveRes = await apiRequest(app, 'POST', '/api/questions/qst_1/save', {
        token,
      }, ctx);
      expect(saveRes.status).toBe(200);

      // Fetch saved questions
      const res = await apiRequest(app, 'GET', '/api/me/saved-questions', {
        token,
      }, ctx);

      expect(res.status).toBe(200);
      const saved = await res.json();
      expect(Array.isArray(saved)).toBe(true);
      expect(saved.length).toBeGreaterThan(0);

      for (const q of saved) {
        expect(q.rationale).toBeUndefined();
        for (const choice of q.choices) {
          expect(choice.is_correct).toBeUndefined();
        }
      }
    });

    it('returns is_correct, correct_choice_id, and rationale ONLY AFTER answer submission', async () => {
      const student = ctx.fixtures.users.student;
      const token = ctx.createAuthToken(student.id, 'student', student.sessionId);

      const res = await apiRequest(app, 'POST', '/api/questions/qst_1/answer', {
        token,
        body: { choice_id: 'cho_1_1' },
      }, ctx);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.is_correct).toBe(true);
      expect(data.correct_choice_id).toBe('cho_1_1');
      expect(data.rationale).toBe('توضيح الإجابة الصحيحة 1');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // P0-7: Media Governance, Drizzle Operator Fix & Course Academic Entitlement
  // ──────────────────────────────────────────────────────────────────────────
  describe('P0-7: Media Governance & Course Entitlement Hardening', () => {
    it('denies access (404) to media files not registered in the database even if present in R2', async () => {
      // Put a raw secret file directly into R2 bucket
      await ctx.r2.put('internal_backup_secret.mp4', new Uint8Array([1, 2, 3, 4]), {
        httpMetadata: { contentType: 'video/mp4' },
      });

      // Request without DB mediaFiles record
      const res = await apiRequest(app, 'GET', '/media-files/internal_backup_secret.mp4', {}, ctx);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.detail).toContain('الملف غير موجود أو غير مصرح');
    });

    it('denies an ordinary orphaned object key instead of relying on filename heuristics', async () => {
      await ctx.r2.put('unregistered-lecture.mp4', new Uint8Array([1, 2, 3, 4]), {
        httpMetadata: { contentType: 'video/mp4' },
      });

      const res = await apiRequest(app, 'GET', '/media-files/unregistered-lecture.mp4', {}, ctx);
      expect(res.status).toBe(404);
    });

    it('isolates student lecture progress independently without Drizzle short-circuit bug', async () => {
      const student1 = ctx.fixtures.users.student;
      const token1 = ctx.createAuthToken(student1.id, 'student', student1.sessionId);

      // Create a second student
      const hash = '$2a$10$abcdefghijklmnopqrstuu';
      await ctx.db.prepare(
        "INSERT INTO users (id, email, full_name, password_hash, role, stage_id) VALUES ('usr_student2', 'student2@nabd.app', 'طالب ثان', ?, 'student', 'stg_2')"
      ).bind(hash).run();
      await ctx.db.prepare(
        "INSERT INTO user_sessions (id, user_id, device_label, is_active) VALUES ('ses_student2', 'usr_student2', 'Device 2', 1)"
      ).run();
      const token2 = ctx.createAuthToken('usr_student2', 'student', 'ses_student2');

      // Student 1 completes lecture lec_1
      const comp1 = await apiRequest(app, 'POST', '/api/courses/lectures/lec_1/complete', {
        token: token1,
      }, ctx);
      expect(comp1.status).toBe(200);

      // Verify in DB that only student 1 has progress record
      const s1Prog = await ctx.db.prepare(
        'SELECT * FROM lecture_progress WHERE user_id = ? AND lecture_id = ?'
      ).bind(student1.id, 'lec_1').first();
      expect(s1Prog).toBeDefined();

      const s2Prog = await ctx.db.prepare(
        'SELECT * FROM lecture_progress WHERE user_id = ? AND lecture_id = ?'
      ).bind('usr_student2', 'lec_1').first();
      expect(s2Prog).toBeNull();

      // Student 2 completes lecture lec_1
      const comp2 = await apiRequest(app, 'POST', '/api/courses/lectures/lec_1/complete', {
        token: token2,
      }, ctx);
      expect(comp2.status).toBe(200);

      const s2ProgAfter = await ctx.db.prepare(
        'SELECT * FROM lecture_progress WHERE user_id = ? AND lecture_id = ?'
      ).bind('usr_student2', 'lec_1').first();
      expect(s2ProgAfter).toBeDefined();
    });

    it('restricts course video URL and materials from students outside academic scope or without code', async () => {
      // Create stage 3 and student in stage 3 (different from anatomy course in stage 2)
      await ctx.db.prepare(
        "INSERT INTO stages (id, name, university_id) VALUES ('stg_3', 'المرحلة الثالثة', 'uni_bgd')"
      ).run();

      const hash = '$2a$10$abcdefghijklmnopqrstuu';
      await ctx.db.prepare(
        "INSERT INTO users (id, email, full_name, password_hash, role, stage_id) VALUES ('usr_outsider', 'outsider@nabd.app', 'طالب مرحلة 3', ?, 'student', 'stg_3')"
      ).bind(hash).run();
      await ctx.db.prepare(
        "INSERT INTO user_sessions (id, user_id, device_label, is_active) VALUES ('ses_outsider', 'usr_outsider', 'Device Outsider', 1)"
      ).run();
      const outsiderToken = ctx.createAuthToken('usr_outsider', 'student', 'ses_outsider');

      // 1. Check course syllabus: video_url must be null for outsider
      const courseRes = await apiRequest(app, 'GET', `/api/courses/${ctx.fixtures.courseId}`, {
        token: outsiderToken,
      }, ctx);
      expect(courseRes.status).toBe(200);
      const courseData = await courseRes.json();
      expect(courseData.entitled).toBe(false);
      for (const lec of courseData.lectures) {
        expect(lec.video_url).toBeNull();
      }

      // 2. Materials endpoint returns 403 Forbidden for outsider
      const matRes = await apiRequest(app, 'GET', `/api/courses/${ctx.fixtures.courseId}/materials`, {
        token: outsiderToken,
      }, ctx);
      expect(matRes.status).toBe(403);
      const matData = await matRes.json();
      expect(matData.detail).toContain('غير مصرح بالوصول');

      // 3. Directly accessing lecture returns 403
      const lecRes = await apiRequest(app, 'GET', '/api/lectures/lec_1', {
        token: outsiderToken,
      }, ctx);
      expect(lecRes.status).toBe(403);

      // 4. Enrolled student in stage 2 has full access
      const student1 = ctx.fixtures.users.student;
      const enrolledToken = ctx.createAuthToken(student1.id, 'student', student1.sessionId);
      const enrolledRes = await apiRequest(app, 'GET', `/api/courses/${ctx.fixtures.courseId}`, {
        token: enrolledToken,
      }, ctx);
      expect(enrolledRes.status).toBe(200);
      const enrolledData = await enrolledRes.json();
      expect(enrolledData.entitled).toBe(true);
      expect(enrolledData.lectures[0].video_url).toBeTruthy();
    });

    it('requires the checked upload route instead of accepting arbitrary lecture video URLs', async () => {
      const response = await apiRequest(app, 'POST', `/api/professors/courses/${ctx.fixtures.courseId}/lectures`, {
        token: ctx.fixtures.users.professor.token,
        body: { title: 'محاضرة برابط خارجي', video_url: 'https://example.test/video.mp4' },
      }, ctx);

      expect(response.status).toBe(400);
      expect((await response.json()).detail).toContain('رفع الفيديو');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // P0-8: Active Content Execution Prevention & Strict Magic Bytes Validation
  // ──────────────────────────────────────────────────────────────────────────
  it('P0-7: does not expose raw booklet URLs from public professor metadata', async () => {
    const professor = await apiRequest(app, 'GET', `/api/professors/${ctx.fixtures.users.professor.profileId}`, {}, ctx);
    expect(professor.status).toBe(200);
    const professorData = await professor.json();
    expect(professorData.booklets).toHaveLength(1);
    expect(professorData.booklets[0].file_url).toBeUndefined();

    const latest = await apiRequest(app, 'GET', '/api/professors/booklets/latest', {}, ctx);
    expect(latest.status).toBe(200);
    expect((await latest.json()).file_url).toBeUndefined();
  });

  describe('P0-8: Active Content Upload & Magic Bytes Validation Hardening', () => {
    it('fails closed with 503 before parsing an upload when the R2 binding is absent', async () => {
      const student = ctx.fixtures.users.student;
      (ctx.bindings as any).R2_BUCKET = undefined;

      const response = await apiRequest(app, 'POST', '/auth/me/photo', {
        token: student.token,
      }, ctx);
      expect(response.status).toBe(503);
      expect((await response.json()).detail).toContain('غير مهيأة');
    });

    it('rejects HTML or script payload disguised as image in /auth/me/photo with 400', async () => {
      const student = ctx.fixtures.users.student;
      const token = ctx.createAuthToken(student.id, 'student', student.sessionId);

      const maliciousHtml = '<!DOCTYPE html><html><body><script>alert(1)</script></body></html>';
      const fakeFile = new File([maliciousHtml], 'malicious.png', { type: 'image/png' });
      const fd = new FormData();
      fd.append('file', fakeFile);

      const res = await apiRequest(app, 'POST', '/auth/me/photo', {
        token,
        body: fd,
      }, ctx);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.detail).toContain('توقيع الملف أو نوعه الداخلي غير صالح');
    });

    it('accepts genuine PNG and serves it from /media-files with strict nosniff and CSP sandbox', async () => {
      const student = ctx.fixtures.users.student;
      const token = ctx.createAuthToken(student.id, 'student', student.sessionId);

      // Valid minimal PNG signature (8 bytes: 89 50 4E 47 0D 0A 1A 0A + dummy IHDR)
      const validPngBytes = new Uint8Array([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89
      ]);
      const validFile = new File([validPngBytes], 'profile.png', { type: 'image/png' });
      const fd = new FormData();
      fd.append('file', validFile);

      const uploadRes = await apiRequest(app, 'POST', '/auth/me/photo', {
        token,
        body: fd,
      }, ctx);

      expect(uploadRes.status).toBe(200);
      const userData = await uploadRes.json();
      expect(userData.photo_url).toBeTruthy();

      // Fetch the uploaded photo through mediaRouter
      const mediaRes = await apiRequest(app, 'GET', userData.photo_url, {}, ctx);
      expect(mediaRes.status).toBe(200);
      expect(mediaRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(mediaRes.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    });
  });
});
