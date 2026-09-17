import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';

describe('Tier 1: Feature 2 - Account & Profile Management', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('2.1 should retrieve current user profile details via GET /auth/me', async () => {
    const res = await apiRequest(app, 'GET', '/auth/me', {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(ctx.fixtures.users.student.id);
    expect(data.email).toBe('student@nabd.app');
    expect(data.role).toBe('student');
    expect(data.is_banned).toBe(false);
  });

  it('2.2 should update user full_name and phone via PUT /auth/me', async () => {
    const res = await apiRequest(app, 'PUT', '/auth/me', {
      token: ctx.fixtures.users.student.token,
      body: {
        full_name: 'علي محمد عبد الله',
        phone: '07701234567',
      },
    }, ctx);

    expect(res.status).toBe(200);
    const meRes = await apiRequest(app, 'GET', '/auth/me', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const meData = await meRes.json();
    expect(meData.full_name).toBe('علي محمد عبد الله');
    expect(meData.phone).toBe('07701234567');
  });

  it('2.3 should update user theme and language settings via PUT /auth/me', async () => {
    const res = await apiRequest(app, 'PUT', '/auth/me', {
      token: ctx.fixtures.users.student.token,
      body: {
        theme: 'dark',
        language: 'en',
      },
    }, ctx);

    expect(res.status).toBe(200);
    const meRes = await apiRequest(app, 'GET', '/auth/me', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const meData = await meRes.json();
    expect(meData.theme).toBe('dark');
    expect(meData.language).toBe('en');
  });

  it('2.4 should change password with valid current password', async () => {
    const res = await apiRequest(app, 'POST', '/auth/change-password', {
      token: ctx.fixtures.users.student.token,
      body: {
        old_password: 'Nabd@2026',
        new_password: 'NewSecurePassword2026!',
      },
    }, ctx);

    expect(res.status).toBe(200);

    // Login with new password should succeed
    const loginRes = await apiRequest(app, 'POST', '/auth/login', {
      body: {
        email: 'student@nabd.app',
        password: 'NewSecurePassword2026!',
      },
    }, ctx);
    expect(loginRes.status).toBe(200);
  });

  it('2.5 should request password reset token via POST /auth/forgot-password', async () => {
    const res = await apiRequest(app, 'POST', '/auth/forgot-password', {
      body: {
        email: 'student@nabd.app',
      },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toBeDefined();
  });

  it('2.6 should reset password using valid reset token via POST /auth/reset-password', async () => {
    // Generate token via forgot-password
    const forgotRes = await apiRequest(app, 'POST', '/auth/forgot-password', {
      body: { email: 'student@nabd.app' },
    }, ctx);
    const forgotData = await forgotRes.json();
    const token = forgotData.debug_token;

    const resetRes = await apiRequest(app, 'POST', '/auth/reset-password', {
      body: {
        token,
        new_password: 'BrandNewPassword2026!',
      },
    }, ctx);

    expect(resetRes.status).toBe(200);

    // Verify login with new password
    const loginRes = await apiRequest(app, 'POST', '/auth/login', {
      body: {
        email: 'student@nabd.app',
        password: 'BrandNewPassword2026!',
      },
    }, ctx);
    expect(loginRes.status).toBe(200);
  });

  it('2.7 should return student study statistics via GET /auth/stats', async () => {
    const res = await apiRequest(app, 'GET', '/auth/stats', {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.answered_count).toBeDefined();
    expect(data.correct_count).toBeDefined();
    expect(data.accuracy).toBeDefined();
  });

  it('2.8 should update user photo_url and caption via PUT /auth/me', async () => {
    const res = await apiRequest(app, 'PUT', '/auth/me', {
      token: ctx.fixtures.users.student.token,
      body: {
        photo_url: 'https://storage.nabd.app/avatar.png',
        caption: 'طالب طب متميز',
      },
    }, ctx);

    expect(res.status).toBe(200);
    const meRes = await apiRequest(app, 'GET', '/auth/me', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const meData = await meRes.json();
    expect(meData.photo_url).toBe('https://storage.nabd.app/avatar.png');
    expect(meData.caption).toBe('طالب طب متميز');
  });
});
