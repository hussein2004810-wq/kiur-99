import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';

describe('Tier 1: Feature 9 - Courses & Video Lectures', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('9.1 should list all courses via GET /api/courses', async () => {
    const res = await apiRequest(app, 'GET', '/api/courses', {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].id).toBe(ctx.fixtures.courseId);
  });

  it('9.2 should filter courses by subject_id query param', async () => {
    const res = await apiRequest(app, 'GET', `/api/courses?subject_id=${ctx.fixtures.subjectIds.anatomy}`, {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.every((c: any) => c.subject_id === ctx.fixtures.subjectIds.anatomy)).toBe(true);
  });

  it('9.3 should retrieve single course with lecture syllabus via GET /api/courses/:id', async () => {
    const res = await apiRequest(app, 'GET', `/api/courses/${ctx.fixtures.courseId}`, {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(ctx.fixtures.courseId);
    expect(Array.isArray(data.lectures)).toBe(true);
    expect(data.lectures.length).toBe(3);
  });

  it('9.4 should retrieve course lectures in sequential order via GET /api/courses/:id/lectures', async () => {
    const res = await apiRequest(app, 'GET', `/api/courses/${ctx.fixtures.courseId}/lectures`, {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(3);
    expect(data[0].order_index).toBe(0);
    expect(data[1].order_index).toBe(1);
    expect(data[2].order_index).toBe(2);
  });

  it('9.5 should retrieve single lecture metadata via GET /api/lectures/:id', async () => {
    const lecId = ctx.fixtures.lectureIds[0];
    const res = await apiRequest(app, 'GET', `/api/lectures/${lecId}`, {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(lecId);
    expect(data.duration_seconds).toBe(1200);
    expect(data.video_url).toBeDefined();
  });

  it('9.6 should update video playback progress via POST /api/lectures/:id/progress', async () => {
    const lecId = ctx.fixtures.lectureIds[0];
    const res = await apiRequest(app, 'POST', `/api/lectures/${lecId}/progress`, {
      token: ctx.fixtures.users.student.token,
      body: { seconds: 450 },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.lecture_id).toBe(lecId);
    expect(data.seconds).toBe(450);
  });

  it('9.7 should record student recent view item via POST /api/recent-views', async () => {
    const res = await apiRequest(app, 'POST', '/api/recent-views', {
      token: ctx.fixtures.users.student.token,
      body: {
        content_type: 'lecture',
        content_id: ctx.fixtures.lectureIds[0],
      },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toBeDefined();
  });

  it('9.8 should retrieve list of recently viewed items via GET /api/recent-views', async () => {
    await apiRequest(app, 'POST', '/api/recent-views', {
      token: ctx.fixtures.users.student.token,
      body: {
        content_type: 'lecture',
        content_id: ctx.fixtures.lectureIds[1],
      },
    }, ctx);

    const res = await apiRequest(app, 'GET', '/api/recent-views', {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((rv: any) => rv.content_id === ctx.fixtures.lectureIds[1])).toBe(true);
  });

  it('9.9 should search courses by title query via GET /api/courses/search?q=...', async () => {
    const res = await apiRequest(app, 'GET', '/api/courses/search?q=الشامل', {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].title).toContain('الشامل');
  });

  it('9.10 should calculate course total duration and lecture count via GET /api/courses/:id/stats', async () => {
    const res = await apiRequest(app, 'GET', `/api/courses/${ctx.fixtures.courseId}/stats`, {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.lecture_count).toBe(3);
    expect(data.total_duration_seconds).toBe(1200 + 1800 + 2100);
  });
});
