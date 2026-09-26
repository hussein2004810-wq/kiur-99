import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';
import { signJwt } from '../harness/crypto-helpers';

describe('Tier 2: Boundary 2 - Authentication, Tokens & Security Boundaries', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('B2.1 should reject duplicate email registration with 400 and friendly Arabic detail', async () => {
    const res = await apiRequest(app, 'POST', '/auth/register', {
      body: {
        email: ctx.fixtures.users.student.email,
        full_name: 'طالب مكرر',
        password: 'Password123',
      },
    }, ctx);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('مسجل بالفعل');
  });

  it('B2.2 should reject duplicate registration case-insensitively', async () => {
    const res = await apiRequest(app, 'POST', '/auth/register', {
      body: {
        email: ctx.fixtures.users.student.email.toUpperCase(),
        full_name: 'طالب مكرر حروف كبيرة',
        password: 'Password123',
      },
    }, ctx);

    expect(res.status).toBe(400);
  });

  it('B2.3 should return 401 when logging in with incorrect password', async () => {
    const res = await apiRequest(app, 'POST', '/auth/login', {
      body: {
        email: ctx.fixtures.users.student.email,
        password: 'WrongPassword!',
      },
    }, ctx);

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.detail).toContain('غير صحيحة');
  });

  it('B2.4 should return 401 when logging in with non-existent email', async () => {
    const res = await apiRequest(app, 'POST', '/auth/login', {
      body: {
        email: 'ghost_user@nabd.app',
        password: 'Password123',
      },
    }, ctx);

    expect(res.status).toBe(401);
  });

  it('B2.5 should lock account and return 429 after 5 consecutive failed login attempts', async () => {
    for (let i = 0; i < 4; i++) {
      const res = await apiRequest(app, 'POST', '/auth/login', {
        body: { email: ctx.fixtures.users.student.email, password: 'Bad' },
      }, ctx);
      expect(res.status).toBe(401);
    }

    // 5th attempt triggers lockout
    const lockRes = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: ctx.fixtures.users.student.email, password: 'Bad' },
    }, ctx);
    expect(lockRes.status).toBe(429);
    const data = await lockRes.json();
    expect(data.detail).toContain('قفل الحساب');
  });

  it('B2.6 should reject login attempts during lockout period with 429 even with correct password', async () => {
    // Set lockout in DB
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await ctx.db.prepare('UPDATE users SET locked_until = ? WHERE id = ?')
      .bind(future, ctx.fixtures.users.student.id).run();

    const res = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: ctx.fixtures.users.student.email, password: 'Nabd@2026' },
    }, ctx);
    expect(res.status).toBe(429);
  });

  it('B2.7 should return 401 on protected endpoint when Authorization header is missing', async () => {
    const res = await apiRequest(app, 'GET', '/auth/me', {}, ctx);
    expect(res.status).toBe(401);
  });

  it('B2.8 should return 401 when Authorization header is missing "Bearer " prefix', async () => {
    const res = await apiRequest(app, 'GET', '/auth/me', {
      headers: { Authorization: ctx.fixtures.users.student.token },
    }, ctx);
    expect(res.status).toBe(401);
  });

  it('B2.9 should return 401 when JWT token is expired', async () => {
    const expiredToken = signJwt({ sub: ctx.fixtures.users.student.id, role: 'student' }, ctx.bindings.JWT_SECRET, -10);
    const res = await apiRequest(app, 'GET', '/auth/me', { token: expiredToken }, ctx);
    expect(res.status).toBe(401);
  });

  it('B2.10 should return 401 when JWT is signed with a different secret', async () => {
    const forgedToken = signJwt({ sub: ctx.fixtures.users.student.id, role: 'student' }, 'completely-wrong-secret-key-1234');
    const res = await apiRequest(app, 'GET', '/auth/me', { token: forgedToken }, ctx);
    expect(res.status).toBe(401);
  });

  it('B2.11 should return 401 on malformed non-JWT string', async () => {
    const res = await apiRequest(app, 'GET', '/auth/me', { token: 'random.garbage.token' }, ctx);
    expect(res.status).toBe(401);
  });

  it('B2.12 should return 401 when JWT sub user does not exist in database', async () => {
    const phantomToken = signJwt({ sub: 'usr_phantom_999', role: 'student' }, ctx.bindings.JWT_SECRET);
    const res = await apiRequest(app, 'GET', '/auth/me', { token: phantomToken }, ctx);
    expect(res.status).toBe(401);
  });

  it('B2.13 should return 400 on change-password with wrong current password', async () => {
    const res = await apiRequest(app, 'POST', '/auth/change-password', {
      token: ctx.fixtures.users.student.token,
      body: { old_password: 'WrongCurrentPassword', new_password: 'ValidNewPassword123' },
    }, ctx);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('الحالية غير صحيحة');
  });

  it('B2.14 should return 401 on session restore without session cookie', async () => {
    const res = await apiRequest(app, 'POST', '/auth/session/restore', {}, ctx);
    expect(res.status).toBe(401);
  });

  it('B2.15 should return 401 on session restore with non-existent session ID', async () => {
    const res = await apiRequest(app, 'POST', '/auth/session/restore', {
      cookie: 'nabd_session=ses_non_existent',
      headers: { Origin: 'http://localhost' },
    }, ctx);
    expect(res.status).toBe(401);
  });

  it('B2.16 should return 401 on session restore with deactivated session', async () => {
    const sess = await ctx.createSession(ctx.fixtures.users.student.id, 'Deactivated Phone');
    await ctx.db.prepare('UPDATE user_sessions SET is_active = 0 WHERE id = ?').bind(sess.id).run();

    const res = await apiRequest(app, 'POST', '/auth/session/restore', {
      cookie: `nabd_session=${sess.id}`,
      headers: { Origin: 'http://localhost' },
    }, ctx);
    expect(res.status).toBe(401);
  });

  it('B2.17 should return 400 on 2FA verify with wrong TOTP code', async () => {
    await apiRequest(app, 'POST', '/auth/2fa/setup', {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    const res = await apiRequest(app, 'POST', '/auth/2fa/verify', {
      token: ctx.fixtures.users.student.token,
      body: { code: '000000' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B2.18 should return 400 on 2FA login with incorrect TOTP code', async () => {
    const pendingToken = signJwt({ pending_2fa_user: ctx.fixtures.users.student.id }, ctx.bindings.JWT_SECRET, 5);
    const res = await apiRequest(app, 'POST', '/auth/2fa/login', {
      body: { pending_token: pendingToken, code: '999999' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B2.19 should return 401 on 2FA login with expired pending token', async () => {
    const expiredPending = signJwt({ pending_2fa_user: ctx.fixtures.users.student.id }, ctx.bindings.JWT_SECRET, -5);
    const res = await apiRequest(app, 'POST', '/auth/2fa/login', {
      body: { pending_token: expiredPending, code: '123456' },
    }, ctx);
    expect(res.status).toBe(401);
  });

  it('B2.20 should throttle password reset requests with 429 when called twice within 120 seconds', async () => {
    await apiRequest(app, 'POST', '/auth/forgot-password', {
      body: { email: 'student@nabd.app' },
    }, ctx);

    // Immediate 2nd request
    const throttleRes = await apiRequest(app, 'POST', '/auth/forgot-password', {
      body: { email: 'student@nabd.app' },
    }, ctx);
    expect(throttleRes.status).toBe(429);
  });

  it('B2.21 should return 400 on reset-password with invalid token', async () => {
    const res = await apiRequest(app, 'POST', '/auth/reset-password', {
      body: { token: 'invalid_reset_token', new_password: 'ValidPassword123' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B2.22 should return 400 on reset-password with expired token', async () => {
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    await ctx.db.prepare("UPDATE users SET reset_token_hash = 'somehash', reset_token_expires_at = ? WHERE id = ?")
      .bind(past, ctx.fixtures.users.student.id).run();

    const res = await apiRequest(app, 'POST', '/auth/reset-password', {
      body: { token: 'somehash', new_password: 'ValidPassword123' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B2.23 should return 400 when attempting to redeem an invalid non-existent code', async () => {
    const res = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: ctx.fixtures.users.student.token,
      body: { code: 'NBD-INVALID-CODE-XYZ' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B2.24 should lock redemption and return 429 after 5 failed activation code attempts', async () => {
    for (let i = 0; i < 4; i++) {
      await apiRequest(app, 'POST', '/api/activation/redeem', {
        token: ctx.fixtures.users.student.token,
        body: { code: `WRONG-${i}` },
      }, ctx);
    }

    const lockRes = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: ctx.fixtures.users.student.token,
      body: { code: 'WRONG-5' },
    }, ctx);
    expect(lockRes.status).toBe(429);
  });

  it('B2.25 should return 429 during code redemption lockout even with valid code', async () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await ctx.db.prepare('UPDATE users SET redeem_locked_until = ? WHERE id = ?')
      .bind(future, ctx.fixtures.users.student.id).run();

    const res = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: ctx.fixtures.users.student.token,
      body: { code: ctx.fixtures.activationCodes.vipIdle },
    }, ctx);
    expect(res.status).toBe(429);
  });

  it('B2.26 should return 400 when attempting to redeem an already active code', async () => {
    // Redeem once
    await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: ctx.fixtures.users.student.token,
      body: { code: ctx.fixtures.activationCodes.vipIdle },
    }, ctx);

    // Redeem again
    const res = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: ctx.fixtures.users.student.token,
      body: { code: ctx.fixtures.activationCodes.vipIdle },
    }, ctx);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('مستخدم بالفعل');
  });

  it('B2.27 should return 400 when attempting to redeem an expired code', async () => {
    await ctx.db.prepare("INSERT INTO activation_codes (id, code, status) VALUES ('act_exp', 'NBD-EXPIRED-CODE', 'expired')").run();

    const res = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: ctx.fixtures.users.student.token,
      body: { code: 'NBD-EXPIRED-CODE' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B2.28 should return 400 on ban appeal with empty message', async () => {
    const res = await apiRequest(app, 'POST', '/api/bans/appeal', {
      token: ctx.fixtures.users.bannedStudent.token,
      body: { appeal_message: '' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B2.29 should return 400 when unbanned student tries to submit ban appeal', async () => {
    const res = await apiRequest(app, 'POST', '/api/bans/appeal', {
      token: ctx.fixtures.users.student.token,
      body: { appeal_message: 'لست محظوراً ولكن أرسل' },
    }, ctx);
    expect(res.status).toBe(400);
  });

  it('B2.30 should reject requests with 401 if active session was invalidated by new login', async () => {
    const sess1 = await ctx.createSession(ctx.fixtures.users.student.id, 'Device 1');

    // Login on Device 2 invalidates Device 1
    await ctx.createSession(ctx.fixtures.users.student.id, 'Device 2');

    // Request with Device 1 token
    const res = await apiRequest(app, 'GET', '/auth/me', { token: sess1.token }, ctx);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.detail).toContain('جهاز آخر');
  });
});
