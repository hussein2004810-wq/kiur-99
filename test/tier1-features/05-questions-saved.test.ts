import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';

describe('Tier 1: Feature 5 - Questions & Saved Bookmarks', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('5.1 should list questions for a subject via GET /api/questions?subject_id=...', async () => {
    const res = await apiRequest(app, 'GET', `/api/questions?subject_id=${ctx.fixtures.subjectIds.anatomy}`, { token: ctx.fixtures.users.student.token }, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(5);
  });

  it('5.2 should retrieve single question with choices via GET /api/questions/:id without exposing is_correct', async () => {
    const qId = ctx.fixtures.questionIds[0];
    const res = await apiRequest(app, 'GET', `/api/questions/${qId}`, { token: ctx.fixtures.users.student.token }, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(qId);
    expect(Array.isArray(data.choices)).toBe(true);
    expect(data.choices.length).toBe(4);
    // Crucial: Opaque test ensures students cannot see is_correct in choices array
    expect(data.choices[0].is_correct).toBeUndefined();
  });

  it('5.3 should submit a correct answer to a question and receive positive feedback', async () => {
    const qId = ctx.fixtures.questionIds[0];
    const correctChoice = await ctx.db.prepare('SELECT id FROM choices WHERE question_id = ? AND is_correct = 1')
      .bind(qId).first('id');

    const res = await apiRequest(app, 'POST', `/api/questions/${qId}/answer`, {
      token: ctx.fixtures.users.student.token,
      body: { choice_id: correctChoice },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.is_correct).toBe(true);
    expect(data.rationale).toBeDefined();
    expect(data.correct_choice_id).toBe(correctChoice);
  });

  it('5.4 should submit an incorrect answer to a question and receive rationale and correct choice', async () => {
    const qId = ctx.fixtures.questionIds[0];
    const incorrectChoice = await ctx.db.prepare('SELECT id FROM choices WHERE question_id = ? AND is_correct = 0')
      .bind(qId).first('id');

    const res = await apiRequest(app, 'POST', `/api/questions/${qId}/answer`, {
      token: ctx.fixtures.users.student.token,
      body: { choice_id: incorrectChoice },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.is_correct).toBe(false);
    expect(data.rationale).toBeDefined();
    expect(data.correct_choice_id).toBeDefined();
  });

  it('5.5 should bookmark a question for review via POST /api/saved-questions/:id', async () => {
    const qId = ctx.fixtures.questionIds[0];
    const res = await apiRequest(app, 'POST', `/api/saved-questions/${qId}`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toBeDefined();
  });

  it('5.6 should retrieve all saved bookmarked questions via GET /api/saved-questions', async () => {
    const qId = ctx.fixtures.questionIds[0];
    await apiRequest(app, 'POST', `/api/saved-questions/${qId}`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    const res = await apiRequest(app, 'GET', '/api/saved-questions', {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((sq: any) => sq.id === qId || sq.question_id === qId)).toBe(true);
  });

  it('5.7 should delete bookmark via DELETE /api/saved-questions/:id', async () => {
    const qId = ctx.fixtures.questionIds[0];
    await apiRequest(app, 'POST', `/api/saved-questions/${qId}`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    const delRes = await apiRequest(app, 'DELETE', `/api/saved-questions/${qId}`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(delRes.status).toBe(200);

    const listRes = await apiRequest(app, 'GET', '/api/saved-questions', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const listData = await listRes.json();
    expect(listData.some((sq: any) => sq.id === qId || sq.question_id === qId)).toBe(false);
  });

  it('5.8 should search questions by keyword text via GET /api/questions?search=...', async () => {
    const res = await apiRequest(app, 'GET', '/api/questions?search=رقم 1', { token: ctx.fixtures.users.student.token }, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].text).toContain('رقم 1');
  });

  it('5.9 should return daily practice questions set via GET /api/questions/daily', async () => {
    const res = await apiRequest(app, 'GET', '/api/questions/daily', { token: ctx.fixtures.users.student.token }, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it('5.10 should persist student answer history in database upon answering question', async () => {
    const qId = ctx.fixtures.questionIds[1];
    const choice = await ctx.db.prepare('SELECT id FROM choices WHERE question_id = ?').bind(qId).first('id');

    await apiRequest(app, 'POST', `/api/questions/${qId}/answer`, {
      token: ctx.fixtures.users.student.token,
      body: { choice_id: choice },
    }, ctx);

    const record = await ctx.db.prepare('SELECT * FROM student_answers WHERE user_id = ? AND question_id = ?')
      .bind(ctx.fixtures.users.student.id, qId).first();
    expect(record).toBeDefined();
    expect(record.choice_id).toBe(choice);
  });
});
