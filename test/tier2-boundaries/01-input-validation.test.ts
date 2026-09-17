import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';

describe('Tier 2: Boundary 1 - Input Validation & Malformed Payloads', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('B1.1 should return 400 on register with empty body', async () => {
    const res = await apiRequest(app, 'POST', '/auth/register', { body: {} }, ctx);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toBeDefined();
  });

  it('B1.2 should return 400 on register with missing email', async () => {
    const res = await apiRequest(app, 'POST', '/auth/register', {
      body: { full_name: 'علي', password: 'Password123' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.3 should return 400 on register with missing full_name', async () => {
    const res = await apiRequest(app, 'POST', '/auth/register', {
      body: { email: 'val1@test.com', password: 'Password123' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.4 should return 400 on register with password shorter than 6 characters', async () => {
    const res = await apiRequest(app, 'POST', '/auth/register', {
      body: { email: 'val2@test.com', full_name: 'علي', password: '123' },
    }, ctx);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('6');
  });

  it('B1.5 should return 400 on register with malformed email missing @', async () => {
    const res = await apiRequest(app, 'POST', '/auth/register', {
      body: { email: 'invalidemail.com', full_name: 'علي', password: 'Password123' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.6 should return 400 on register with malformed email missing domain dot', async () => {
    const res = await apiRequest(app, 'POST', '/auth/register', {
      body: { email: 'user@nodomain', full_name: 'علي', password: 'Password123' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.7 should return 400 on login with empty body', async () => {
    const res = await apiRequest(app, 'POST', '/auth/login', { body: {} }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.8 should return 400 on login with missing email', async () => {
    const res = await apiRequest(app, 'POST', '/auth/login', {
      body: { password: 'Password123' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.9 should return 400 on login with missing password', async () => {
    const res = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: 'student@nabd.app' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.10 should return 400 on change-password with empty body', async () => {
    const res = await apiRequest(app, 'POST', '/auth/change-password', {
      token: ctx.fixtures.users.student.token,
      body: {},
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.11 should return 400 on change-password with missing old_password', async () => {
    const res = await apiRequest(app, 'POST', '/auth/change-password', {
      token: ctx.fixtures.users.student.token,
      body: { new_password: 'NewPassword123' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.12 should return 400 on change-password with short new_password', async () => {
    const res = await apiRequest(app, 'POST', '/auth/change-password', {
      token: ctx.fixtures.users.student.token,
      body: { old_password: 'Nabd@2026', new_password: '123' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.13 should return 400 on forgot-password with empty body', async () => {
    const res = await apiRequest(app, 'POST', '/auth/forgot-password', { body: {} }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.14 should return 400 on reset-password with missing token', async () => {
    const res = await apiRequest(app, 'POST', '/auth/reset-password', {
      body: { new_password: 'NewPassword123' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.15 should return 400 on reset-password with short new_password', async () => {
    const res = await apiRequest(app, 'POST', '/auth/reset-password', {
      body: { token: 'sample-token', new_password: '12' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.16 should return 400 on 2FA verify with missing code', async () => {
    const res = await apiRequest(app, 'POST', '/auth/2fa/verify', {
      token: ctx.fixtures.users.student.token,
      body: {},
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.17 should return 400 on 2FA login with missing pending_token', async () => {
    const res = await apiRequest(app, 'POST', '/auth/2fa/login', {
      body: { code: '123456' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.18 should return 400 on 2FA disable with missing code', async () => {
    const res = await apiRequest(app, 'POST', '/auth/2fa/disable', {
      token: ctx.fixtures.users.student.token,
      body: {},
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.19 should return 400 on question answer submission with missing choice_id', async () => {
    const qId = ctx.fixtures.questionIds[0];
    const res = await apiRequest(app, 'POST', `/api/questions/${qId}/answer`, {
      token: ctx.fixtures.users.student.token,
      body: {},
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.20 should return 400 on exam attempt answer with missing question_id', async () => {
    const res = await apiRequest(app, 'POST', '/api/exams/attempts/att_123/answer', {
      token: ctx.fixtures.users.student.token,
      body: { choice_id: 'cho_1' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.21 should return 400 on add skill with empty text', async () => {
    const res = await apiRequest(app, 'POST', '/api/students/skills', {
      token: ctx.fixtures.users.student.token,
      body: { text: '' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.22 should return 400 on add skill with whitespace-only text', async () => {
    const res = await apiRequest(app, 'POST', '/api/students/skills', {
      token: ctx.fixtures.users.student.token,
      body: { text: '    ' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.23 should return 400 on study-tracker with missing duration_minutes', async () => {
    const res = await apiRequest(app, 'POST', '/api/students/study-tracker', {
      token: ctx.fixtures.users.student.token,
      body: {},
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.24 should return 400 on lecture-progress with missing lecture_id', async () => {
    const res = await apiRequest(app, 'POST', '/api/students/lecture-progress', {
      token: ctx.fixtures.users.student.token,
      body: {},
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.25 should return 400 on recent-views with missing content_type or content_id', async () => {
    const res = await apiRequest(app, 'POST', '/api/recent-views', {
      token: ctx.fixtures.users.student.token,
      body: { content_type: 'lecture' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.26 should return 400 on booklet create with missing title', async () => {
    const res = await apiRequest(app, 'POST', '/api/professors/booklets', {
      token: ctx.fixtures.users.professor.token,
      body: { pages: 10 },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.27 should return 400 on question create with less than 2 choices', async () => {
    const res = await apiRequest(app, 'POST', '/api/professors/questions', {
      token: ctx.fixtures.users.professor.token,
      body: {
        text: 'سؤال بخيار واحد فقط',
        choices: [{ text: 'خيار وحيد', is_correct: true }],
      },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.28 should return 400 on question create with no correct choice', async () => {
    const res = await apiRequest(app, 'POST', '/api/professors/questions', {
      token: ctx.fixtures.users.professor.token,
      body: {
        text: 'سؤال بدون إجابة صحيحة',
        choices: [
          { text: 'خيار 1', is_correct: false },
          { text: 'خيار 2', is_correct: false },
        ],
      },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.29 should return 400 on order creation with empty items array', async () => {
    const res = await apiRequest(app, 'POST', '/api/store/orders', {
      token: ctx.fixtures.users.student.token,
      body: { items: [] },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B1.30 should return 400 on activation code redeem with empty string code', async () => {
    const res = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: ctx.fixtures.users.student.token,
      body: { code: '   ' },
    }, ctx);
    expect(res.status).toBe(400);
  });
});
