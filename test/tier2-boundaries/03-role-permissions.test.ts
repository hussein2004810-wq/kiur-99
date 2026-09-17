import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';

describe('Tier 2: Boundary 3 - Role-Based Access Control & Permissions', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('B3.1 should reject student from GET /api/admin/overview with 403', async () => {
    const res = await apiRequest(app, 'GET', '/api/admin/overview', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.detail).toContain('صلاحية');
  });

  it('B3.2 should reject student from GET /api/admin/users with 403', async () => {
    const res = await apiRequest(app, 'GET', '/api/admin/users', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.3 should reject student from PUT /api/admin/users/:id/role with 403', async () => {
    const res = await apiRequest(app, 'PUT', `/api/admin/users/${ctx.fixtures.users.student.id}/role`, {
      token: ctx.fixtures.users.student.token,
      body: { role: 'admin' },
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.4 should reject student from POST /api/admin/users/:id/ban with 403', async () => {
    const res = await apiRequest(app, 'POST', `/api/admin/users/${ctx.fixtures.users.admin.id}/ban`, {
      token: ctx.fixtures.users.student.token,
      body: { reason: 'محاولة حظر المسؤول' },
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.5 should reject student from POST /api/admin/users/:id/unban with 403', async () => {
    const res = await apiRequest(app, 'POST', `/api/admin/users/${ctx.fixtures.users.bannedStudent.id}/unban`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.6 should reject student from GET /api/admin/logs with 403', async () => {
    const res = await apiRequest(app, 'GET', '/api/admin/logs', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.7 should reject student from GET /api/admin/orders with 403', async () => {
    const res = await apiRequest(app, 'GET', '/api/admin/orders', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.8 should reject student from PUT /api/admin/orders/:id/status with 403', async () => {
    const res = await apiRequest(app, 'PUT', '/api/admin/orders/ord_123/status', {
      token: ctx.fixtures.users.student.token,
      body: { status: 'paid' },
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.9 should reject student from POST /api/admin/media/upload with 403', async () => {
    const res = await apiRequest(app, 'POST', '/api/admin/media/upload', {
      token: ctx.fixtures.users.student.token,
      body: new Uint8Array([1, 2, 3]),
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.10 should reject student from GET /api/admin/media with 403', async () => {
    const res = await apiRequest(app, 'GET', '/api/admin/media', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.11 should reject student from GET /api/bans/records with 403', async () => {
    const res = await apiRequest(app, 'GET', '/api/bans/records', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.12 should reject student from PUT /api/admin/bans/:id/resolve with 403', async () => {
    const res = await apiRequest(app, 'PUT', '/api/admin/bans/ban_1/resolve', {
      token: ctx.fixtures.users.student.token,
      body: { action: 'lift' },
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.13 should reject student from GET /api/professors/me with 403', async () => {
    const res = await apiRequest(app, 'GET', '/api/professors/me', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.14 should reject student from PUT /api/professors/me with 403', async () => {
    const res = await apiRequest(app, 'PUT', '/api/professors/me', {
      token: ctx.fixtures.users.student.token,
      body: { title: 'أستاذ غير شرعي' },
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.15 should reject student from POST /api/professors/booklets with 403', async () => {
    const res = await apiRequest(app, 'POST', '/api/professors/booklets', {
      token: ctx.fixtures.users.student.token,
      body: { title: 'ملزمة غير مصرح بها' },
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.16 should reject student from POST /api/professors/questions with 403', async () => {
    const res = await apiRequest(app, 'POST', '/api/professors/questions', {
      token: ctx.fixtures.users.student.token,
      body: { text: 'سؤال غير مصرح به' },
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.17 should reject student from POST /api/professors/exams with 403', async () => {
    const res = await apiRequest(app, 'POST', '/api/professors/exams', {
      token: ctx.fixtures.users.student.token,
      body: { title: 'امتحان غير مصرح به' },
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.18 should reject student from POST /api/professors/courses with 403', async () => {
    const res = await apiRequest(app, 'POST', '/api/professors/courses', {
      token: ctx.fixtures.users.student.token,
      body: { title: 'كورس غير مصرح به' },
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.19 should reject student from GET /api/reseller/inventory with 403', async () => {
    const res = await apiRequest(app, 'GET', '/api/reseller/inventory', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.20 should reject student from GET /api/reseller/stats with 403', async () => {
    const res = await apiRequest(app, 'GET', '/api/reseller/stats', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.21 should reject student from POST /api/reseller/generate with 403', async () => {
    const res = await apiRequest(app, 'POST', '/api/reseller/generate', {
      token: ctx.fixtures.users.student.token,
      body: { count: 5 },
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.22 should reject professor from GET /api/admin/overview with 403', async () => {
    const res = await apiRequest(app, 'GET', '/api/admin/overview', {
      token: ctx.fixtures.users.professor.token,
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.23 should reject professor from POST /api/admin/users/:id/ban with 403', async () => {
    const res = await apiRequest(app, 'POST', `/api/admin/users/${ctx.fixtures.users.student.id}/ban`, {
      token: ctx.fixtures.users.professor.token,
      body: { reason: 'حظر من أستاذ' },
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.24 should reject professor from GET /api/reseller/inventory with 403', async () => {
    const res = await apiRequest(app, 'GET', '/api/reseller/inventory', {
      token: ctx.fixtures.users.professor.token,
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.25 should reject reseller from GET /api/admin/overview with 403', async () => {
    const res = await apiRequest(app, 'GET', '/api/admin/overview', {
      token: ctx.fixtures.users.reseller.token,
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.26 should reject reseller from POST /api/professors/courses with 403', async () => {
    const res = await apiRequest(app, 'POST', '/api/professors/courses', {
      token: ctx.fixtures.users.reseller.token,
      body: { title: 'كورس وكيل' },
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.27 should reject reseller from GET /api/professors/me with 403', async () => {
    const res = await apiRequest(app, 'GET', '/api/professors/me', {
      token: ctx.fixtures.users.reseller.token,
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.28 should block banned student from accessing GET /auth/me with 403', async () => {
    const res = await apiRequest(app, 'GET', '/auth/me', {
      token: ctx.fixtures.users.bannedStudent.token,
    }, ctx);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.detail).toContain('محظور');
  });

  it('B3.29 should block banned student from starting exam with 403', async () => {
    const res = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.bannedStudent.token,
    }, ctx);
    expect(res.status).toBe(403);
  });

  it('B3.30 should permit banned student to access their ban status via GET /api/bans/mine', async () => {
    const res = await apiRequest(app, 'GET', '/api/bans/mine', {
      token: ctx.fixtures.users.bannedStudent.token,
    }, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('active');
  });
});
