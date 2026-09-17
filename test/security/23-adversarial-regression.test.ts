import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, type TestContext } from '../harness/test-context';
import { signJwt } from '../harness/crypto-helpers';
import app from '../../src/index';
import { resetRateLimitStore } from '../../src/middleware/rate-limit';
import { create2faPendingToken } from '../../src/services/jwt';

describe('Stage 23: Adversarial Security Regression Suite', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
    resetRateLimitStore();
  });

  // 1. Anonymous Access
  it('Attack 1: Anonymous access to protected endpoints is rejected with 401', async () => {
    const res = await app.request('/auth/me', { method: 'GET' }, ctx.bindings);
    expect(res.status).toBe(401);
  });

  // 2. Role Escalation
  it('Attack 2: Student cannot access admin endpoints or escalate role', async () => {
    const student = ctx.fixtures.users.student;
    const adminRes = await app.request(
      '/api/admin/overview',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${student.token}` },
      },
      ctx.bindings
    );
    expect(adminRes.status).toBe(403);
  });

  // 3. IDOR
  it('Attack 3: IDOR cross-user attempt access is blocked', async () => {
    const student = ctx.fixtures.users.student;
    const res = await app.request(
      '/api/exams/attempts/attempt_other_user_999',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${student.token}` },
      },
      ctx.bindings
    );
    expect([403, 404]).toContain(res.status);
  });

  // 4. Forged JWT
  it('Attack 4: Forged JWT signed with wrong secret is rejected with 401', async () => {
    const fakeToken = await signJwt(
      { sub: ctx.fixtures.users.student.id, sid: ctx.fixtures.users.student.sessionId, role: 'admin' },
      'wrong-secret-key-that-does-not-match-at-all!!'
    );
    const res = await app.request(
      '/auth/me',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${fakeToken}` },
      },
      ctx.bindings
    );
    expect(res.status).toBe(401);
  });

  // 5. Wrong JWT Type / 2FA Token Misuse
  it('Attack 5: 2FA pending token cannot be used as an access token on protected routes', async () => {
    const pendingToken = await create2faPendingToken(ctx.fixtures.users.student.id, ctx.bindings.JWT_SECRET);
    const res = await app.request(
      '/auth/me',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${pendingToken}` },
      },
      ctx.bindings
    );
    expect(res.status).toBe(401);
  });

  // 6. Expired / Revoked Session
  it('Attack 6: Revoked session is rejected immediately on subsequent requests', async () => {
    const student = ctx.fixtures.users.student;

    // Logout to revoke session
    const logoutRes = await app.request(
      '/auth/logout',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${student.token}` },
      },
      ctx.bindings
    );
    expect(logoutRes.status).toBe(200);

    // Immediate attempt to use the same token
    const res = await app.request(
      '/auth/me',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${student.token}` },
      },
      ctx.bindings
    );
    expect(res.status).toBe(401);
  });

  // 7. Cross-Site Mutation
  it('Attack 7: Cross-site request forgery attempt is blocked by CSRF middleware', async () => {
    const res = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Sec-Fetch-Site': 'cross-site',
        },
        body: JSON.stringify({ email: 'student@nabd.app', password: 'Nabd@2026' }),
      },
      ctx.bindings
    );
    expect(res.status).toBe(403);
  });

  // 8. Oversized Body
  it('Attack 8: Oversized request payload is rejected with 413 Payload Too Large', async () => {
    const hugePayload = JSON.stringify({ email: 'test@example.com', padding: 'A'.repeat(105 * 1024) });
    const res = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: hugePayload,
      },
      ctx.bindings
    );
    expect(res.status).toBe(413);
  });

  // 9. Rate Limiting Abuse
  it('Attack 9: Rapid repeated requests trigger 429 Too Many Requests', async () => {
    let lastStatus = 200;
    for (let i = 0; i < 6; i++) {
      const res = await app.request(
        '/auth/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'cf-connecting-ip': '203.0.113.88',
          },
          body: JSON.stringify({
            email: `user_${i}@example.com`,
            password: 'ValidPassword123!',
            full_name: 'Test Rate Limit',
          }),
        },
        ctx.bindings
      );
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  // 10. Password Reset Replay
  it('Attack 10: Reset password token replay is blocked after first successful use', async () => {
    const rawToken = 'attacker-test-token-12345';
    const { hashResetToken } = await import('../../src/services/crypto');
    const tokenHash = await hashResetToken(rawToken);

    await ctx.db.exec(`
      UPDATE users SET
        reset_token_hash = '${tokenHash}',
        reset_token_expires_at = '${new Date(Date.now() + 3600000).toISOString()}'
      WHERE email = 'student@nabd.app'
    `);

    // First reset succeeds
    const firstRes = await app.request(
      '/auth/reset-password',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: rawToken, new_password: 'NewStrongPassword123!' }),
      },
      ctx.bindings
    );
    expect(firstRes.status).toBe(200);

    // Second replay fails
    const replayRes = await app.request(
      '/auth/reset-password',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: rawToken, new_password: 'AnotherPassword456!' }),
      },
      ctx.bindings
    );
    expect(replayRes.status).toBe(400);
  });

  // 11. OAuth State Tampering
  it('Attack 11: OAuth callback without matching state cookie is rejected', async () => {
    const oauthBindings = {
      ...ctx.bindings,
      GOOGLE_CLIENT_ID: 'mock-google-client-id',
      GOOGLE_CLIENT_SECRET: 'mock-google-client-secret',
      GOOGLE_REDIRECT_URI: 'http://localhost/auth/google/callback',
    };

    const res = await app.request(
      '/auth/google/callback?state=forged_state_nonce&code=test_code',
      {
        method: 'GET',
        headers: { Cookie: 'oauth_state=legitimate_original_nonce' },
      },
      oauthBindings
    );
    expect([400, 403]).toContain(res.status);
  });

  // 12. Path Traversal Upload
  it('Attack 12: Directory traversal in media download route is rejected with 400', async () => {
    const res = await app.request(
      '/media-files/..%2F..%2F..%2Fetc%2Fpasswd',
      { method: 'GET' },
      ctx.bindings
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain('Path Traversal Detected');
  });

  // 13. Exam Clock Tampering
  it('Attack 13: Submitting answers to an expired exam attempt is rejected', async () => {
    const student = ctx.fixtures.users.student;
    const pastDate = new Date(Date.now() - 7200000).toISOString(); // 2 hours ago

    await ctx.db.exec(`
      INSERT INTO exam_attempts (id, user_id, exam_id, started_at, score, total)
      VALUES ('attempt_expired_1', '${student.id}', '${ctx.fixtures.examId}', '${pastDate}', 0, 100);
    `);

    const answerRes = await app.request(
      '/api/exams/attempts/attempt_expired_1/answers',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${student.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ question_id: ctx.fixtures.questionIds[0], selected_option: 0 }),
      },
      ctx.bindings
    );
    expect(answerRes.status).toBe(400);
    const data = await answerRes.json();
    expect(data.detail).toContain('انتهى وقت الامتحان');
  });

  // 14. Admin Bootstrap Exploit
  it('Attack 14: Regular user cannot bootstrap as admin when users exist in DB', async () => {
    const res = await app.request(
      '/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'wannabe-admin@nabd.app',
          password: 'Password123!',
          full_name: 'Privilege Escalation Attacker',
        }),
      },
      ctx.bindings
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.role).toBe('student');
  });
});

