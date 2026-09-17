import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';

describe('Tier 1: Feature 15 - Notifications & Public Metrics', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('15.1 should list student notifications via GET /api/notifications', async () => {
    // Insert a broadcast notification
    await ctx.db.prepare("INSERT INTO notifications (id, title, body) VALUES ('notif_1', 'تنبيه مهم', 'تم إضافة امتحان تجريبي جديد')").run();

    const res = await apiRequest(app, 'GET', '/api/notifications', {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].title).toBe('تنبيه مهم');
  });

  it('15.2 should return unread notifications count via GET /api/notifications/unread-count', async () => {
    await ctx.db.prepare("INSERT INTO notifications (id, title, body) VALUES ('notif_2', 'إشعار جديد', 'محتوى الإشعار')").run();

    const res = await apiRequest(app, 'GET', '/api/notifications/unread-count', {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.unread_count).toBeGreaterThan(0);
  });

  it('15.3 should mark a single notification as read via POST /api/notifications/:id/read', async () => {
    await ctx.db.prepare("INSERT INTO notifications (id, title, body) VALUES ('notif_3', 'إشعار للقراءة', 'محتوى')").run();

    const countBeforeRes = await apiRequest(app, 'GET', '/api/notifications/unread-count', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const beforeCount = (await countBeforeRes.json()).unread_count;

    const readRes = await apiRequest(app, 'POST', '/api/notifications/notif_3/read', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(readRes.status).toBe(200);

    const countAfterRes = await apiRequest(app, 'GET', '/api/notifications/unread-count', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const afterCount = (await countAfterRes.json()).unread_count;
    expect(afterCount).toBeLessThan(beforeCount);
  });

  it('15.4 should mark all notifications as read via POST /api/notifications/read-all', async () => {
    await ctx.db.prepare("INSERT INTO notifications (id, title, body) VALUES ('notif_4', 'إشعار 4', 'محتوى')").run();
    await ctx.db.prepare("INSERT INTO notifications (id, title, body) VALUES ('notif_5', 'إشعار 5', 'محتوى')").run();

    const readAllRes = await apiRequest(app, 'POST', '/api/notifications/read-all', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(readAllRes.status).toBe(200);

    const countRes = await apiRequest(app, 'GET', '/api/notifications/unread-count', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const data = await countRes.json();
    expect(data.unread_count).toBe(0);
  });

  it('15.5 should return public platform statistics via GET /api/public/stats', async () => {
    const res = await apiRequest(app, 'GET', '/api/public/stats', {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total_students).toBeGreaterThan(0);
    expect(data.total_courses).toBeGreaterThan(0);
    expect(data.total_exams).toBeGreaterThan(0);
  });

  it('15.6 should list professors publicly via GET /api/public/professors', async () => {
    const res = await apiRequest(app, 'GET', '/api/public/professors', {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });
});
