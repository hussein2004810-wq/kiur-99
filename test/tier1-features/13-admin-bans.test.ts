import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';

describe('Tier 1: Feature 13 - Admin Portal, Governance & Ban Management', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('13.1 should return platform summary statistics via GET /api/admin/overview', async () => {
    const res = await apiRequest(app, 'GET', '/api/admin/overview', {
      token: ctx.fixtures.users.admin.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.users_count).toBeGreaterThan(0);
    expect(data.courses_count).toBeGreaterThan(0);
    expect(data.exams_count).toBeGreaterThan(0);
    expect(data.orders_count).toBeDefined();
  });

  it('13.2 should list registered users via GET /api/admin/users', async () => {
    const res = await apiRequest(app, 'GET', '/api/admin/users', {
      token: ctx.fixtures.users.admin.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(4);
  });

  it('13.3 should return single user details via GET /api/admin/users/:id', async () => {
    const res = await apiRequest(app, 'GET', `/api/admin/users/${ctx.fixtures.users.student.id}`, {
      token: ctx.fixtures.users.admin.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(ctx.fixtures.users.student.id);
    expect(data.email).toBe('student@nabd.app');
  });

  it('13.4 should update a user role via PUT /api/admin/users/:id/role', async () => {
    const res = await apiRequest(app, 'PUT', `/api/admin/users/${ctx.fixtures.users.student.id}/role`, {
      token: ctx.fixtures.users.admin.token,
      body: { role: 'reseller' },
    }, ctx);

    expect(res.status).toBe(200);
    const updated = await ctx.db.prepare('SELECT role FROM users WHERE id = ?').bind(ctx.fixtures.users.student.id).first('role');
    expect(updated).toBe('reseller');
  });

  it('13.5 should ban a user with reason via POST /api/admin/users/:id/ban', async () => {
    const res = await apiRequest(app, 'POST', `/api/admin/users/${ctx.fixtures.users.student.id}/ban`, {
      token: ctx.fixtures.users.admin.token,
      body: { reason: 'تسريب محتوى المحاضرات' },
    }, ctx);

    expect(res.status).toBe(200);
    const user = await ctx.db.prepare('SELECT is_banned FROM users WHERE id = ?').bind(ctx.fixtures.users.student.id).first('is_banned');
    expect(user).toBe(1);

    const ban = await ctx.db.prepare("SELECT * FROM ban_records WHERE user_id = ? AND status = 'active'").bind(ctx.fixtures.users.student.id).first();
    expect(ban).toBeDefined();
    expect(ban.reason).toBe('تسريب محتوى المحاضرات');
  });

  it('13.6 should unban a user via POST /api/admin/users/:id/unban', async () => {
    const res = await apiRequest(app, 'POST', `/api/admin/users/${ctx.fixtures.users.bannedStudent.id}/unban`, {
      token: ctx.fixtures.users.admin.token,
    }, ctx);

    expect(res.status).toBe(200);
    const user = await ctx.db.prepare('SELECT is_banned FROM users WHERE id = ?').bind(ctx.fixtures.users.bannedStudent.id).first('is_banned');
    expect(user).toBe(0);
  });

  it('13.7 should list audit activity logs via GET /api/admin/logs', async () => {
    const res = await apiRequest(app, 'GET', '/api/admin/logs', {
      token: ctx.fixtures.users.admin.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('13.8 should list all platform orders via GET /api/admin/orders', async () => {
    const res = await apiRequest(app, 'GET', '/api/admin/orders', {
      token: ctx.fixtures.users.admin.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('13.9 should update order status via PUT /api/admin/orders/:id/status and issue activation code when paid', async () => {
    // Create an order for VIP activation code
    const ordRes = await apiRequest(app, 'POST', '/api/store/orders', {
      token: ctx.fixtures.users.student.token,
      body: {
        items: [{ product_id: ctx.fixtures.productIds.vipCode, qty: 1 }],
      },
    }, ctx);
    const { id: orderId } = await ordRes.json();

    const statusRes = await apiRequest(app, 'PUT', `/api/admin/orders/${orderId}/status`, {
      token: ctx.fixtures.users.admin.token,
      body: { status: 'paid' },
    }, ctx);

    expect(statusRes.status).toBe(200);
    const data = await statusRes.json();
    expect(data.status).toBe('paid');
    expect(data.issued_code).toBeDefined();

    // Verify code exists in activation_codes table linked to this order
    const code = await ctx.db.prepare('SELECT * FROM activation_codes WHERE order_id = ?').bind(orderId).first();
    expect(code).toBeDefined();
  });

  it('13.10 should list all ban records via GET /api/bans/records', async () => {
    const res = await apiRequest(app, 'GET', '/api/bans/records', {
      token: ctx.fixtures.users.admin.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it('13.11 should allow banned user to submit appeal via POST /api/bans/appeal', async () => {
    const res = await apiRequest(app, 'POST', '/api/bans/appeal', {
      token: ctx.fixtures.users.bannedStudent.token,
      body: { appeal_message: 'أعتذر عن فتح الحساب من جهاز آخر وأتعهد بعدم التكرار' },
    }, ctx);

    expect(res.status).toBe(200);
    const ban = await ctx.db.prepare('SELECT status, appeal_message FROM ban_records WHERE user_id = ?')
      .bind(ctx.fixtures.users.bannedStudent.id).first();
    expect(ban.status).toBe('appealed');
    expect(ban.appeal_message).toContain('أعتذر');
  });

  it('13.12 should allow admin to resolve appeal and lift ban via PUT /api/admin/bans/:id/resolve', async () => {
    const res = await apiRequest(app, 'PUT', `/api/admin/bans/${ctx.fixtures.users.bannedStudent.banRecordId}/resolve`, {
      token: ctx.fixtures.users.admin.token,
      body: { action: 'lift' },
    }, ctx);

    expect(res.status).toBe(200);
    const user = await ctx.db.prepare('SELECT is_banned FROM users WHERE id = ?')
      .bind(ctx.fixtures.users.bannedStudent.id).first('is_banned');
    expect(user).toBe(0);
  });
});
