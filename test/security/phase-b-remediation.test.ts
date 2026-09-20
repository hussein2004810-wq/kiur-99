import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { apiRequest } from '../harness/app';
import mainApp from '../../src/index';

describe('Phase B Security & Privacy Remediation Suite (Section 4 Findings)', () => {
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
  // 4.1: Email Verification Token Invalidation & Lifecycle
  // ──────────────────────────────────────────────────────────────────────────
  describe('4.1: Email Verification Invalidation on Resend', () => {
    it('invalidates prior unverified tokens when resending verification email', async () => {
      // 1. Register a student
      const regRes = await apiRequest(app, 'POST', '/auth/register', {
        body: {
          email: 'test_inval@test.com',
          full_name: 'طالب الفحص',
          password: 'Password123!',
        },
      }, ctx);
      expect(regRes.status).toBe(200);

      // Verify token exists in DB
      const user = await ctx.db.prepare('SELECT id FROM users WHERE email = ?').bind('test_inval@test.com').first();
      const tokensBefore = await ctx.db.prepare('SELECT * FROM email_verifications WHERE user_id = ?').bind(user.id).all();
      expect(tokensBefore.results.length).toBe(1);
      const firstTokenId = tokensBefore.results[0].id;

      // 2. Resend verification
      const resendRes = await apiRequest(app, 'POST', '/auth/resend-verification', {
        body: { email: 'test_inval@test.com' },
      }, ctx);
      expect(resendRes.status).toBe(200);

      // 3. Verify prior token was deleted/invalidated and a new one exists
      const tokensAfter = await ctx.db.prepare('SELECT * FROM email_verifications WHERE user_id = ?').bind(user.id).all();
      expect(tokensAfter.results.length).toBe(1);
      expect(tokensAfter.results[0].id).not.toBe(firstTokenId);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4.2: IDOR Prevention in Clinical Glimpses
  // ──────────────────────────────────────────────────────────────────────────
  describe('4.2: IDOR Prevention in Clinical Glimpses', () => {
    it('prevents Professor A from submitting, returning to draft, or archiving Professor B\'s glimpse', async () => {
      // Create Professor A
      const hash = '$2a$10$abcdefghijklmnopqrstuu';
      await ctx.db.prepare(
        "INSERT INTO users (id, email, full_name, password_hash, role) VALUES ('usr_prof_a', 'prof_a@nabd.app', 'د. أحمد', ?, 'professor')"
      ).bind(hash).run();
      await ctx.db.prepare(
        "INSERT INTO user_sessions (id, user_id, device_label, is_active) VALUES ('ses_prof_a', 'usr_prof_a', 'Device A', 1)"
      ).run();
      const tokenA = ctx.createAuthToken('usr_prof_a', 'professor', 'ses_prof_a');

      // Create Professor B
      await ctx.db.prepare(
        "INSERT INTO users (id, email, full_name, password_hash, role) VALUES ('usr_prof_b', 'prof_b@nabd.app', 'د. باسل', ?, 'professor')"
      ).bind(hash).run();
      await ctx.db.prepare(
        "INSERT INTO user_sessions (id, user_id, device_label, is_active) VALUES ('ses_prof_b', 'usr_prof_b', 'Device B', 1)"
      ).run();
      const tokenB = ctx.createAuthToken('usr_prof_b', 'professor', 'ses_prof_b');

      // Professor B creates a glimpse
      const createRes = await apiRequest(app, 'POST', '/api/admin/glimpses', {
        token: tokenB,
        body: {
          title: 'لمحة سريرية في أمراض القلب',
          summary: 'ملخص تشخيصي مهم للحالات الطارئة للأطباء والطلبة',
          clinicalPoint: 'علامة سريرية مميزة',
          targets: [{ universityId: ctx.fixtures.universityId }],
        },
      }, ctx);
      expect(createRes.status).toBe(201);
      const { id: glimpseId } = await createRes.json();

      // Professor A attempts to submit review on Professor B's glimpse -> 403 Forbidden
      const submitRes = await apiRequest(app, 'POST', `/api/admin/glimpses/${glimpseId}/submit-review`, {
        token: tokenA,
      }, ctx);
      expect(submitRes.status).toBe(403);
      const submitData = await submitRes.json();
      expect(submitData.detail || submitData.error?.message).toContain('لا تملك صلاحية');

      // Professor A attempts to archive Professor B's glimpse -> 403 Forbidden
      const archiveRes = await apiRequest(app, 'POST', `/api/admin/glimpses/${glimpseId}/archive`, {
        token: tokenA,
      }, ctx);
      expect(archiveRes.status).toBe(403);
      const archiveData = await archiveRes.json();
      expect(archiveData.detail || archiveData.error?.message).toContain('لا تملك صلاحية');

      // Professor B CAN submit review on their own glimpse -> 200 OK
      const submitOwnRes = await apiRequest(app, 'POST', `/api/admin/glimpses/${glimpseId}/submit-review`, {
        token: tokenB,
      }, ctx);
      expect(submitOwnRes.status).toBe(200);

      // Professor A attempts to return to draft Professor B's glimpse in review -> 403 Forbidden
      const returnRes = await apiRequest(app, 'POST', `/api/admin/glimpses/${glimpseId}/return-draft`, {
        token: tokenA,
      }, ctx);
      expect(returnRes.status).toBe(403);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4.3: Clinical Glimpse Multi-Dimensional Academic Scope Matching
  // ──────────────────────────────────────────────────────────────────────────
  describe('4.3: Clinical Glimpse Academic Scope', () => {
    it('filters glimpses strictly matching department and college, not just university and stage', async () => {
      // Seed college and departments
      await ctx.db.prepare(
        "INSERT INTO colleges (id, name) VALUES ('col_med', 'كلية الطب')"
      ).run();
      await ctx.db.prepare(
        "INSERT INTO departments (id, name, college_id) VALUES ('dept_general_med', 'الطب العام', 'col_med')"
      ).run();
      await ctx.db.prepare(
        "INSERT INTO departments (id, name, college_id) VALUES ('dept_dentistry', 'طب الأسنان', 'col_med')"
      ).run();

      // Create student in Medicine department
      const hash = '$2a$10$abcdefghijklmnopqrstuu';
      await ctx.db.prepare(
        "INSERT INTO users (id, email, full_name, password_hash, role, university_id, college_id, department_id, stage_id, section_id) VALUES ('usr_med_student', 'med@nabd.app', 'طالب طب عام', ?, 'student', ?, 'col_med', 'dept_general_med', ?, ?)"
      ).bind(hash, ctx.fixtures.universityId, ctx.fixtures.stageId, ctx.fixtures.sectionId).run();
      await ctx.db.prepare(
        "INSERT INTO user_sessions (id, user_id, device_label, is_active) VALUES ('ses_med', 'usr_med_student', 'Dev Med', 1)"
      ).run();
      const medToken = ctx.createAuthToken('usr_med_student', 'student', 'ses_med');

      // Create Admin token
      const admin = ctx.fixtures.users.admin;
      const adminToken = ctx.createAuthToken(admin.id, 'admin', admin.sessionId);

      // Admin creates a glimpse targeted strictly to Dentistry department ('dept_dentistry')
      const createRes = await apiRequest(app, 'POST', '/api/admin/glimpses', {
        token: adminToken,
        body: {
          title: 'لمحة سريرية خاصة بطب الأسنان',
          summary: 'ملخص خاص بطلاب قسم الأسنان فقط في المرحلة الأولى',
          clinicalPoint: 'فحص تجويف الفم',
          audienceAll: false,
          targets: [
            {
              universityId: ctx.fixtures.universityId,
              collegeId: 'col_med',
              departmentId: 'dept_dentistry',
              stageId: ctx.fixtures.stageId,
            },
          ],
        },
      }, ctx);
      expect(createRes.status).toBe(201);
      const { id: dentGlimpseId } = await createRes.json();

      // Approve and Publish the glimpse
      await apiRequest(app, 'POST', `/api/admin/glimpses/${dentGlimpseId}/approve`, { token: adminToken }, ctx);
      await apiRequest(app, 'POST', `/api/admin/glimpses/${dentGlimpseId}/publish`, { token: adminToken }, ctx);

      // Student in General Medicine requests glimpse feed
      const feedRes = await apiRequest(app, 'GET', '/api/glimpses', {
        token: medToken,
      }, ctx);
      expect(feedRes.status).toBe(200);
      const feedData = await feedRes.json();
      expect(Array.isArray(feedData.data)).toBe(true);

      // General Medicine student must NOT see the Dentistry glimpse
      const found = feedData.data.some((g: any) => g.id === dentGlimpseId);
      expect(found).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4.4: Reseller Quota Enforcement & IDOR Protection
  // ──────────────────────────────────────────────────────────────────────────
  describe('4.4: Reseller Code Quota & IDOR Protection', () => {
    it('prevents Reseller A from marking Reseller B\'s activation code as sold', async () => {
      // Create Reseller A
      const hash = '$2a$10$abcdefghijklmnopqrstuu';
      await ctx.db.prepare(
        "INSERT INTO users (id, email, full_name, password_hash, role) VALUES ('usr_res_a', 'res_a@nabd.app', 'مندوب أ', ?, 'reseller')"
      ).bind(hash).run();
      await ctx.db.prepare(
        "INSERT INTO user_sessions (id, user_id, device_label, is_active) VALUES ('ses_res_a', 'usr_res_a', 'Device A', 1)"
      ).run();
      const tokenA = ctx.createAuthToken('usr_res_a', 'reseller', 'ses_res_a');

      // Create Reseller B
      await ctx.db.prepare(
        "INSERT INTO users (id, email, full_name, password_hash, role) VALUES ('usr_res_b', 'res_b@nabd.app', 'مندوب ب', ?, 'reseller')"
      ).bind(hash).run();
      await ctx.db.prepare(
        "INSERT INTO user_sessions (id, user_id, device_label, is_active) VALUES ('ses_res_b', 'usr_res_b', 'Device B', 1)"
      ).run();
      const tokenB = ctx.createAuthToken('usr_res_b', 'reseller', 'ses_res_b');

      // Reseller B generates a code
      const genRes = await apiRequest(app, 'POST', '/api/reseller/generate', {
        token: tokenB,
        body: { count: 1 },
      }, ctx);
      expect(genRes.status).toBe(200);
      const { codes } = await genRes.json();
      const codeRecord = await ctx.db.prepare('SELECT id FROM activation_codes WHERE code = ?').bind(codes[0]).first();

      // Reseller A attempts to mark Reseller B's code as sold -> 404 / Forbidden
      const sellRes = await apiRequest(app, 'POST', `/api/reseller/codes/${codeRecord.id}/sell`, {
        token: tokenA,
      }, ctx);
      expect(sellRes.status).toBe(404);
      const sellData = await sellRes.json();
      expect(sellData.detail).toContain('غير موجود أو غير تابع لك');

      // Reseller B can mark their own code as sold -> 200 OK
      const sellOwnRes = await apiRequest(app, 'POST', `/api/reseller/codes/${codeRecord.id}/sell`, {
        token: tokenB,
      }, ctx);
      expect(sellOwnRes.status).toBe(200);
    });

    it('blocks generating more codes when reseller exceeds idle stock quota', async () => {
      const hash = '$2a$10$abcdefghijklmnopqrstuu';
      await ctx.db.prepare(
        "INSERT INTO users (id, email, full_name, password_hash, role) VALUES ('usr_res_quota', 'quota@nabd.app', 'مندوب الرصيد', ?, 'reseller')"
      ).bind(hash).run();
      await ctx.db.prepare(
        "INSERT INTO user_sessions (id, user_id, device_label, is_active) VALUES ('ses_quota', 'usr_res_quota', 'Device Quota', 1)"
      ).run();
      const token = ctx.createAuthToken('usr_res_quota', 'reseller', 'ses_quota');

      // Insert 200 idle codes for this reseller directly into DB
      for (let i = 0; i < 200; i++) {
        await ctx.db.prepare(
          "INSERT INTO activation_codes (id, code, status, reseller_id) VALUES (?, ?, 'idle', 'usr_res_quota')"
        ).bind(`code_q_${i}`, `NBD-QUOTA-${i}`).run();
      }

      // Reseller attempts to generate another batch -> 429 Quota Exceeded
      const res = await apiRequest(app, 'POST', '/api/reseller/generate', {
        token,
        body: { count: 5 },
      }, ctx);
      expect(res.status).toBe(429);
      const data = await res.json();
      expect(data.detail).toContain('تجاوزت الحد المسموح للأكواد غير المفعلة');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4.5: Student List Privacy & Email Redaction
  // ──────────────────────────────────────────────────────────────────────────
  describe('4.5: Student List Privacy & Email Redaction', () => {
    it('redacts email address from student search results for non-admin users', async () => {
      const student = ctx.fixtures.users.student;
      const studentToken = ctx.createAuthToken(student.id, 'student', student.sessionId);

      const res = await apiRequest(app, 'GET', '/api/students', {
        token: studentToken,
      }, ctx);

      expect(res.status).toBe(200);
      const list = await res.json();
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);

      // Student peer view must NOT expose email
      for (const item of list) {
        expect(item.email).toBeUndefined();
        expect(item.full_name).toBeDefined();
        expect(item.id).toBeDefined();
      }
    });

    it('includes email in student search results when accessed by administrator', async () => {
      const admin = ctx.fixtures.users.admin;
      const adminToken = ctx.createAuthToken(admin.id, 'admin', admin.sessionId);

      const res = await apiRequest(app, 'GET', '/api/students', {
        token: adminToken,
      }, ctx);

      expect(res.status).toBe(200);
      const list = await res.json();
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);

      // Admin CAN see email
      for (const item of list) {
        expect(item.email).toBeDefined();
        expect(typeof item.email).toBe('string');
      }
    });
  });

  it('4.7: prevents a professor from writing or deleting another professor\'s generic content routes', async () => {
    await ctx.db.prepare(
      "INSERT INTO users (id, email, full_name, password_hash, role) VALUES ('usr_prof_other', 'other-prof@test.com', 'د. أستاذ آخر', 'hash', 'professor')"
    ).run();
    await ctx.db.prepare(
      "INSERT INTO professor_profiles (id, user_id, title, subject_id) VALUES ('prof_other', 'usr_prof_other', 'أستاذ', ?)"
    ).bind(ctx.fixtures.subjectIds.physiology).run();
    await ctx.db.prepare(
      "INSERT INTO questions (id, subject_id, professor_id, text) VALUES ('qst_other_owner', ?, 'prof_other', 'سؤال خاص بالأستاذ الآخر')"
    ).bind(ctx.fixtures.subjectIds.physiology).run();
    await ctx.db.prepare(
      "INSERT INTO courses (id, subject_id, professor_id, title) VALUES ('crs_other_owner', ?, 'prof_other', 'كورس خاص بالأستاذ الآخر')"
    ).bind(ctx.fixtures.subjectIds.physiology).run();

    const professorA = ctx.fixtures.users.professor.token;
    const forgeExam = await apiRequest(app, 'POST', '/api/professors/exams', {
      token: professorA,
      body: {
        professor_id: 'prof_other',
        subject_id: ctx.fixtures.subjectIds.physiology,
        title: 'امتحان منتحل',
      },
    }, ctx);
    expect(forgeExam.status).toBe(403);

    const editQuestion = await apiRequest(app, 'PUT', '/api/professors/questions/qst_other_owner', {
      token: professorA,
      body: { text: 'تعديل غير مصرح' },
    }, ctx);
    expect(editQuestion.status).toBe(403);

    const deleteCourse = await apiRequest(app, 'DELETE', '/api/professors/courses/crs_other_owner', {
      token: professorA,
    }, ctx);
    expect(deleteCourse.status).toBe(403);
  });
});
