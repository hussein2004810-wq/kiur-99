import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, type TestContext } from '../harness/test-context';
import { apiRequest } from '../harness/app';
import { hashResetToken } from '../../src/services/crypto';
import app from '../../src/index';

describe('Stage 3: Session Hardening Specification', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  it('security.auth.session.atomic-replacement: starting a new session atomically deactivates previous sessions', async () => {
    const student = ctx.fixtures.users.student;

    // Login #1
    const login1 = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: student.email, password: 'Nabd@2026' },
    }, ctx);
    expect(login1.status).toBe(200);
    const token1 = (await login1.json()).access_token;

    // First session should be active
    const check1 = await apiRequest(app, 'GET', '/auth/me', { token: token1 }, ctx);
    expect(check1.status).toBe(200);

    // Login #2 (new device / session)
    const login2 = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: student.email, password: 'Nabd@2026' },
    }, ctx);
    expect(login2.status).toBe(200);
    const token2 = (await login2.json()).access_token;

    // New session is active
    const check2 = await apiRequest(app, 'GET', '/auth/me', { token: token2 }, ctx);
    expect(check2.status).toBe(200);

    // Old session MUST BE DEACTIVATED (returns 401)
    const checkOld = await apiRequest(app, 'GET', '/auth/me', { token: token1 }, ctx);
    expect(checkOld.status).toBe(401);
    expect((await checkOld.json()).detail).toContain('تم تسجيل الدخول من جهاز آخر');
  });

  it('security.auth.session.logout-revocation: logout deactivates session server-side and clears cookie', async () => {
    const student = ctx.fixtures.users.student;

    const loginRes = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: student.email, password: 'Nabd@2026' },
    }, ctx);
    expect(loginRes.status).toBe(200);
    const token = (await loginRes.json()).access_token;

    const logoutRes = await apiRequest(app, 'POST', '/auth/logout', { token }, ctx);
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.headers.get('set-cookie')).toContain('Max-Age=0');

    // Trying to use token after logout must fail
    const meRes = await apiRequest(app, 'GET', '/auth/me', { token }, ctx);
    expect(meRes.status).toBe(401);
  });

  it('security.auth.session.password-reset-revocation: password reset revokes active session', async () => {
    const student = ctx.fixtures.users.student;
    const sess = await ctx.createSession(student.id, 'Device 1');

    expect((await apiRequest(app, 'GET', '/auth/me', { token: sess.token }, ctx)).status).toBe(200);

    // Configure valid reset token in database
    const rawToken = 'test-reset-token-1234567890abcdef';
    const tokenHash = await hashResetToken(rawToken);
    const futureExpiry = new Date(Date.now() + 3600 * 1000).toISOString();

    await ctx.db.exec(`
      UPDATE users
      SET reset_token_hash = '${tokenHash}', reset_token_expires_at = '${futureExpiry}'
      WHERE id = '${student.id}';
    `);

    // Reset password
    const resetRes = await apiRequest(app, 'POST', '/auth/reset-password', {
      body: { token: rawToken, new_password: 'NewStrongPassword@2026' },
    }, ctx);
    expect(resetRes.status).toBe(200);

    // Prior session MUST BE REVOKED by password reset
    const checkRes = await apiRequest(app, 'GET', '/auth/me', { token: sess.token }, ctx);
    expect(checkRes.status).toBe(401);
  });
});

