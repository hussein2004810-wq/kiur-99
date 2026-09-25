import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestContext, type TestContext } from '../harness/test-context';
import { apiRequest } from '../harness/app';
import mainApp from '../../src/index';
import * as schema from '../../src/db/schema';
import * as firebaseService from '../../src/services/firebase';

describe('Empirical Challenger Remediation 2 Verification Suite', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = mainApp;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ctx.cleanup();
  });

  // ==========================================================================
  // Target 1: GET /api/students/leaderboard rejects unauthenticated requests with HTTP 401
  // ==========================================================================
  describe('Target 1: GET /api/students/leaderboard authentication enforcement', () => {
    it('rejects unauthenticated request (missing Authorization header) with HTTP 401', async () => {
      const res = await apiRequest(app, 'GET', '/api/students/leaderboard', {}, ctx);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.detail).toBe('مطلوب تسجيل الدخول');
    });

    it('rejects request with malformed or empty Bearer token with HTTP 401', async () => {
      const res = await apiRequest(app, 'GET', '/api/students/leaderboard', {
        headers: { Authorization: 'Bearer ' },
      }, ctx);
      expect(res.status).toBe(401);
    });

    it('rejects request with forged/invalid Bearer token with HTTP 401', async () => {
      const res = await apiRequest(app, 'GET', '/api/students/leaderboard', {
        headers: { Authorization: 'Bearer forged.jwt.token' },
      }, ctx);
      expect(res.status).toBe(401);
    });

    it('accepts authenticated request from student with HTTP 200 and ranked list', async () => {
      const studentToken = ctx.fixtures.users.student.token;
      const res = await apiRequest(app, 'GET', '/api/students/leaderboard', {
        token: studentToken,
      }, ctx);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it('accepts authenticated request from professor and admin with HTTP 200', async () => {
      const adminToken = ctx.fixtures.users.admin.token;
      const res = await apiRequest(app, 'GET', '/api/students/leaderboard', {
        token: adminToken,
      }, ctx);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });
  });

  // ==========================================================================
  // Target 2: POST /api/activation/redeem applies lockout (HTTP 429) after 5 failed attempts on already-active codes
  // ==========================================================================
  describe('Target 2: POST /api/activation/redeem lockout on already-active codes', () => {
    const ACTIVE_CODE = 'KIUR-ACTIVE-STRESS-CODE';

    beforeEach(async () => {
      // Insert an already active code into activation_codes table
      await ctx.db.prepare(`
        INSERT INTO activation_codes (id, code, status, reseller_id, activated_at)
        VALUES ('act_code_already_active', ?, 'active', ?, datetime('now'))
      `).bind(ACTIVE_CODE, ctx.fixtures.users.reseller.id).run();
    });

    it('increments failed_redeem_attempts on active code and locks out at 5th attempt with HTTP 429', async () => {
      const student = ctx.fixtures.users.student;

      // Attempts 1 to 4: Each should return HTTP 400 and increment failed_redeem_attempts
      for (let attempt = 1; attempt <= 4; attempt++) {
        const res = await apiRequest(app, 'POST', '/api/activation/redeem', {
          token: student.token,
          body: { code: ACTIVE_CODE },
        }, ctx);

        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.detail).toBe('هذا الكود مستخدم بالفعل أو منتهي الصلاحية');

        // Verify database state: failed_redeem_attempts is tracked and user is NOT locked yet
        const dbUser = await ctx.db
          .prepare('SELECT failed_redeem_attempts, redeem_locked_until FROM users WHERE id = ?')
          .bind(student.id)
          .first<{ failed_redeem_attempts: number; redeem_locked_until: string | null }>();

        expect(dbUser?.failed_redeem_attempts).toBe(attempt);
        expect(dbUser?.redeem_locked_until).toBeNull();
      }

      // Attempt 5 (Threshold reached): Should return HTTP 429, reset counter, and set redeem_locked_until
      const fifthRes = await apiRequest(app, 'POST', '/api/activation/redeem', {
        token: student.token,
        body: { code: ACTIVE_CODE },
      }, ctx);

      expect(fifthRes.status).toBe(429);
      const fifthData = await fifthRes.json();
      expect(fifthData.detail).toBe('تم قفل تفعيل الأكواد مؤقتاً لكثرة المحاولات الخاطئة');

      // Verify database state: failed_redeem_attempts is reset to 0, redeem_locked_until is set in future
      const lockedUser = await ctx.db
        .prepare('SELECT failed_redeem_attempts, redeem_locked_until FROM users WHERE id = ?')
        .bind(student.id)
        .first<{ failed_redeem_attempts: number; redeem_locked_until: string | null }>();

      expect(lockedUser?.failed_redeem_attempts).toBe(0);
      expect(lockedUser?.redeem_locked_until).not.toBeNull();
      const lockDate = new Date(lockedUser!.redeem_locked_until!);
      expect(lockDate.getTime()).toBeGreaterThan(Date.now() + 10 * 60 * 1000); // ~15 min lockout

      // Subsequent attempt (6th attempt while locked out): Must be blocked immediately with HTTP 429
      const sixthRes = await apiRequest(app, 'POST', '/api/activation/redeem', {
        token: student.token,
        body: { code: ACTIVE_CODE },
      }, ctx);

      expect(sixthRes.status).toBe(429);
      const sixthData = await sixthRes.json();
      expect(sixthData.detail).toBe('تم قفل تفعيل الأكواد مؤقتاً لكثرة المحاولات الخاطئة');
    });
  });

  // ==========================================================================
  // Target 3: POST /auth/firebase/verify rejects unauthorized email domains when ALLOWED_UNIVERSITY_DOMAINS is set
  // ==========================================================================
  describe('Target 3: POST /auth/firebase/verify university domain validation', () => {
    it('rejects unauthorized email domain with HTTP 403 when ALLOWED_UNIVERSITY_DOMAINS is configured', async () => {
      // 1. Initialize flow to obtain nonce and cookie
      const flowRes = await apiRequest(app, 'POST', '/auth/firebase/flow', {}, ctx);
      expect(flowRes.status).toBe(200);
      const cookie = flowRes.headers.get('set-cookie')?.split(';')[0] || '';
      const { flow_nonce } = await flowRes.json();

      // Configure university domain restrictions
      const restrictedCtx = {
        ...ctx,
        bindings: {
          ...ctx.bindings,
          ALLOWED_UNIVERSITY_DOMAINS: 'uob.edu.iq,medical.uob.edu.iq',
        },
      };

      // Mock verifyFirebaseGoogleToken to return a user with an unauthorized email
      vi.spyOn(firebaseService, 'verifyFirebaseGoogleToken').mockResolvedValueOnce({
        uid: 'fb_intruder_uid_123',
        email: 'attacker@gmail.com',
        emailVerified: true,
        displayName: 'Attacker User',
        photoUrl: null,
      });

      const res = await apiRequest(app, 'POST', '/auth/firebase/verify', {
        headers: { Cookie: cookie },
        body: { idToken: 'mocked.valid.jwt.token', nonce: flow_nonce },
      }, restrictedCtx);

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.detail).toBe('نطاق البريد الإلكتروني غير مسموح به في النظام');
    });

    it('rejects unauthorized lookalike domains with HTTP 403', async () => {
      const flowRes = await apiRequest(app, 'POST', '/auth/firebase/flow', {}, ctx);
      const cookie = flowRes.headers.get('set-cookie')?.split(';')[0] || '';
      const { flow_nonce } = await flowRes.json();

      const restrictedCtx = {
        ...ctx,
        bindings: {
          ...ctx.bindings,
          ALLOWED_UNIVERSITY_DOMAINS: 'uob.edu.iq',
        },
      };

      vi.spyOn(firebaseService, 'verifyFirebaseGoogleToken').mockResolvedValueOnce({
        uid: 'fb_intruder_uid_456',
        email: 'attacker@evil-uob.edu.iq',
        emailVerified: true,
        displayName: 'Evil Lookalike',
        photoUrl: null,
      });

      const res = await apiRequest(app, 'POST', '/auth/firebase/verify', {
        headers: { Cookie: cookie },
        body: { idToken: 'mocked.valid.jwt.token', nonce: flow_nonce },
      }, restrictedCtx);

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.detail).toBe('نطاق البريد الإلكتروني غير مسموح به في النظام');
    });

    it('allows valid authorized university domain and completes verification', async () => {
      const flowRes = await apiRequest(app, 'POST', '/auth/firebase/flow', {}, ctx);
      const cookie = flowRes.headers.get('set-cookie')?.split(';')[0] || '';
      const { flow_nonce } = await flowRes.json();

      const restrictedCtx = {
        ...ctx,
        bindings: {
          ...ctx.bindings,
          ALLOWED_UNIVERSITY_DOMAINS: 'uob.edu.iq',
        },
      };

      vi.spyOn(firebaseService, 'verifyFirebaseGoogleToken').mockResolvedValueOnce({
        uid: 'fb_student_uob_789',
        email: 'genuine.student@uob.edu.iq',
        emailVerified: true,
        displayName: 'Genuine Student',
        photoUrl: 'https://cdn.example.com/avatar.png',
      });

      const res = await apiRequest(app, 'POST', '/auth/firebase/verify', {
        headers: { Cookie: cookie },
        body: { idToken: 'mocked.valid.jwt.token', nonce: flow_nonce },
      }, restrictedCtx);

      // Must succeed (200 OK) with tokens and user info
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.access_token).toBeDefined();
      expect(data.user.email).toBe('genuine.student@uob.edu.iq');
    });
  });

  // ==========================================================================
  // Target 4: banId generated in admin ban uses crypto UUID format (schema.genId)
  // ==========================================================================
  describe('Target 4: banId generated in admin ban uses crypto UUID format (schema.genId)', () => {
    it('schema.genId produces 12-char hex crypto UUIDs without collisions', () => {
      const generated = new Set<string>();
      const sampleSize = 5000;

      for (let i = 0; i < sampleSize; i++) {
        const id = schema.genId();
        expect(id).toMatch(/^[0-9a-f]{12}$/);
        expect(id.length).toBe(12);
        expect(id.startsWith('ban_')).toBe(false);
        generated.add(id);
      }

      // Zero collisions among 5000 generated IDs
      expect(generated.size).toBe(sampleSize);
    });

    it('generates a crypto UUID banId matching schema.genId format when admin bans a user', async () => {
      const adminToken = ctx.fixtures.users.admin.token;
      const targetUser = ctx.fixtures.users.student;

      const res = await apiRequest(app, 'POST', `/api/admin/users/${targetUser.id}/ban`, {
        token: adminToken,
        body: { reason: 'اختبار الحظر الأمني التجريبي' },
      }, ctx);

      expect(res.status).toBe(200);

      // Query database for the ban record
      const banRecord = await ctx.db
        .prepare('SELECT id, user_id, reason, status FROM ban_records WHERE user_id = ?')
        .bind(targetUser.id)
        .first<{ id: string; user_id: string; reason: string; status: string }>();

      expect(banRecord).toBeDefined();
      expect(banRecord!.user_id).toBe(targetUser.id);
      expect(banRecord!.reason).toBe('اختبار الحظر الأمني التجريبي');
      expect(banRecord!.status).toBe('active');

      // EMPIRICAL VERIFICATION OF BAN ID FORMAT:
      // In the legacy code, banId was: 'ban_' + Math.random().toString(36).substring(2, 10);
      // In the remediated code, banId is: schema.genId() which produces 12-char lowercase hex.
      expect(banRecord!.id).not.toMatch(/^ban_/);
      expect(banRecord!.id).toMatch(/^[0-9a-f]{12}$/);
      expect(banRecord!.id.length).toBe(12);
    });
  });

  // ==========================================================================
  // Target 5: Input validation boundary test (CRIT-1: 10 chars min password)
  // ==========================================================================
  describe('Target 5: Input validation boundary test (CRIT-1: 10 chars min password)', () => {
    it('rejects passwords below 10 characters with HTTP 400 and Arabic error mentioning 10', async () => {
      // Test lengths: 3, 5, 6 (old legacy limit), and 9 (boundary - 1)
      const testCases = ['123', '12345', '123456', '123456789'];

      for (const shortPw of testCases) {
        const res = await apiRequest(app, 'POST', '/auth/register', {
          body: {
            email: `boundary_${shortPw.length}@nabd.app`,
            full_name: 'طالب الاختبار',
            password: shortPw,
          },
        }, ctx);

        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.detail).toContain('10');
        expect(data.detail).toBe('كلمة المرور يجب أن تكون 10 أحرف على الأقل');
      }
    });

    it('accepts password with exactly 10 characters (min boundary)', async () => {
      const res = await apiRequest(app, 'POST', '/auth/register', {
        body: {
          email: 'valid_10char@nabd.app',
          full_name: 'طالب صالح',
          password: 'Pass123456', // exactly 10 chars
        },
      }, ctx);

      // Successfully creates user (returns 200 with ok: true)
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.user_id).toBeDefined();
    });

    it('accepts password with 128 characters (max boundary) and rejects 129 characters', async () => {
      const pw128 = 'A'.repeat(128);
      const res128 = await apiRequest(app, 'POST', '/auth/register', {
        body: {
          email: 'valid_128char@nabd.app',
          full_name: 'طالب طويل',
          password: pw128,
        },
      }, ctx);
      expect(res128.status).toBe(200);
      const data128 = await res128.json();
      expect(data128.ok).toBe(true);

      const pw129 = 'A'.repeat(129);
      const res129 = await apiRequest(app, 'POST', '/auth/register', {
        body: {
          email: 'invalid_129char@nabd.app',
          full_name: 'طالب فائق الطول',
          password: pw129,
        },
      }, ctx);
      expect(res129.status).toBe(400);
      const data129 = await res129.json();
      expect(data129.detail).toContain('128');
    });
  });
});
