import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';

describe('Tier 2: Boundary 4 - Resource Limits, Non-Existent Entities & State Machine', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('B4.1 should return 404 for non-existent section ID via GET /api/catalog/sections/:id', async () => {
    const res = await apiRequest(app, 'GET', '/api/catalog/sections/sec_ghost', {}, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.2 should return 404 for non-existent university ID via GET /api/catalog/universities/:id', async () => {
    const res = await apiRequest(app, 'GET', '/api/catalog/universities/uni_ghost', {}, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.3 should return 404 for non-existent stage ID via GET /api/catalog/stages/:id', async () => {
    const res = await apiRequest(app, 'GET', '/api/catalog/stages/stg_ghost', {}, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.4 should return 404 for non-existent subject ID via GET /api/catalog/subjects/:id/booklets', async () => {
    const res = await apiRequest(app, 'GET', '/api/catalog/subjects/sub_ghost/booklets', {}, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.5 should return 404 for non-existent question ID via GET /api/questions/:id', async () => {
    const res = await apiRequest(app, 'GET', '/api/questions/qst_ghost', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.6 should return 404 for non-existent exam ID via GET /api/exams/:id', async () => {
    const res = await apiRequest(app, 'GET', '/api/exams/exm_ghost', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.7 should return 404 for non-existent exam ID on start attempt', async () => {
    const res = await apiRequest(app, 'POST', '/api/exams/exm_ghost/start', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.8 should return 404 for non-existent exam attempt ID on submit answer', async () => {
    const res = await apiRequest(app, 'POST', '/api/exams/attempts/att_ghost/answer', {
      token: ctx.fixtures.users.student.token,
      body: { question_id: 'qst_1', choice_id: 'cho_1' },
    }, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.9 should return 404 for non-existent exam attempt ID on finish attempt', async () => {
    const res = await apiRequest(app, 'POST', '/api/exams/attempts/att_ghost/finish', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.10 should return 404 for non-existent exam attempt ID on review', async () => {
    const res = await apiRequest(app, 'GET', '/api/exams/attempts/att_ghost/review', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.11 should return 404 for non-existent course ID via GET /api/courses/:id', async () => {
    const res = await apiRequest(app, 'GET', '/api/courses/crs_ghost', {}, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.12 should return 404 for non-existent lecture ID via GET /api/lectures/:id', async () => {
    const res = await apiRequest(app, 'GET', '/api/lectures/lec_ghost', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.13 should return 404 for non-existent product ID via GET /api/store/products/:id', async () => {
    const res = await apiRequest(app, 'GET', '/api/store/products/prod_ghost', {}, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.14 should return 404 for non-existent order ID via GET /api/store/orders/:id', async () => {
    const res = await apiRequest(app, 'GET', '/api/store/orders/ord_ghost', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.15 should return 404 for non-existent media file via GET /media-files/:name', async () => {
    const res = await apiRequest(app, 'GET', '/media-files/ghost_file.mp4', {}, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.16 should return 404 for non-existent notification ID on mark read', async () => {
    const res = await apiRequest(app, 'POST', '/api/notifications/notif_ghost/read', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.17 should return 404 for non-existent user ID via GET /api/admin/users/:id', async () => {
    const res = await apiRequest(app, 'GET', '/api/admin/users/usr_ghost', {
      token: ctx.fixtures.users.admin.token,
    }, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.18 should return 404 for non-existent user ID on admin role update', async () => {
    const res = await apiRequest(app, 'PUT', '/api/admin/users/usr_ghost/role', {
      token: ctx.fixtures.users.admin.token,
      body: { role: 'reseller' },
    }, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.19 should return 404 for non-existent user ID on admin ban', async () => {
    const res = await apiRequest(app, 'POST', '/api/admin/users/usr_ghost/ban', {
      token: ctx.fixtures.users.admin.token,
      body: { reason: 'حظر' },
    }, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.20 should return 404 for non-existent user ID on admin unban', async () => {
    const res = await apiRequest(app, 'POST', '/api/admin/users/usr_ghost/unban', {
      token: ctx.fixtures.users.admin.token,
    }, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.21 should return 404 for non-existent ban record ID on appeal resolve', async () => {
    const res = await apiRequest(app, 'PUT', '/api/admin/bans/ban_ghost/resolve', {
      token: ctx.fixtures.users.admin.token,
      body: { action: 'lift' },
    }, ctx);
    expect(res.status).toBe(404);
  });

  it('B4.22 should return 400 when submitting choice not belonging to question', async () => {
    const q1 = ctx.fixtures.questionIds[0];
    const q2 = ctx.fixtures.questionIds[1];
    const q2Choice = await ctx.db.prepare('SELECT id FROM choices WHERE question_id = ?').bind(q2).first('id');

    const res = await apiRequest(app, 'POST', `/api/questions/${q1}/answer`, {
      token: ctx.fixtures.users.student.token,
      body: { choice_id: q2Choice },
    }, ctx);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('لا ينتمي');
  });

  it('B4.23 should return 400 when submitting answer to already finished exam attempt', async () => {
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id, questions } = await startRes.json();
    await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/finish`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    const ansRes = await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/answer`, {
      token: ctx.fixtures.users.student.token,
      body: { question_id: questions[0].id, choice_id: questions[0].choices[0].id },
    }, ctx);

    expect(ansRes.status).toBe(400);
    const data = await ansRes.json();
    expect(data.detail).toContain('إنهاء');
  });

  it('B4.24 should return 400 when finishing an already finished exam attempt', async () => {
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id } = await startRes.json();
    await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/finish`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    const finish2Res = await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/finish`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(finish2Res.status).toBe(400);
  });

  it('B4.25 should reject student from answering another student exam attempt with 403', async () => {
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id, questions } = await startRes.json();

    // Create another student session
    const student2 = await ctx.createSession(ctx.fixtures.users.admin.id, 'Other user');

    const res = await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/answer`, {
      token: student2.token,
      body: { question_id: questions[0].id, choice_id: questions[0].choices[0].id },
    }, ctx);

    expect(res.status).toBe(403);
  });

  it('B4.26 should reject student from finishing another student exam attempt with 403', async () => {
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id } = await startRes.json();

    const student2 = await ctx.createSession(ctx.fixtures.users.admin.id, 'Other user');

    const res = await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/finish`, {
      token: student2.token,
    }, ctx);

    expect(res.status).toBe(403);
  });

  it('B4.27 should reject student from viewing another student order details with 403', async () => {
    const ordRes = await apiRequest(app, 'POST', '/api/store/orders', {
      token: ctx.fixtures.users.student.token,
      body: { items: [{ product_id: ctx.fixtures.productIds.vipCode, qty: 1 }] },
    }, ctx);
    const { id: orderId } = await ordRes.json();

    // Another student tries to view
    await ctx.db.prepare("INSERT INTO users (id, email, full_name, role) VALUES ('usr_other_student', 'other@test.com', 'طالب آخر', 'student')").run();
    const sessOther = await ctx.createSession('usr_other_student', 'Other Student');

    const res = await apiRequest(app, 'GET', `/api/store/orders/${orderId}`, {
      token: sessOther.token,
    }, ctx);

    expect(res.status).toBe(403);
  });

  it('B4.28 should return 400 when attempting to cancel an already cancelled order', async () => {
    const ordRes = await apiRequest(app, 'POST', '/api/store/orders', {
      token: ctx.fixtures.users.student.token,
      body: { items: [{ product_id: ctx.fixtures.productIds.vipCode, qty: 1 }] },
    }, ctx);
    const { id: orderId } = await ordRes.json();

    // Cancel once
    await apiRequest(app, 'POST', `/api/store/orders/${orderId}/cancel`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    // Cancel again
    const cancel2Res = await apiRequest(app, 'POST', `/api/store/orders/${orderId}/cancel`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(cancel2Res.status).toBe(400);
  });

  it('B4.29 should return 400 when uploading an empty 0-byte media file', async () => {
    const res = await apiRequest(app, 'POST', '/api/admin/media/upload', {
      token: ctx.fixtures.users.admin.token,
      headers: { 'X-Filename': 'empty.txt' },
      body: new Uint8Array(0),
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B4.30 should return 413 Payload Too Large when uploading file exceeding 25MB direct-upload limit', async () => {
    // Simulate exceeding limit
    const hugeBuf = new Uint8Array(26 * 1024 * 1024); // 26MB
    const res = await apiRequest(app, 'POST', '/api/admin/media/upload', {
      token: ctx.fixtures.users.admin.token,
      headers: { 'X-Filename': 'huge.iso' },
      body: hugeBuf,
    }, ctx);
    expect(res.status).toBe(413);
  });
});
