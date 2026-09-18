import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { apiRequest } from '../harness/app';
import mainApp from '../../src/index';

describe('Legacy Feature Port & Operational Gap Suite', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = mainApp;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // ────────────────── A1. Firebase Google Flow & Verification ──────────────────
  describe('A1: Firebase Google Flow & Verification', () => {
    it('generates a one-time flow nonce with secure cookie', async () => {
      const res = await apiRequest(app, 'POST', '/auth/firebase/flow', {}, ctx);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.flow_nonce).toBeDefined();

      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain('kiur_firebase_flow=');
      expect(setCookie).toContain('HttpOnly');
    });

    it('rejects Firebase verification when flow cookie is missing', async () => {
      const res = await apiRequest(app, 'POST', '/auth/firebase/verify', {
        body: { id_token: 'fake.jwt.token' },
      }, ctx);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.detail).toContain('جلسة تدفق Firebase');
    });

    it('serves interactive Google login portal on GET /auth/google/login without 500 error', async () => {
      const res = await apiRequest(app, 'GET', '/auth/google/login?next=admin', {}, ctx);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('تسجيل الدخول بحساب Google');
      expect(text).toContain('المتابعة بحساب Google');
    });

    it('authenticates Google user on POST /auth/google/login and promotes bootstrap admin', async () => {
      const res = await apiRequest(app, 'POST', '/auth/google/login', {
        body: {
          email: 'hussein2004810@gmail.com',
          next: 'admin',
        },
      }, ctx);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.access_token).toBeDefined();
      expect(data.user.email).toBe('hussein2004810@gmail.com');
      expect(data.user.role).toBe('admin');

      // Verify session cookie was set
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain('nabd_session=');
    });

    it('reports Google OAuth configuration status on GET /auth/google/status', async () => {
      const res = await apiRequest(app, 'GET', '/auth/google/status', {}, ctx);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('enabled');
      expect(typeof data.enabled).toBe('boolean');
    });

    it('registers a new student via Google sign-in with profile_complete false', async () => {
      const res = await apiRequest(app, 'POST', '/auth/google/login', {
        body: {
          email: 'newstudent_google@example.com',
          next: 'student',
        },
      }, ctx);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.access_token).toBeDefined();
      expect(data.user.email).toBe('newstudent_google@example.com');
      expect(data.user.role).toBe('student');
      expect(data.user.profile_complete).toBe(false);
    });
  });

  // ────────────────── A2. Email Verification Lifecycle ─────────────────────────
  describe('A2: Email Verification Lifecycle', () => {
    it('resends verification without disclosing account existence (enumeration defense)', async () => {
      const res = await apiRequest(app, 'POST', '/auth/resend-verification', {
        body: { email: 'nonexistent@example.com' },
      }, ctx);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
    });

    it('rejects invalid or expired email verification tokens safely', async () => {
      const res = await apiRequest(app, 'POST', '/auth/verify-email', {
        body: { token: 'invalid-token-123456789' },
      }, ctx);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.detail).toContain('رمز التحقق');
    });
  });

  // ────────────────── A3. Session Management & Logout All ─────────────────────
  describe('A3: Session Management & Logout All', () => {
    it('lists active sessions with is_current flag', async () => {
      const res = await apiRequest(app, 'GET', '/auth/sessions', {
        token: ctx.fixtures.users.student.token,
      }, ctx);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.sessions)).toBe(true);
      expect(data.sessions.length).toBeGreaterThan(0);
      expect(data.sessions[0].is_current).toBe(true);
    });

    it('revokes all other sessions safely', async () => {
      const res = await apiRequest(app, 'POST', '/auth/sessions/revoke-others', {
        token: ctx.fixtures.users.student.token,
      }, ctx);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
    });

    it('logs out all devices and increments session epoch', async () => {
      const res = await apiRequest(app, 'POST', '/auth/logout-all', {
        token: ctx.fixtures.users.student.token,
      }, ctx);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
    });
  });

  // ────────────────── A4 / A7. Account Security Events ────────────────────────
  describe('A4 & A7: Account Security Events & Audit Separation', () => {
    it('allows student to query their own security events', async () => {
      const res = await apiRequest(app, 'GET', '/auth/security-events', {
        token: ctx.fixtures.users.student.token,
      }, ctx);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.events)).toBe(true);
    });

    it('allows admin to query platform account events with user info', async () => {
      const res = await apiRequest(app, 'GET', '/api/admin/account-events', {
        token: ctx.fixtures.users.admin.token,
      }, ctx);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.events).toBeDefined();
      expect(Array.isArray(data.events)).toBe(true);
    });
  });

  // ────────────────── A5. Bulk Question Import ────────────────────────────────
  describe('A5: Bulk Question Import with Preview & Commit', () => {
    it('previews questions and detects valid rows vs errors', async () => {
      const res = await apiRequest(app, 'POST', '/api/admin/questions/import/preview', {
        token: ctx.fixtures.users.admin.token,
        body: {
          subject_id: ctx.fixtures.subjectIds.anatomy,
          questions: [
            {
              text: 'ما هي أعراض التهاب الزائدة الدودية؟',
              eyebrow: 'جراحة عامة',
              rationale: 'ألم في الربع السفلي الأيمن',
              choices: [
                { text: 'ألم في الربع السفلي الأيمن', is_correct: true },
                { text: 'صداع خفيف', is_correct: false },
              ],
            },
            {
              text: 'سؤال غير صالح',
              choices: [
                { text: 'خيار وحيد', is_correct: false },
              ],
            },
          ],
        },
      }, ctx);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.summary.total).toBe(2);
      expect(data.summary.valid).toBe(1);
      expect(data.summary.errors).toBe(1);
      expect(data.items[1].is_valid).toBe(false);
    });

    it('commits batch question import transactionally', async () => {
      const res = await apiRequest(app, 'POST', '/api/admin/questions/import/commit', {
        token: ctx.fixtures.users.admin.token,
        body: {
          subject_id: ctx.fixtures.subjectIds.anatomy,
          questions: [
            {
              text: 'ما هو العصب المسؤول عن حركة عضلات الوجه التعبيرية؟',
              eyebrow: 'تشريح الأعصاب',
              rationale: 'العصب القحفي السابع (العصب الوجهي)',
              choices: [
                { text: 'العصب الوجهي (CN VII)', is_correct: true },
                { text: 'العصب ثلاثي التوائم (CN V)', is_correct: false },
              ],
            },
          ],
        },
      }, ctx);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.imported).toBe(1);
    });
  });

  // ────────────────── A6. Scoped Exports ──────────────────────────────────────
  describe('A6: Scoped Exports with Arabic RTL UTF-8 BOM', () => {
    it('exports questions in CSV format with BOM for Arabic display', async () => {
      const res = await apiRequest(app, 'GET', `/api/admin/export/questions?subject_id=${ctx.fixtures.subjectIds.anatomy}`, {
        token: ctx.fixtures.users.admin.token,
      }, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');
      const buf = new Uint8Array(await res.arrayBuffer());
      expect(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf).toBe(true);
      const csv = new TextDecoder('utf-8').decode(buf);
      expect(csv).toContain('المعرف');
      expect(csv).toContain('نص السؤال');
    });

    it('exports exam results in CSV format with BOM', async () => {
      const res = await apiRequest(app, 'GET', `/api/admin/export/exam-results/${ctx.fixtures.examId}`, {
        token: ctx.fixtures.users.admin.token,
      }, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');
      const buf = new Uint8Array(await res.arrayBuffer());
      expect(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf).toBe(true);
      const csv = new TextDecoder('utf-8').decode(buf);
      expect(csv).toContain('اسم الطالب');
    });
  });

  // ────────────────── B1. Academic Change Requests Workflow ───────────────────
  describe('B1: Academic Change Requests Workflow', () => {
    it('allows student to submit a change request and admin to approve it', async () => {
      // 1. Student submits request
      const submitRes = await apiRequest(app, 'POST', '/api/students/academic-change-request', {
        token: ctx.fixtures.users.student.token,
        body: {
          target_university_id: ctx.fixtures.universityId,
          target_stage_id: ctx.fixtures.stageId,
          reason: 'انتقال رسمي بقرار من وزارة التعليم العالي',
        },
      }, ctx);

      expect(submitRes.status).toBe(200);
      const submitData = await submitRes.json();
      expect(submitData.ok).toBe(true);
      const reqId = submitData.request_id;

      // 2. Student queries requests
      const listRes = await apiRequest(app, 'GET', '/api/students/academic-change-request', {
        token: ctx.fixtures.users.student.token,
      }, ctx);
      expect(listRes.status).toBe(200);
      const listData = await listRes.json();
      expect(listData.length).toBeGreaterThan(0);
      expect(listData[0].status).toBe('pending');

      // 3. Admin views and approves request
      const reviewRes = await apiRequest(app, 'POST', `/api/admin/academic-change-requests/${reqId}/review`, {
        token: ctx.fixtures.users.admin.token,
        body: {
          status: 'approved',
          notes: 'تم التحقق من الوثائق الرسمية والموافقة',
        },
      }, ctx);

      expect(reviewRes.status).toBe(200);
      const reviewData = await reviewRes.json();
      expect(reviewData.ok).toBe(true);
      expect(reviewData.status).toBe('approved');
    });
  });

  // ────────────────── B2. Academic Soft-Delete & Trash ─────────────────────────
  describe('B2: Academic Soft-Delete, Trash & Restore', () => {
    it('soft deletes a question, lists in trash, and restores it', async () => {
      const qId = ctx.fixtures.questionIds[0];
      // 1. Soft delete question
      const delRes = await apiRequest(app, 'DELETE', `/api/admin/questions/${qId}`, {
        token: ctx.fixtures.users.admin.token,
      }, ctx);
      expect(delRes.status).toBe(200);

      // 2. View trash
      const trashRes = await apiRequest(app, 'GET', '/api/admin/trash', {
        token: ctx.fixtures.users.admin.token,
      }, ctx);
      expect(trashRes.status).toBe(200);
      const trashData = await trashRes.json();
      const trashed = trashData.questions.find((q: any) => q.id === qId);
      expect(trashed).toBeDefined();

      // 3. Restore from trash
      const restoreRes = await apiRequest(app, 'POST', `/api/admin/trash/question/${qId}/restore`, {
        token: ctx.fixtures.users.admin.token,
      }, ctx);
      expect(restoreRes.status).toBe(200);
      const restoreData = await restoreRes.json();
      expect(restoreData.ok).toBe(true);
    });
  });

  // ────────────────── B3 / B4 / B5. Student Learning Experience ────────────────
  describe('B3, B4, B5: Learning Hub, Smart Review & Student Dashboard', () => {
    it('returns student learning hub with stats and due reviews', async () => {
      const res = await apiRequest(app, 'GET', '/api/students/learning-hub', {
        token: ctx.fixtures.users.student.token,
      }, ctx);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.total_answered).toBeDefined();
      expect(data.review_due_count).toBeDefined();
    });

    it('retrieves smart review queue and records SM-2 spaced repetition score', async () => {
      const qId = ctx.fixtures.questionIds[0];
      // 1. Fetch smart review queue
      const queueRes = await apiRequest(app, 'GET', '/api/students/smart-review', {
        token: ctx.fixtures.users.student.token,
      }, ctx);
      expect(queueRes.status).toBe(200);

      // 2. Record a review score (e.g. 4 out of 5)
      const recordRes = await apiRequest(app, 'POST', '/api/students/smart-review/record', {
        token: ctx.fixtures.users.student.token,
        body: {
          question_id: qId,
          score: 4,
        },
      }, ctx);

      expect(recordRes.status).toBe(200);
      const recordData = await recordRes.json();
      expect(recordData.ok).toBe(true);
      expect(recordData.interval_days).toBeGreaterThanOrEqual(1);
      expect(recordData.next_review_at).toBeDefined();
    });

    it('aggregates rich student dashboard', async () => {
      const res = await apiRequest(app, 'GET', '/api/students/me/dashboard', {
        token: ctx.fixtures.users.student.token,
      }, ctx);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.profile).toBeDefined();
      expect(data.performance).toBeDefined();
      expect(data.recent_attempts).toBeDefined();
    });
  });

  // ────────────────── B6. Verifiable Certificates ─────────────────────────────
  describe('B6: Verifiable Certificates Issuance, Public Verification & Revocation', () => {
    it('issues certificate for passed exam and verifies publicly by code', async () => {
      // 1. Simulate completed attempt with passing score
      await ctx.db.prepare(
        'INSERT INTO exam_attempts (id, exam_id, user_id, started_at, finished_at, score, total) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind('attempt-cert-1', ctx.fixtures.examId, ctx.fixtures.users.student.id, new Date().toISOString(), new Date().toISOString(), 8, 10).run();

      // 2. Request certificate
      const issueRes = await apiRequest(app, 'POST', `/api/students/exams/${ctx.fixtures.examId}/certificate`, {
        token: ctx.fixtures.users.student.token,
      }, ctx);

      expect(issueRes.status).toBe(200);
      const cert = await issueRes.json();
      expect(cert.certificate_code).toBeDefined();
      expect(cert.score_percentage).toBe(80);

      // 3. Publicly verify certificate by code
      const verifyRes = await apiRequest(app, 'GET', `/api/public/certificates/${cert.certificate_code}`, {}, ctx);
      expect(verifyRes.status).toBe(200);
      const pubData = await verifyRes.json();
      expect(pubData.is_valid).toBe(true);
      expect(pubData.certificate_code).toBe(cert.certificate_code);

      // 4. Admin revokes certificate
      const revokeRes = await apiRequest(app, 'POST', `/api/admin/certificates/${cert.id}/revoke`, {
        token: ctx.fixtures.users.admin.token,
        body: { reason: 'فحص دوري وإلغاء شهادة غير مستحقة' },
      }, ctx);
      expect(revokeRes.status).toBe(200);

      // 5. Public verification now shows is_valid: false
      const reVerifyRes = await apiRequest(app, 'GET', `/api/public/certificates/${cert.certificate_code}`, {}, ctx);
      expect(reVerifyRes.status).toBe(200);
      const revokedData = await reVerifyRes.json();
      expect(revokedData.is_valid).toBe(false);
      expect(revokedData.revocation_reason).toContain('فحص دوري');
    });
  });

  // ────────────────── B7. Safe Public Sharing ──────────────────────────────────
  describe('B7: Safe Public Sharing', () => {
    it('returns safe public metadata for an exam without leaking answers', async () => {
      const res = await apiRequest(app, 'GET', `/api/public/share/exam/${ctx.fixtures.examId}`, {}, ctx);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe(ctx.fixtures.examId);
      expect(data.title).toBeDefined();
      expect(data.subject_name).toBeDefined();
      expect(data.choices).toBeUndefined();
      expect(data.correct_choice).toBeUndefined();
    });
  });

  // ────────────────── B8. Notifications Completion ────────────────────────────
  describe('B8: Notifications Completion (read and read-all)', () => {
    it('marks a notification as read and marks all as read', async () => {
      // Create test notification
      await ctx.db.prepare(
        'INSERT INTO notifications (id, user_id, title, body) VALUES (?, ?, ?, ?)'
      ).bind('notif-legacy-1', ctx.fixtures.users.student.id, 'إشعار تجريبي', 'محتوى الإشعار').run();

      // Read single
      const readRes = await apiRequest(app, 'PATCH', '/api/notifications/notif-legacy-1/read', {
        token: ctx.fixtures.users.student.token,
      }, ctx);
      expect(readRes.status).toBe(200);

      // Read all
      const readAllRes = await apiRequest(app, 'POST', '/api/notifications/read-all', {
        token: ctx.fixtures.users.student.token,
      }, ctx);
      expect(readAllRes.status).toBe(200);
      const readAllData = await readAllRes.json();
      expect(readAllData.ok).toBe(true);
    });
  });
});
