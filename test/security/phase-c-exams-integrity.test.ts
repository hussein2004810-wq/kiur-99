import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { apiRequest } from '../harness/app';
import mainApp from '../../src/index';

describe('Phase C Security & Reliability: Exam Integrity, Concurrency & Scoring', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = mainApp;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('C.1: Prevents answer leakage before submission (is_correct & rationale hidden in start snapshot)', async () => {
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(startRes.status).toBe(200);
    const data = await startRes.json();
    expect(data.attempt_id).toBeDefined();
    expect(Array.isArray(data.questions)).toBe(true);
    expect(data.questions.length).toBeGreaterThan(0);

    for (const q of data.questions) {
      expect(q.is_correct).toBeUndefined();
      expect(q.correct_choice_id).toBeUndefined();
      expect(q.rationale).toBeUndefined();
      for (const ch of q.choices) {
        expect(ch.is_correct).toBeUndefined();
      }
    }
  });

  it('C.2: Idempotent & Concurrent start returns existing active attempt without duplicating', async () => {
    const res1 = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res1.status).toBe(200);
    const data1 = await res1.json();

    const res2 = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res2.status).toBe(200);
    const data2 = await res2.json();

    expect(data2.attempt_id).toBe(data1.attempt_id);

    // Verify only one attempt row exists in DB for this user & exam
    const rows = await ctx.db.prepare(
      'SELECT id FROM exam_attempts WHERE user_id = ? AND exam_id = ? AND finished_at IS NULL'
    ).bind(ctx.fixtures.users.student.id, ctx.fixtures.examId).all();
    expect(rows.results.length).toBe(1);
  });

  it('C.3: IDOR Protection — user cannot answer or modify another student\'s attempt', async () => {
    // 1. Student 1 starts attempt
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id, questions } = await startRes.json();
    const q1 = questions[0];
    const ch1 = q1.choices[0];

    // 2. Student 2 tries to answer Student 1's attempt
    const s2User = 'usr_student2';
    await ctx.db.prepare("INSERT OR IGNORE INTO users (id, email, full_name, password_hash, role) VALUES ('usr_student2', 'student2@test.com', 'طالب ثان', 'hash', 'student')").run();
    const s2 = await ctx.createSession(s2User, 'Student 2 Phone');
    const attackerToken = s2.token;
    const ansRes = await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/answer`, {
      token: attackerToken,
      body: { question_id: q1.id, choice_id: ch1.id },
    }, ctx);

    expect([403, 404]).toContain(ansRes.status);

    // Verify DB was NOT modified by attacker
    const row = await ctx.db.prepare(
      'SELECT choice_id FROM exam_attempt_questions WHERE attempt_id = ? AND question_id = ?'
    ).bind(attempt_id, q1.id).first('choice_id');
    expect(row).toBeNull();
  });

  it('C.4: IDOR Protection — user cannot finish or review another student\'s attempt', async () => {
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id } = await startRes.json();

    const s2User = 'usr_student2';
    await ctx.db.prepare("INSERT OR IGNORE INTO users (id, email, full_name, password_hash, role) VALUES ('usr_student2', 'student2@test.com', 'طالب ثان', 'hash', 'student')").run();
    const s2 = await ctx.createSession(s2User, 'Student 2 Phone');
    const attackerToken = s2.token;

    // Attacker cannot finish
    const finishRes = await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/finish`, {
      token: attackerToken,
    }, ctx);
    expect([403, 404]).toContain(finishRes.status);

    // Attacker cannot review
    const reviewRes = await apiRequest(app, 'GET', `/api/exams/attempts/${attempt_id}/review`, {
      token: attackerToken,
    }, ctx);
    expect([403, 404]).toContain(reviewRes.status);
  });

  it('C.5: Rejects answer modification after exam is finished', async () => {
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id, questions } = await startRes.json();
    const q1 = questions[0];
    const ch1 = q1.choices[0];
    const ch2 = q1.choices[1];

    // Answer q1 with ch1
    await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/answer`, {
      token: ctx.fixtures.users.student.token,
      body: { question_id: q1.id, choice_id: ch1.id },
    }, ctx);

    // Finish attempt
    const finRes = await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/finish`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(finRes.status).toBe(200);

    // Attempt to change answer after finish
    const postFinishAns = await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/answer`, {
      token: ctx.fixtures.users.student.token,
      body: { question_id: q1.id, choice_id: ch2.id },
    }, ctx);

    expect(postFinishAns.status).toBe(400);

    // Verify DB still holds original choice
    const savedChoice = await ctx.db.prepare(
      'SELECT choice_id FROM exam_attempt_questions WHERE attempt_id = ? AND question_id = ?'
    ).bind(attempt_id, q1.id).first('choice_id');
    expect(savedChoice).toBe(ch1.id);
  });

  it('C.6: Duplicate finish rejection & idempotency guard', async () => {
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id } = await startRes.json();

    // First finish succeeds
    const finish1 = await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/finish`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(finish1.status).toBe(200);

    // Second finish fails with 400
    const finish2 = await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/finish`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(finish2.status).toBe(400);
    const data2 = await finish2.json();
    expect(data2.detail).toContain('تم إنهاء الامتحان مسبقاً');
  });

  it('C.7: Rejects choice not belonging to the question', async () => {
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id, questions } = await startRes.json();
    const q1 = questions[0];
    const q2 = questions[1];
    const ch2 = q2.choices[0]; // choice from question 2

    // Submit choice from question 2 for question 1
    const res = await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/answer`, {
      token: ctx.fixtures.users.student.token,
      body: { question_id: q1.id, choice_id: ch2.id },
    }, ctx);

    expect(res.status).toBe(400);
  });

  it('C.8: Authoritative score calculation & student analytics sync', async () => {
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id, questions } = await startRes.json();

    // Answer 2 correct, 1 wrong
    for (let i = 0; i < 3; i++) {
      const q = questions[i];
      const correctChoice = await ctx.db.prepare('SELECT id FROM choices WHERE question_id = ? AND is_correct = 1').bind(q.id).first('id');
      const wrongChoice = await ctx.db.prepare('SELECT id FROM choices WHERE question_id = ? AND is_correct = 0').bind(q.id).first('id');

      await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/answer`, {
        token: ctx.fixtures.users.student.token,
        body: { question_id: q.id, choice_id: i < 2 ? correctChoice : wrongChoice },
      }, ctx);
    }

    // Client attempts to supply fake score
    const finRes = await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/finish`, {
      token: ctx.fixtures.users.student.token,
      body: { score: 999, total: 10, percentage: 100 },
    }, ctx);

    expect(finRes.status).toBe(200);
    const data = await finRes.json();
    expect(data.score).toBe(2);
    expect(data.total).toBe(questions.length);

    // Verify student_answers has answers recorded
    const ansInDb = await ctx.db.prepare('SELECT COUNT(*) as c FROM student_answers WHERE user_id = ?')
      .bind(ctx.fixtures.users.student.id).first('c');
    expect(Number(ansInDb)).toBeGreaterThanOrEqual(3);
  });

  it('C.9: Rejects questions and exams outside the student academic scope', async () => {
    await ctx.db.prepare(
      "INSERT INTO stages (id, name, university_id) VALUES ('stg_3', 'المرحلة الثالثة', ?)"
    ).bind(ctx.fixtures.universityId).run();
    await ctx.db.prepare(
      "INSERT INTO users (id, email, full_name, password_hash, role, university_id, stage_id, section_id) VALUES ('usr_other_stage', 'other-stage@test.com', 'طالب مرحلة أخرى', 'hash', 'student', ?, 'stg_3', ?)"
    ).bind(ctx.fixtures.universityId, ctx.fixtures.sectionId).run();
    const otherStudent = await ctx.createSession('usr_other_stage', 'Other Stage Phone');

    const question = await apiRequest(app, 'GET', `/api/questions/${ctx.fixtures.questionIds[0]}`, {
      token: otherStudent.token,
    }, ctx);
    expect(question.status).toBe(403);

    const exam = await apiRequest(app, 'GET', `/api/exams/${ctx.fixtures.examId}`, {
      token: otherStudent.token,
    }, ctx);
    expect(exam.status).toBe(403);

    const start = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: otherStudent.token,
    }, ctx);
    expect(start.status).toBe(403);
  });
});
