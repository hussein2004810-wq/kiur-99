import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, type TestContext } from '../harness/test-context';
import { apiRequest } from '../harness/app';
import app from '../../src/index';

describe('Stages 12, 13, 14 & 15: Passwords, Reset, 2FA, and OAuth Security', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  describe('Stage 12 & 13: Password Security & Reset Enumeration Resistance', () => {
    it('security.auth.email-normalization: logins succeed case-insensitively', async () => {
      const student = ctx.fixtures.users.student;

      const res = await apiRequest(app, 'POST', '/auth/login', {
        body: {
          email: student.email.toUpperCase(),
          password: 'Nabd@2026',
        },
      }, ctx);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.access_token).toBeDefined();
    });

    it('security.auth.forgot-pw.enumeration-defense: returns identical success response whether email exists or not', async () => {
      // Provide configured mailer bindings
      const mailerCtx = {
        ...ctx,
        bindings: {
          ...ctx.bindings,
          SMTP_HOST: 'smtp.gmail.com',
          SMTP_USER: 'notifier@nabd.app',
          SMTP_PASSWORD: 'app-password',
        },
      };

      // Existing user
      const res1 = await apiRequest(app, 'POST', '/auth/forgot-password', {
        body: { email: ctx.fixtures.users.student.email },
      }, mailerCtx);

      // Non-existent user
      const res2 = await apiRequest(app, 'POST', '/auth/forgot-password', {
        body: { email: 'nonexistent-random-user-999@nabd.app' },
      }, mailerCtx);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect((await res1.json()).message).toEqual((await res2.json()).message);
    });

    it('security.auth.malformed-hash: safely fails with 401 if stored hash is corrupted or null', async () => {
      await ctx.db.exec(`
        INSERT INTO users (id, email, full_name, password_hash, role)
        VALUES ('usr_corrupt', 'corrupt@nabd.app', 'Corrupted Hash', 'invalid_corrupted_hash', 'student');
      `);

      const res = await apiRequest(app, 'POST', '/auth/login', {
        body: { email: 'corrupt@nabd.app', password: 'Password@2026' },
      }, ctx);

      expect(res.status).toBe(401);
      expect((await res.json()).detail).toBe('البريد الإلكتروني أو كلمة المرور غير صحيحة');
    });
  });

  describe('Stage 14: 2FA Protection & Secret Leakage Prevention', () => {
    it('security.2fa.secret-never-leaked: /auth/me never exposes totp_secret', async () => {
      const student = ctx.fixtures.users.student;

      // Seed a totp secret in DB
      await ctx.db.exec(`
        UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP', totp_enabled = 1 WHERE id = '${student.id}';
      `);

      const res = await apiRequest(app, 'GET', '/auth/me', { token: student.token }, ctx);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(Boolean(data.totp_enabled)).toBe(true);
      expect(data.totp_secret).toBeUndefined();
      expect(JSON.stringify(data)).not.toContain('JBSWY3DPEHPK3PXP');
    });

    it('security.2fa.disable-requires-valid-code: rejects disabling 2FA without valid TOTP code', async () => {
      const student = ctx.fixtures.users.student;

      await ctx.db.exec(`
        UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP', totp_enabled = 1 WHERE id = '${student.id}';
      `);

      // Attempt to disable with invalid code
      const disableRes = await apiRequest(app, 'POST', '/auth/2fa/disable', {
        token: student.token,
        body: { code: '000000' },
      }, ctx);

      expect(disableRes.status).toBe(403);
      expect((await disableRes.json()).detail).toContain('رمز التحقق غير صحيح');

      // 2FA must remain enabled
      const dbUser = await ctx.db.prepare('SELECT totp_enabled FROM users WHERE id = ?').bind(student.id).first('totp_enabled');
      expect(dbUser).toBe(1);
    });
  });

  describe('Stage 15: Google OAuth CSRF & State Replay Hardening', () => {
    it('security.oauth.state-replay: rejects OAuth callback if state does not match cookie', async () => {
      const oauthBindings = {
        ...ctx.bindings,
        GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'test-client-secret-12345',
        GOOGLE_REDIRECT_URI: 'http://localhost:8787/auth/google/callback',
      };

      const res = await app.request('/auth/google/callback?code=mock_code&state=student:forged_or_replayed_nonce', {
        headers: {
          'Cookie': 'oauth_state=student:legitimate_nonce_cookie_123',
        },
      }, oauthBindings);

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.detail).toContain('CSRF Detected');
    });
  });
});

