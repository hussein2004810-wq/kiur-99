import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';

describe('Tier 1: Feature 7 - Student Workspace, Skills & Stats', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('7.1 should retrieve student public profile via GET /api/students/profile', async () => {
    const res = await apiRequest(app, 'GET', '/api/students/profile', {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(ctx.fixtures.users.student.id);
    expect(data.full_name).toBe('علي محمد');
    expect(Array.isArray(data.skills)).toBe(true);
  });

  it('7.2 should retrieve student analytics via GET /api/students/stats', async () => {
    const res = await apiRequest(app, 'GET', '/api/students/stats', {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.answered_count).toBeDefined();
    expect(data.correct_count).toBeDefined();
    expect(data.accuracy).toBeDefined();
    expect(data.streak_days).toBeDefined();
  });

  it('7.3 should return student skills list via GET /api/students/skills', async () => {
    const res = await apiRequest(app, 'GET', '/api/students/skills', {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('7.4 should add a new skill tag via POST /api/students/skills', async () => {
    const res = await apiRequest(app, 'POST', '/api/students/skills', {
      token: ctx.fixtures.users.student.token,
      body: { text: 'تشريح القلب والأوعية' },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.text).toBe('تشريح القلب والأوعية');

    const listRes = await apiRequest(app, 'GET', '/api/students/skills', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const listData = await listRes.json();
    expect(listData.some((s: any) => s.text === 'تشريح القلب والأوعية')).toBe(true);
  });

  it('7.5 should delete a skill tag via DELETE /api/students/skills/:id', async () => {
    const addRes = await apiRequest(app, 'POST', '/api/students/skills', {
      token: ctx.fixtures.users.student.token,
      body: { text: 'مهارة مؤقتة' },
    }, ctx);
    const { id } = await addRes.json();

    const delRes = await apiRequest(app, 'DELETE', `/api/students/skills/${id}`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(delRes.status).toBe(200);

    const listRes = await apiRequest(app, 'GET', '/api/students/skills', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const listData = await listRes.json();
    expect(listData.some((s: any) => s.id === id)).toBe(false);
  });

  it('7.6 should return study tracker session data via GET /api/students/study-tracker', async () => {
    const res = await apiRequest(app, 'GET', '/api/students/study-tracker', {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total_minutes).toBeDefined();
  });

  it('7.7 should record study time session via POST /api/students/study-tracker', async () => {
    const res = await apiRequest(app, 'POST', '/api/students/study-tracker', {
      token: ctx.fixtures.users.student.token,
      body: {
        duration_minutes: 45,
        subject_id: ctx.fixtures.subjectIds.anatomy,
      },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.recorded_minutes).toBe(45);
  });

  it('7.8 should return student lecture progress via GET /api/students/lecture-progress', async () => {
    const res = await apiRequest(app, 'GET', '/api/students/lecture-progress', {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('7.9 should record lecture completion via POST /api/students/lecture-progress', async () => {
    const res = await apiRequest(app, 'POST', '/api/students/lecture-progress', {
      token: ctx.fixtures.users.student.token,
      body: { lecture_id: ctx.fixtures.lectureIds[0] },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.lecture_id).toBe(ctx.fixtures.lectureIds[0]);

    const progRes = await apiRequest(app, 'GET', '/api/students/lecture-progress', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const progData = await progRes.json();
    expect(progData.some((p: any) => p.lecture_id === ctx.fixtures.lectureIds[0])).toBe(true);
  });

  it('7.10 should return overall student leaderboard rankings via GET /api/students/leaderboard', async () => {
    const res = await apiRequest(app, 'GET', '/api/students/leaderboard', { token: ctx.fixtures.users.student.token }, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    if (data.length > 0) {
      expect(data[0].rank).toBe(1);
      expect(data[0].full_name).toBeDefined();
    }
  });
});
