import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, type TestContext } from '../harness/test-context';
import app from '../../src/index';
import {
  getAuditLogs,
  clearAuditLogs,
  redactSensitiveData,
} from '../../src/services/audit';
import { resetRateLimitStore } from '../../src/middleware/rate-limit';

describe('Stage 19: Logging and Audit Trail (SEC-LOG-001, SEC-LOG-002)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
    clearAuditLogs();
    resetRateLimitStore();
  });

  it('SEC-LOG-002: redactSensitiveData scrubs passwords, tokens, secrets, cookies, totp', () => {
    const rawData = {
      email: 'student@kiur.app',
      password: 'SuperSecretPassword123!',
      access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy',
      totp_secret: 'JBSWY3DPEHPK3PXP',
      nested: {
        authorization: 'Bearer secret-bearer-token',
        cookie: 'kiur_session=secret-cookie-val',
        reset_token: 'raw-token-value',
        normalField: 'safe-value',
      },
      list: [
        { api_key: 'my-secret-key', name: 'safe-item' },
      ],
    };

    const redacted = redactSensitiveData(rawData) as any;

    expect(redacted.email).toBe('student@kiur.app');
    expect(redacted.password).toBe('[REDACTED]');
    expect(redacted.access_token).toBe('[REDACTED]');
    expect(redacted.totp_secret).toBe('[REDACTED]');
    expect(redacted.nested.authorization).toBe('[REDACTED]');
    expect(redacted.nested.cookie).toBe('[REDACTED]');
    expect(redacted.nested.reset_token).toBe('[REDACTED]');
    expect(redacted.nested.normalField).toBe('safe-value');
    expect(redacted.list[0].api_key).toBe('[REDACTED]');
    expect(redacted.list[0].name).toBe('safe-item');
  });

  it('SEC-LOG-001: records auth failures and successes without credential leaks', async () => {
    // 1. Failed login
    const failRes = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'student@nabd.app', password: 'WrongPassword999' }),
      },
      ctx.bindings
    );
    expect(failRes.status).toBe(401);

    const logsAfterFail = getAuditLogs();
    const failEvent = logsAfterFail.find((l) => l.event === 'AUTH_LOGIN_FAILED');
    expect(failEvent).toBeDefined();
    expect(failEvent?.status).toBe('FAILURE');
    // Ensure no password in logs
    expect(JSON.stringify(failEvent)).not.toContain('WrongPassword999');

    // 2. Successful login
    const succRes = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'student@nabd.app', password: 'Nabd@2026' }),
      },
      ctx.bindings
    );
    expect(succRes.status).toBe(200);

    const succEvent = getAuditLogs().find((l) => l.event === 'AUTH_LOGIN_SUCCESS');
    expect(succEvent).toBeDefined();
    expect(succEvent?.status).toBe('SUCCESS');
    expect(JSON.stringify(succEvent)).not.toContain('Nabd@2026');
  });

  it('SEC-LOG-001: records CSRF denial audit event', async () => {
    const crossSiteRes = await app.request(
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
    expect(crossSiteRes.status).toBe(403);

    const csrfLog = getAuditLogs().find((l) => l.event === 'SECURITY_CSRF_DENIAL');
    expect(csrfLog).toBeDefined();
    expect(csrfLog?.status).toBe('DENIED');
  });

  it('SEC-LOG-001: records rate limiting denial audit event', async () => {
    // Trigger forgot password 4 times (limit is 3)
    for (let i = 0; i < 4; i++) {
      await app.request(
        '/auth/forgot-password',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'cf-connecting-ip': '198.51.100.42',
          },
          body: JSON.stringify({ email: 'student@nabd.app' }),
        },
        ctx.bindings
      );
    }

    const rlLog = getAuditLogs().find((l) => l.event === 'SECURITY_RATE_LIMITED');
    expect(rlLog).toBeDefined();
    expect(rlLog?.status).toBe('DENIED');
    expect(rlLog?.ip).toBe('198.51.100.42');
  });
});
