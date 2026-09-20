import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';

describe('Tier 1: Feature 6 - Exams, Attempts & Scoring Engine', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('6.1 should list all available exams via GET /api/exams', async () => {
    const res = await apiRequest(app, 'GET', '/api/exams', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].id).toBe(ctx.fixtures.examId);
  });

  it('6.2 should filter exams by subject_id query param', async () => {
    const res = await apiRequest(app, 'GET', `/api/exams?subject_id=${ctx.fixtures.subjectIds.anatomy}`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.every((e: any) => e.subject_id === ctx.fixtures.subjectIds.anatomy)).toBe(true);
  });

  it('6.3 should return single exam details via GET /api/exams/:id', async () => {
    const res = await apiRequest(app, 'GET', `/api/exams/${ctx.fixtures.examId}`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(ctx.fixtures.examId);
    expect(data.title).toContain('امتحان تشريح');
    expect(data.duration_minutes).toBe(30);
  });

  it('6.4 should start an exam attempt and generate shuffled question snapshot', async () => {
    const res = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.attempt_id).toBeDefined();
    expect(data.exam_id).toBe(ctx.fixtures.examId);
    expect(Array.isArray(data.questions)).toBe(true);
    expect(data.questions.length).toBe(5);
  });

  it('6.5 should record student answer to an exam question during active attempt', async () => {
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id, questions } = await startRes.json();
    const q1 = questions[0];
    const ch1 = q1.choices[0];

    const ansRes = await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/answer`, {
      token: ctx.fixtures.users.student.token,
      body: {
        question_id: q1.id,
        choice_id: ch1.id,
      },
    }, ctx);

    expect(ansRes.status).toBe(200);
    const data = await ansRes.json();
    expect(data.recorded).toBe(true);
  });

  it('6.6 should update answer if student changes their choice before finishing attempt', async () => {
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id, questions } = await startRes.json();
    const q1 = questions[0];
    const ch1 = q1.choices[0];
    const ch2 = q1.choices[1];

    // Choice 1
    await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/answer`, {
      token: ctx.fixtures.users.student.token,
      body: { question_id: q1.id, choice_id: ch1.id },
    }, ctx);

    // Choice 2 (change mind)
    const updateRes = await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/answer`, {
      token: ctx.fixtures.users.student.token,
      body: { question_id: q1.id, choice_id: ch2.id },
    }, ctx);

    expect(updateRes.status).toBe(200);
    const row = await ctx.db.prepare('SELECT choice_id FROM exam_attempt_questions WHERE attempt_id = ? AND question_id = ?')
      .bind(attempt_id, q1.id).first('choice_id');
    expect(row).toBe(ch2.id);
  });

  it('6.7 should finish exam attempt and compute score and percentage accurately', async () => {
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id, questions } = await startRes.json();

    // Answer 3 correctly, 2 incorrectly
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const correctChoice = await ctx.db.prepare('SELECT id FROM choices WHERE question_id = ? AND is_correct = 1').bind(q.id).first('id');
      const wrongChoice = await ctx.db.prepare('SELECT id FROM choices WHERE question_id = ? AND is_correct = 0').bind(q.id).first('id');

      const choiceToSubmit = i < 3 ? correctChoice : wrongChoice;
      await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/answer`, {
        token: ctx.fixtures.users.student.token,
        body: { question_id: q.id, choice_id: choiceToSubmit },
      }, ctx);
    }

    const finishRes = await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/finish`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(finishRes.status).toBe(200);
    const data = await finishRes.json();
    expect(data.score).toBe(3);
    expect(data.total).toBe(5);
    expect(data.percentage).toBe(60);
    expect(data.finished_at).toBeDefined();
  });

  it('6.8 should review completed exam attempt with user choices and correct answers', async () => {
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id } = await startRes.json();

    await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/finish`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    const revRes = await apiRequest(app, 'GET', `/api/exams/attempts/${attempt_id}/review`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(revRes.status).toBe(200);
    const data = await revRes.json();
    expect(data.attempt).toBeDefined();
    expect(Array.isArray(data.questions)).toBe(true);
  });

  it('6.9 should list student personal exam attempts via GET /api/exams/attempts/mine', async () => {
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id } = await startRes.json();
    await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/finish`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    const res = await apiRequest(app, 'GET', '/api/exams/attempts/mine', {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((a: any) => a.id === attempt_id)).toBe(true);
  });

  it('6.10 should retrieve ranked exam leaderboard via GET /api/exams/:id/leaderboard', async () => {
    // Finish student attempt with score 4
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id } = await startRes.json();
    await ctx.db.prepare("UPDATE exam_attempts SET score = 4, total = 5, finished_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), attempt_id).run();

    const res = await apiRequest(app, 'GET', `/api/exams/${ctx.fixtures.examId}/leaderboard`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].rank).toBe(1);
    expect(data[0].score).toBe(4);
  });

  it('6.11 should rank highest scores first on exam leaderboard', async () => {
    // Create another student
    const s2 = await ctx.createSession(ctx.fixtures.users.admin.id, 'Admin attempt');
    await ctx.db.prepare("INSERT INTO exam_attempts (id, exam_id, user_id, score, total, finished_at) VALUES ('att_top', ?, ?, 5, 5, ?)")
      .bind(ctx.fixtures.examId, ctx.fixtures.users.admin.id, new Date().toISOString()).run();

    const res = await apiRequest(app, 'GET', `/api/exams/${ctx.fixtures.examId}/leaderboard`, {
      token: s2.token,
    }, ctx);
    const data = await res.json();
    expect(data[0].score).toBe(5);
    expect(data[0].rank).toBe(1);
  });

  it('6.12 should increment student answered questions count upon finishing exam attempt', async () => {
    const statsBefore = await apiRequest(app, 'GET', '/api/students/stats', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const beforeData = await statsBefore.json();

    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id, questions } = await startRes.json();

    // Answer 2 questions
    const q1 = questions[0];
    const q2 = questions[1];
    const ch1 = await ctx.db.prepare('SELECT id FROM choices WHERE question_id = ?').bind(q1.id).first('id');
    const ch2 = await ctx.db.prepare('SELECT id FROM choices WHERE question_id = ?').bind(q2.id).first('id');

    await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/answer`, {
      token: ctx.fixtures.users.student.token,
      body: { question_id: q1.id, choice_id: ch1 },
    }, ctx);
    await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/answer`, {
      token: ctx.fixtures.users.student.token,
      body: { question_id: q2.id, choice_id: ch2 },
    }, ctx);

    await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/finish`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    const statsAfter = await apiRequest(app, 'GET', '/api/students/stats', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const afterData = await statsAfter.json();
    expect(afterData.answered_count).toBeGreaterThan(beforeData.answered_count);
  });
});
