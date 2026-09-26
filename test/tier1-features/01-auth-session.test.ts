import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';

describe('Tier 1: Feature 1 - Auth & Session Management', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('1.1 should register a new student without issuing a session before email verification', async () => {
    const res = await apiRequest(app, 'POST', '/auth/register', {
      body: {
        email: 'newstudent@test.com',
        full_name: 'أحمد محمود',
        password: 'Password123',
        university_id: ctx.fixtures.universityId,
        stage_id: ctx.fixtures.stageId,
        section_id: ctx.fixtures.sectionId,
      },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.requires_email_verification).toBe(true);
    expect(data.access_token).toBeUndefined();
    expect(data.role).toBe('student');
  });

  it('1.2 should not set a session cookie on registration', async () => {
    const res = await apiRequest(app, 'POST', '/auth/register', {
      body: {
        email: 'cookietest@test.com',
        full_name: 'طالب كوكيز',
        password: 'Password123',
      },
    }, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    const sessions = await ctx.db.prepare("SELECT COUNT(*) AS count FROM user_sessions WHERE user_id = (SELECT id FROM users WHERE email = 'cookietest@test.com')").first('count');
    expect(sessions).toBe(0);
  });

  it('1.3 should login with valid email and password', async () => {
    const res = await apiRequest(app, 'POST', '/auth/login', {
      body: {
        email: ctx.fixtures.users.student.email,
        password: 'Nabd@2026',
      },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.access_token).toBeDefined();
    expect(data.token_type).toBe('bearer');
    expect(data.user.email).toBe(ctx.fixtures.users.student.email);
  });

  it('1.4 should set nabd_session cookie on login', async () => {
    const res = await apiRequest(app, 'POST', '/auth/login', {
      body: {
        email: ctx.fixtures.users.student.email,
        password: 'Nabd@2026',
      },
    }, ctx);

    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('nabd_session=');
  });

  it('1.5 should accept custom device_label during login', async () => {
    const res = await apiRequest(app, 'POST', '/auth/login', {
      body: {
        email: ctx.fixtures.users.student.email,
        password: 'Nabd@2026',
        device_label: 'MacBook Pro M3',
      },
    }, ctx);

    expect(res.status).toBe(200);
    const session = await ctx.db.prepare("SELECT device_label FROM user_sessions WHERE user_id = ? AND is_active = 1")
      .bind(ctx.fixtures.users.student.id).first('device_label');
    expect(session).toBe('MacBook Pro M3');
  });

  it('1.6 should restore session via cookie and return new access token', async () => {
    // Create new session
    const sess = await ctx.createSession(ctx.fixtures.users.student.id, 'iPad Air');
    const res = await apiRequest(app, 'POST', '/auth/session/restore', {
      cookie: `nabd_session=${sess.id}`,
      headers: { Origin: 'http://localhost' },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.access_token).toBeDefined();
    expect(data.token_type).toBe('bearer');
    expect(data.user.id).toBe(ctx.fixtures.users.student.id);
  });

  it('1.7 should restore session via request body session_id fallback', async () => {
    const sess = await ctx.createSession(ctx.fixtures.users.student.id, 'Windows Laptop');
    const res = await apiRequest(app, 'POST', '/auth/session/restore', {
      body: { session_id: sess.id },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.access_token).toBeDefined();
  });

  it('1.8 should logout and deactivate active session', async () => {
    const sess = await ctx.createSession(ctx.fixtures.users.student.id, 'Logout Test Device');
    const res = await apiRequest(app, 'POST', '/auth/logout', {
      token: sess.token,
    }, ctx);

    expect(res.status).toBe(200);
    const dbSession = await ctx.db.prepare('SELECT is_active FROM user_sessions WHERE id = ?').bind(sess.id).first('is_active');
    expect(dbSession).toBe(0);
  });

  it('1.9 should clear nabd_session cookie on logout', async () => {
    const sess = await ctx.createSession(ctx.fixtures.users.student.id, 'Logout Cookie Device');
    const res = await apiRequest(app, 'POST', '/auth/logout', {
      token: sess.token,
    }, ctx);

    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('Max-Age=0');
  });

  it('1.10 should login case-insensitively with email in uppercase', async () => {
    const res = await apiRequest(app, 'POST', '/auth/login', {
      body: {
        email: ctx.fixtures.users.student.email.toUpperCase(),
        password: 'Nabd@2026',
      },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.access_token).toBeDefined();
  });
});
