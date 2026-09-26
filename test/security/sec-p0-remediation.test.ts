import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { apiRequest } from '../harness/app';
import mainApp from '../../src/index';
import * as firebaseService from '../../src/services/firebase';
import * as googleIdentityService from '../../src/services/google-identity';
import { generateTotpSecret, generateTotpCode } from '../../src/services/crypto';

describe('P0 Security Remediation Suite (SEC-01, SEC-02, SEC-03)', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    (ctx.bindings as any).GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    app = mainApp;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ctx.cleanup();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SEC-01: Admin API Credential Leak Prevention
  // ──────────────────────────────────────────────────────────────────────────
  describe('SEC-01: Admin API credential field stripping', () => {
    it('GET /api/admin/users/:id does not return password_hash, totp_secret, reset_token_hash, or lockout counters', async () => {
      // Seed sensitive fields on an existing user
      await ctx.db.prepare(`
        UPDATE users
        SET totp_secret = 'SENSITIVE_SECRET_123',
            totp_enabled = 1,
            reset_token_hash = 'SENSITIVE_RESET_HASH_456',
            failed_login_attempts = 3,
            locked_until = '2099-01-01T00:00:00Z',
            failed_redeem_attempts = 2,
            redeem_locked_until = '2099-01-01T00:00:00Z'
        WHERE id = ?
      `).bind(ctx.fixtures.users.student.id).run();

      const res = await apiRequest(
        app,
        'GET',
        `/api/admin/users/${ctx.fixtures.users.student.id}`,
        { token: ctx.fixtures.users.admin.token },
        ctx,
      );

      expect(res.status).toBe(200);
      const data = await res.json();

      // Verified stripped
      expect(data.password_hash).toBeUndefined();
      expect(data.totp_secret).toBeUndefined();
      expect(data.reset_token_hash).toBeUndefined();
      expect(data.reset_token_expires_at).toBeUndefined();
      expect(data.failed_login_attempts).toBeUndefined();
      expect(data.locked_until).toBeUndefined();
      expect(data.failed_redeem_attempts).toBeUndefined();
      expect(data.redeem_locked_until).toBeUndefined();

      // Expected public fields preserved
      expect(data.id).toBe(ctx.fixtures.users.student.id);
      expect(data.email).toBe(ctx.fixtures.users.student.email);
      expect(data.role).toBe('student');
      expect(data.totp_enabled).toBe(true);
    });

    it('POST /api/admin/users does not return password_hash in response', async () => {
      (ctx.bindings as any).SMTP_HOST = 'resend';
      (ctx.bindings as any).SMTP_PASSWORD = 'test-mail-key';
      (ctx.bindings as any).SMTP_FROM = 'noreply@kiur.app';
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const res = await apiRequest(
        app,
        'POST',
        '/api/admin/users',
        {
          token: ctx.fixtures.users.admin.token,
          body: {
            email: 'new_student_p0@kiur.app',
            full_name: 'طالب فحص الحقول',
            role: 'student',
          },
        },
        ctx,
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.password_hash).toBeUndefined();
      expect(data.totp_secret).toBeUndefined();
      expect(data.reset_token_hash).toBeUndefined();
      expect(data.email).toBe('new_student_p0@kiur.app');
    });

    it('PUT /api/admin/users/:user_id does not return credential fields', async () => {
      const res = await apiRequest(
        app,
        'PUT',
        `/api/admin/users/${ctx.fixtures.users.student.id}`,
        {
          token: ctx.fixtures.users.admin.token,
          body: {
            email: ctx.fixtures.users.student.email,
            full_name: 'طالب معدل',
            role: 'student',
          },
        },
        ctx,
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.password_hash).toBeUndefined();
      expect(data.totp_secret).toBeUndefined();
      expect(data.reset_token_hash).toBeUndefined();
    });

    it('does not let an administrator set a permanent password for another user', async () => {
      const res = await apiRequest(app, 'PUT', `/api/admin/users/${ctx.fixtures.users.student.id}`, {
        token: ctx.fixtures.users.admin.token,
        body: { email: ctx.fixtures.users.student.email, full_name: 'Student', role: 'student', password: 'NewStrongPassword456!' },
      }, ctx);
      expect(res.status).toBe(400);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SEC-02: Identity Provider Binding & Conflict Prevention
  // ──────────────────────────────────────────────────────────────────────────
  describe('SEC-02: Identity binding conflict prevention & elevated role protection', () => {
    it('rejects an unlinked student identity even when its verified email matches', async () => {
      const flow = await apiRequest(app, 'POST', '/auth/firebase/flow', {}, ctx);
      const cookie = flow.headers.get('set-cookie')?.split(';')[0] || '';
      const { flow_nonce } = await flow.json();
      vi.spyOn(firebaseService, 'verifyFirebaseGoogleToken').mockResolvedValueOnce({
        uid: 'fb_new_owner', email: ctx.fixtures.users.student.email,
        emailVerified: true, displayName: 'New owner', photoUrl: null,
      });
      const res = await apiRequest(app, 'POST', '/auth/firebase/verify', {
        headers: { Cookie: cookie }, body: { idToken: 'signed.token', nonce: flow_nonce },
      }, ctx);
      expect(res.status).toBe(409);
      expect(await ctx.db.prepare('SELECT firebase_uid FROM users WHERE id = ?')
        .bind(ctx.fixtures.users.student.id).first('firebase_uid')).toBeNull();
    });

    it('links Firebase only after an active session and correct Kiur password', async () => {
      const identity = { uid: 'fb_bound_after_proof', email: ctx.fixtures.users.student.email,
        emailVerified: true, displayName: 'Student', photoUrl: null };
      vi.spyOn(firebaseService, 'verifyFirebaseGoogleToken').mockResolvedValue(identity);
      const wrong = await apiRequest(app, 'POST', '/auth/firebase/link', {
        token: ctx.fixtures.users.student.token, body: { id_token: 'signed.token', password: 'wrong-password' },
      }, ctx);
      expect(wrong.status).toBe(403);
      const linked = await apiRequest(app, 'POST', '/auth/firebase/link', {
        token: ctx.fixtures.users.student.token, body: { id_token: 'signed.token', password: 'Nabd@2026' },
      }, ctx);
      expect(linked.status).toBe(200);
      expect(await ctx.db.prepare('SELECT firebase_uid FROM users WHERE id = ?')
        .bind(ctx.fixtures.users.student.id).first('firebase_uid')).toBe(identity.uid);
    });

    it('lets only one concurrent Google identity bind to an account', async () => {
      vi.spyOn(firebaseService, 'verifyFirebaseGoogleToken').mockImplementation(async (_env, token) => ({
        uid: token === 'first' ? 'fb_race_first' : 'fb_race_second',
        email: ctx.fixtures.users.student.email, emailVerified: true, displayName: 'Student', photoUrl: null,
      }));
      const attempt = (id_token: string) => apiRequest(app, 'POST', '/auth/firebase/link', {
        token: ctx.fixtures.users.student.token, body: { id_token, password: 'Nabd@2026' },
      }, ctx);
      const results = await Promise.all([attempt('first'), attempt('second')]);
      expect(results.map(r => r.status).sort()).toEqual([200, 409]);
      const bound = await ctx.db.prepare('SELECT firebase_uid FROM users WHERE id = ?')
        .bind(ctx.fixtures.users.student.id).first('firebase_uid');
      expect(['fb_race_first', 'fb_race_second']).toContain(bound);
    });
    it('rejects Firebase login with 409 Conflict if account is already bound to a different firebase_uid', async () => {
      // 1. Student account already bound to a specific UID
      const originalUid = 'fb_student_original_uid';
      await ctx.db.prepare('UPDATE users SET firebase_uid = ? WHERE id = ?')
        .bind(originalUid, ctx.fixtures.users.student.id).run();

      // Flow nonce setup
      const flowRes = await apiRequest(app, 'POST', '/auth/firebase/flow', {}, ctx);
      const cookie = flowRes.headers.get('set-cookie')?.split(';')[0] || '';
      const { flow_nonce } = await flowRes.json();

      // Attacker arrives with the same email but a DIFFERENT firebase UID
      vi.spyOn(firebaseService, 'verifyFirebaseGoogleToken').mockResolvedValueOnce({
        uid: 'fb_attacker_conflicting_uid',
        email: ctx.fixtures.users.student.email,
        emailVerified: true,
        displayName: 'Attacker Impersonator',
        photoUrl: null,
      });

      const res = await apiRequest(
        app,
        'POST',
        '/auth/firebase/verify',
        {
          headers: { Cookie: cookie },
          body: { idToken: 'valid.token', nonce: flow_nonce },
        },
        ctx,
      );

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.detail).toContain('مرتبط بحساب Google/Firebase آخر مسبقاً');

      // Ensure original firebase_uid was NOT overwritten
      const checkUser = await ctx.db.prepare('SELECT firebase_uid FROM users WHERE id = ?')
        .bind(ctx.fixtures.users.student.id).first<{ firebase_uid: string }>();
      expect(checkUser?.firebase_uid).toBe(originalUid);
    });

    it('rejects Firebase automatic linking on elevated accounts (admin) without bound UID', async () => {
      // Admin account exists with NO firebase_uid bound
      await ctx.db.prepare('UPDATE users SET firebase_uid = NULL WHERE id = ?')
        .bind(ctx.fixtures.users.admin.id).run();

      const flowRes = await apiRequest(app, 'POST', '/auth/firebase/flow', {}, ctx);
      const cookie = flowRes.headers.get('set-cookie')?.split(';')[0] || '';
      const { flow_nonce } = await flowRes.json();

      // Google identity matching the admin's email attempts to sign in
      vi.spyOn(firebaseService, 'verifyFirebaseGoogleToken').mockResolvedValueOnce({
        uid: 'fb_someone_with_admin_email',
        email: ctx.fixtures.users.admin.email,
        emailVerified: true,
        displayName: 'Admin Impersonator',
        photoUrl: null,
      });

      const res = await apiRequest(
        app,
        'POST',
        '/auth/firebase/verify',
        {
          headers: { Cookie: cookie },
          body: { idToken: 'valid.token', nonce: flow_nonce },
        },
        ctx,
      );

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.detail).toContain('سجّل الدخول إلى حسابك أولاً');

      // Ensure the admin account was NOT linked
      const checkUser = await ctx.db.prepare('SELECT firebase_uid FROM users WHERE id = ?')
        .bind(ctx.fixtures.users.admin.id).first<{ firebase_uid: string | null }>();
      expect(checkUser?.firebase_uid).toBeNull();
    });

    it('allows Firebase sign-in for elevated accounts if firebase_uid is already properly bound', async () => {
      const boundUid = 'fb_admin_verified_uid';
      await ctx.db.prepare('UPDATE users SET firebase_uid = ? WHERE id = ?')
        .bind(boundUid, ctx.fixtures.users.admin.id).run();

      const flowRes = await apiRequest(app, 'POST', '/auth/firebase/flow', {}, ctx);
      const cookie = flowRes.headers.get('set-cookie')?.split(';')[0] || '';
      const { flow_nonce } = await flowRes.json();

      vi.spyOn(firebaseService, 'verifyFirebaseGoogleToken').mockResolvedValueOnce({
        uid: boundUid,
        email: ctx.fixtures.users.admin.email,
        emailVerified: true,
        displayName: 'Verified Admin',
        photoUrl: null,
      });

      const res = await apiRequest(
        app,
        'POST',
        '/auth/firebase/verify',
        {
          headers: { Cookie: cookie },
          body: { idToken: 'valid.token', nonce: flow_nonce },
        },
        ctx,
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.access_token).toBeDefined();
      expect(data.user.role).toBe('admin');
    });

    it('rejects Google GIS verify with 409 Conflict if account is already bound to a different google_sub', async () => {
      const originalSub = 'google_sub_original_123';
      await ctx.db.prepare('UPDATE users SET google_sub = ? WHERE id = ?')
        .bind(originalSub, ctx.fixtures.users.student.id).run();

      const flowRes = await apiRequest(app, 'POST', '/auth/google/flow', {}, ctx);
      const cookie = flowRes.headers.get('set-cookie')?.split(';')[0] || '';
      const { flow_nonce } = await flowRes.json();

      vi.spyOn(googleIdentityService, 'verifyGoogleIdentityCredential').mockResolvedValueOnce({
        subject: 'google_sub_attacker_456',
        email: ctx.fixtures.users.student.email,
        emailVerified: true,
        name: 'Student GIS Attacker',
      });

      const res = await apiRequest(
        app,
        'POST',
        '/auth/google/verify',
        {
          headers: { Cookie: cookie },
          body: { credential: 'mock.credential', nonce: flow_nonce },
        },
        ctx,
      );

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.detail).toContain('مرتبط بحساب Google مختلف مسبقاً');
    });

    it('rejects Google GIS verify with 403 on unlinked elevated accounts', async () => {
      await ctx.db.prepare('UPDATE users SET google_sub = NULL WHERE id = ?')
        .bind(ctx.fixtures.users.admin.id).run();

      const flowRes = await apiRequest(app, 'POST', '/auth/google/flow', {}, ctx);
      const cookie = flowRes.headers.get('set-cookie')?.split(';')[0] || '';
      const { flow_nonce } = await flowRes.json();

      vi.spyOn(googleIdentityService, 'verifyGoogleIdentityCredential').mockResolvedValueOnce({
        subject: 'google_sub_some_admin',
        email: ctx.fixtures.users.admin.email,
        emailVerified: true,
        name: 'Admin User',
      });

      const res = await apiRequest(
        app,
        'POST',
        '/auth/google/verify',
        {
          headers: { Cookie: cookie },
          body: { credential: 'mock.credential', nonce: flow_nonce },
        },
        ctx,
      );

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.detail).toContain('سجّل الدخول إلى حسابك أولاً');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SEC-03: Active 2FA Secret Protection & Full Session Verification
  // ──────────────────────────────────────────────────────────────────────────
  describe('SEC-03: Active 2FA secret protection & session verification', () => {
    it('stores setup in a pending seed until a valid code enables it', async () => {
      const setup = await apiRequest(app, 'POST', '/auth/2fa/setup', {
        token: ctx.fixtures.users.student.token,
      }, ctx);
      expect(setup.status).toBe(200);
      const { secret } = await setup.json();
      const before = await ctx.db.prepare('SELECT totp_secret, totp_pending_secret, totp_enabled FROM users WHERE id = ?')
        .bind(ctx.fixtures.users.student.id).first<any>();
      expect(before.totp_secret).toBeNull();
      expect(before.totp_pending_secret).toBe(secret);
      expect(before.totp_enabled).toBe(0);
      const code = await generateTotpCode(secret);
      const enabled = await apiRequest(app, 'POST', '/auth/2fa/enable', {
        token: ctx.fixtures.users.student.token, body: { code },
      }, ctx);
      expect(enabled.status).toBe(200);
      const after = await ctx.db.prepare('SELECT totp_secret, totp_pending_secret, totp_enabled FROM users WHERE id = ?')
        .bind(ctx.fixtures.users.student.id).first<any>();
      expect(after.totp_secret).toBe(secret);
      expect(after.totp_pending_secret).toBeNull();
      expect(after.totp_enabled).toBe(1);
    });

    it('requires the admin password and target email for manual 2FA recovery', async () => {
      await ctx.db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?')
        .bind('JBSWY3DPEHPK3PXP', ctx.fixtures.users.student.id).run();
      const denied = await apiRequest(app, 'POST', `/api/admin/users/${ctx.fixtures.users.student.id}/2fa/reset`, {
        token: ctx.fixtures.users.admin.token, body: { confirm_email: ctx.fixtures.users.student.email, reason: 'Device lost', password: 'wrong' },
      }, ctx);
      expect(denied.status).toBe(403);
      const recovered = await apiRequest(app, 'POST', `/api/admin/users/${ctx.fixtures.users.student.id}/2fa/reset`, {
        token: ctx.fixtures.users.admin.token, body: { confirm_email: ctx.fixtures.users.student.email, reason: 'Device lost', password: 'Nabd@2026' },
      }, ctx);
      expect(recovered.status).toBe(200);
      const user = await ctx.db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?')
        .bind(ctx.fixtures.users.student.id).first<any>();
      expect(user.totp_secret).toBeNull();
      expect(user.totp_enabled).toBe(0);
      expect(await ctx.db.prepare('SELECT is_active FROM user_sessions WHERE id = ?')
        .bind(ctx.fixtures.users.student.sessionId).first('is_active')).toBe(0);
    });
    it('POST /auth/2fa/setup rejects with 400 when 2FA is already active, preserving existing totp_secret', async () => {
      const activeSecret = 'ACTIVE_SECRET_JBSWY3DPEHPK3PXP';
      await ctx.db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?')
        .bind(activeSecret, ctx.fixtures.users.student.id).run();

      const res = await apiRequest(
        app,
        'POST',
        '/auth/2fa/setup',
        { token: ctx.fixtures.users.student.token },
        ctx,
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.detail).toContain('المصادقة الثنائية مفعلة بالفعل على هذا الحساب');

      // Check active secret was NOT modified in the database
      const checkUser = await ctx.db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?')
        .bind(ctx.fixtures.users.student.id).first<{ totp_secret: string; totp_enabled: number }>();
      expect(checkUser?.totp_secret).toBe(activeSecret);
      expect(checkUser?.totp_enabled).toBe(1);
    });

    it('POST /auth/2fa/verify rejects with 401 when the session has been revoked or evicted', async () => {
      // Prepare 2FA setup for student
      const setupSecret = await generateTotpSecret();
      await ctx.db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?')
        .bind(setupSecret, ctx.fixtures.users.student.id).run();

      // Revoke the student's active session
      await ctx.db.prepare('UPDATE user_sessions SET is_active = 0 WHERE id = ?')
        .bind(ctx.fixtures.users.student.sessionId).run();

      const validCode = await generateTotpCode(setupSecret);

      const res = await apiRequest(
        app,
        'POST',
        '/auth/2fa/verify',
        {
          token: ctx.fixtures.users.student.token,
          body: { code: validCode },
        },
        ctx,
      );

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.detail).toContain('تم تسجيل الدخول من جهاز آخر');

      // 2FA must NOT be enabled
      const checkUser = await ctx.db.prepare('SELECT totp_enabled FROM users WHERE id = ?')
        .bind(ctx.fixtures.users.student.id).first<{ totp_enabled: number }>();
      expect(checkUser?.totp_enabled).toBe(0);
    });

    it('POST /auth/2fa/verify rejects with 400 when 2FA is already active', async () => {
      const activeSecret = await generateTotpSecret();
      await ctx.db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?')
        .bind(activeSecret, ctx.fixtures.users.student.id).run();

      const validCode = await generateTotpCode(activeSecret);

      const res = await apiRequest(
        app,
        'POST',
        '/auth/2fa/verify',
        {
          token: ctx.fixtures.users.student.token,
          body: { code: validCode },
        },
        ctx,
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.detail).toContain('المصادقة الثنائية مفعلة بالفعل على هذا الحساب');
    });

    it('POST /auth/2fa/enable rejects with 400 when 2FA is already active', async () => {
      const activeSecret = await generateTotpSecret();
      await ctx.db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?')
        .bind(activeSecret, ctx.fixtures.users.student.id).run();

      const validCode = await generateTotpCode(activeSecret);

      const res = await apiRequest(
        app,
        'POST',
        '/auth/2fa/enable',
        {
          token: ctx.fixtures.users.student.token,
          body: { code: validCode },
        },
        ctx,
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.detail).toContain('المصادقة الثنائية مفعلة بالفعل على هذا الحساب');
    });

    it('completes the full secure 2FA setup, verify, protect, disable, and re-setup lifecycle', async () => {
      // 1. Initial setup
      await ctx.db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?')
        .bind(ctx.fixtures.users.student.id).run();

      const setupRes = await apiRequest(
        app,
        'POST',
        '/auth/2fa/setup',
        { token: ctx.fixtures.users.student.token },
        ctx,
      );
      expect(setupRes.status).toBe(200);
      const { secret } = await setupRes.json();
      expect(secret).toBeDefined();

      // 2. Verify with valid code enables 2FA
      const code = await generateTotpCode(secret);
      const verifyRes = await apiRequest(
        app,
        'POST',
        '/auth/2fa/verify',
        {
          token: ctx.fixtures.users.student.token,
          body: { code },
        },
        ctx,
      );
      expect(verifyRes.status).toBe(200);
      const verifyData = await verifyRes.json();
      expect(verifyData.ok).toBe(true);

      // Verify DB state
      const dbCheck = await ctx.db.prepare('SELECT totp_enabled FROM users WHERE id = ?')
        .bind(ctx.fixtures.users.student.id).first<{ totp_enabled: number }>();
      expect(dbCheck?.totp_enabled).toBe(1);

      // 3. New setup while active is BLOCKED
      const blockedSetupRes = await apiRequest(
        app,
        'POST',
        '/auth/2fa/setup',
        { token: ctx.fixtures.users.student.token },
        ctx,
      );
      expect(blockedSetupRes.status).toBe(400);

      // 4. Disable with invalid code fails
      const badDisableRes = await apiRequest(
        app,
        'POST',
        '/auth/2fa/disable',
        {
          token: ctx.fixtures.users.student.token,
          body: { code: '000000' },
        },
        ctx,
      );
      expect(badDisableRes.status).toBe(403);

      // 5. Disable with valid code succeeds
      const currentCode = await generateTotpCode(secret);
      const okDisableRes = await apiRequest(
        app,
        'POST',
        '/auth/2fa/disable',
        {
          token: ctx.fixtures.users.student.token,
          body: { code: currentCode },
        },
        ctx,
      );
      expect(okDisableRes.status).toBe(200);

      // 6. DB cleared
      const dbCheckAfter = await ctx.db.prepare('SELECT totp_enabled, totp_secret FROM users WHERE id = ?')
        .bind(ctx.fixtures.users.student.id).first<{ totp_enabled: number; totp_secret: string | null }>();
      expect(dbCheckAfter?.totp_enabled).toBe(0);
      expect(dbCheckAfter?.totp_secret).toBeNull();

      // 7. Setup can now be performed cleanly
      const reSetupRes = await apiRequest(
        app,
        'POST',
        '/auth/2fa/setup',
        { token: ctx.fixtures.users.student.token },
        ctx,
      );
      expect(reSetupRes.status).toBe(200);
    });
  });
});
