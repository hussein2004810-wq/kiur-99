import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, type TestContext } from '../harness/test-context';
import { apiRequest } from '../harness/app';
import { safeUploadName } from '../../src/services/storage';
import app from '../../src/index';

describe('Stages 16, 17 & 18: Media Security, Exam Integrity, and DB Invariants', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  describe('Stage 16: Media Hardening & Traversal Defense', () => {
    it('security.upload.path-traversal: rejects path traversal in media route', async () => {
      const res = await app.request('/media-files/..%2F..%2Fsecret.env', {}, ctx.bindings);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.detail).toContain('Path Traversal Detected');
    });

    it('security.upload.disallowed-extension: safeUploadName rejects dangerous or disallowed file extensions', () => {
      const allowedExts = ['jpg', 'png', 'webp'];

      expect(() => safeUploadName('exploit.exe', allowedExts, 'avatar')).toThrow(/نوع الملف غير مسموح به/);
      expect(() => safeUploadName('shell.php', allowedExts, 'avatar')).toThrow(/نوع الملف غير مسموح به/);
      expect(() => safeUploadName('script.sh', allowedExts, 'avatar')).toThrow(/نوع الملف غير مسموح به/);
    });

    it('generates completely randomized server-controlled filenames', () => {
      const allowedExts = ['jpg', 'png'];
      const generated = safeUploadName('../../../photo.jpg', allowedExts, 'avatar');

      expect(generated).not.toContain('..');
      expect(generated).toMatch(/^avatar_[a-f0-9]{12}\.jpg$/);
    });
  });

  describe('Stage 17: Exam Integrity & Server Authority', () => {
    it('security.exam.server-time-authority: answers are hidden while exam is active', async () => {
      const student = ctx.fixtures.users.student;

      const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
        token: student.token,
      }, ctx);

      expect(startRes.status).toBe(200);
      const data = await startRes.json();

      // Check questions payload
      for (const q of data.questions) {
        expect(q.is_correct).toBeUndefined();
        expect(q.correct_choice_id).toBeUndefined();
        expect(q.rationale).toBeUndefined();
      }
    });

    it('security.exam.score-server-authority: server authoritative score calculation on finish', async () => {
      const student = ctx.fixtures.users.student;

      const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
        token: student.token,
      }, ctx);
      const data = await startRes.json();
      const attemptId = data.attempt_id;
      const firstItem = data.questions[0];

      // Answer question 0 with choice 0 (which is the correct choice cho_{i}_1 in fixtures)
      const correctChoiceId = firstItem.choices[0].id;
      const ansRes = await apiRequest(
        app,
        'POST',
        `/api/exams/attempts/${attemptId}/answer`,
        {
          token: student.token,
          body: { question_id: firstItem.question_id, choice_id: correctChoiceId },
        },
        ctx
      );
      const ansData = await ansRes.json();
      if (ansRes.status !== 200) {
        console.error('ANSRES ERROR:', ansRes.status, ansData);
      }
      expect(ansRes.status).toBe(200);

      // Finish exam (try to send forged score payload from client)
      const finishRes = await apiRequest(
        app,
        'POST',
        `/api/exams/attempts/${attemptId}/finish`,
        {
          token: student.token,
          body: { score: 9999, total: 1 }, // Malicious client attempt to forge score
        },
        ctx
      );

      expect(finishRes.status).toBe(200);
      const finishData = await finishRes.json();

      // Server calculates true score, completely ignoring client body
      expect(finishData.score).toBe(1);
    });
  });

  describe('Stage 18: Database Parameterization & SQL Injection Defense', () => {
    it('security.db.sqli-safe: safely sanitizes SQL injection in search inputs', async () => {
      const student = ctx.fixtures.users.student;
      const sqliPayload = "' OR '1'='1' --";

      const res = await apiRequest(
        app,
        'GET',
        `/api/students?q=${encodeURIComponent(sqliPayload)}`,
        {
          token: student.token,
        },
        ctx
      );

      // Returns 200 with empty or matching list, never a SQL syntax error or data dump
      expect(res.status).toBe(200);
      const items = await res.json();
      expect(Array.isArray(items)).toBe(true);
    });
  });
});
