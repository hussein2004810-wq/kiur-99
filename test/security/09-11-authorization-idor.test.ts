import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, type TestContext } from '../harness/test-context';
import { apiRequest } from '../harness/app';
import app from '../../src/index';

describe('Stages 9, 10 & 11: Authorization, IDOR Protection, and Privilege Hardening', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  describe('Stage 9 & 11: Role Hardening and Escalation Prevention', () => {
    it('security.authz.role-escalation: client payload cannot promote student role to admin via profile update', async () => {
      const student = ctx.fixtures.users.student;

      const res = await apiRequest(app, 'PUT', '/auth/me/profile', {
        token: student.token,
        body: {
          full_name: 'Hacker Student',
          phone: '07701234567',
          section_id: ctx.fixtures.sectionId,
          university_id: ctx.fixtures.universityId,
          stage_id: ctx.fixtures.stageId,
          role: 'admin', // Attempted privilege escalation
        },
      }, ctx);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.role).toBe('student'); // Role must remain unchanged

      // Verify directly in DB
      const dbUser = await ctx.db
        .prepare('SELECT role FROM users WHERE id = ?')
        .bind(student.id)
        .first('role');
      expect(dbUser).toBe('student');
    });

    it('security.authz.admin-route-blocked: student receives 403 on admin routes', async () => {
      const student = ctx.fixtures.users.student;
      const res = await apiRequest(app, 'GET', '/api/admin/overview', {
        token: student.token,
      }, ctx);
      expect(res.status).toBe(403);
    });

    it('security.authz.professor-admin-blocked: professor receives 403 on admin routes', async () => {
      const prof = ctx.fixtures.users.professor;
      const res = await apiRequest(app, 'GET', '/api/admin/users', {
        token: prof.token,
      }, ctx);
      expect(res.status).toBe(403);
    });

    it('security.authz.bootstrap-blocked: cannot bootstrap admin if an admin already exists', async () => {
      const res = await apiRequest(app, 'POST', '/auth/register', {
        body: {
          email: 'new-admin@nabd.app',
          password: 'StrongPassword@2026',
          full_name: 'Fake Admin',
        },
      }, ctx);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.role).toBe('student'); // Must be student, not admin
    });
  });

  describe('Stage 10: IDOR & BOLA Defense', () => {
    async function createStudentB() {
      await ctx.db.exec(`
        INSERT INTO users (id, email, full_name, role)
        VALUES ('usr_student_b', 'student_b@nabd.app', 'Student B', 'student');
      `);
      return ctx.createSession('usr_student_b', 'Student B Device');
    }

    it('security.authz.idor.attempt-access: User B cannot access User A exam attempt result', async () => {
      const studentA = ctx.fixtures.users.student;
      const studentB = await createStudentB();

      // Student A starts exam
      const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
        token: studentA.token,
      }, ctx);
      expect(startRes.status).toBe(200);
      const attemptId = (await startRes.json()).attempt_id;

      // Student B attempts to access Student A's exam attempt result (IDOR)
      const idorRes = await apiRequest(app, 'GET', `/api/exams/attempts/${attemptId}/result`, {
        token: studentB.token,
      }, ctx);

      // Must return 404 (deny knowledge of attempt)
      expect(idorRes.status).toBe(404);
      expect((await idorRes.json()).detail).toContain('المحاولة غير موجودة');
    });

    it('security.authz.idor.attempt-answer: User B cannot answer questions on User A exam attempt', async () => {
      const studentA = ctx.fixtures.users.student;
      const studentB = await createStudentB();

      // Student A starts exam
      const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
        token: studentA.token,
      }, ctx);
      const attemptData = await startRes.json();
      const attemptId = attemptData.attempt_id;
      const itemId = attemptData.questions[0].item_id;
      const choiceId = attemptData.questions[0].choices[0].id;

      // Student B attempts to submit answer on Student A attempt
      const idorAnswerRes = await apiRequest(
        app,
        'POST',
        `/api/exams/attempts/${attemptId}/items/${itemId}/answer`,
        {
          token: studentB.token,
          body: { choice_id: choiceId },
        },
        ctx
      );

      expect(idorAnswerRes.status).toBe(404);
    });

    it('security.authz.idor.attempt-finish: User B cannot finish User A exam attempt', async () => {
      const studentA = ctx.fixtures.users.student;
      const studentB = await createStudentB();

      const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
        token: studentA.token,
      }, ctx);
      const attemptId = (await startRes.json()).attempt_id;

      const finishRes = await apiRequest(app, 'POST', `/api/exams/attempts/${attemptId}/finish`, {
        token: studentB.token,
      }, ctx);

      expect(finishRes.status).toBe(404);
    });
  });
});
