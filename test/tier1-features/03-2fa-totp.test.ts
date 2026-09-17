import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';
import { generateTotpCode } from '../harness/crypto-helpers';

describe('Tier 1: Feature 3 - Two-Factor Authentication (2FA TOTP)', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('3.1 should initiate 2FA setup and return secret, otpauth uri, and qr code', async () => {
    const res = await apiRequest(app, 'POST', '/auth/2fa/setup', {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.secret).toBeDefined();
    expect(data.uri).toBeDefined();
    expect(data.uri).toContain('otpauth://totp/Nabd:');
  });

  it('3.2 should verify valid TOTP code and enable 2FA on account', async () => {
    const setupRes = await apiRequest(app, 'POST', '/auth/2fa/setup', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { secret } = await setupRes.json();
    const validCode = generateTotpCode(secret);

    const verifyRes = await apiRequest(app, 'POST', '/auth/2fa/verify', {
      token: ctx.fixtures.users.student.token,
      body: { code: validCode },
    }, ctx);

    expect(verifyRes.status).toBe(200);

    const meRes = await apiRequest(app, 'GET', '/auth/me', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const meData = await meRes.json();
    expect(meData.totp_enabled).toBe(true);
  });

  it('3.3 should challenge with requires_2fa on login when 2FA is enabled', async () => {
    // Enable 2FA
    const setupRes = await apiRequest(app, 'POST', '/auth/2fa/setup', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { secret } = await setupRes.json();
    const validCode = generateTotpCode(secret);
    await apiRequest(app, 'POST', '/auth/2fa/verify', {
      token: ctx.fixtures.users.student.token,
      body: { code: validCode },
    }, ctx);

    // Attempt login
    const loginRes = await apiRequest(app, 'POST', '/auth/login', {
      body: {
        email: 'student@nabd.app',
        password: 'Nabd@2026',
      },
    }, ctx);

    expect(loginRes.status).toBe(200);
    const loginData = await loginRes.json();
    expect(loginData.requires_2fa).toBe(true);
    expect(loginData.pending_token).toBeDefined();
    expect(loginData.access_token).toBeUndefined();
  });

  it('3.4 should complete 2FA login with pending_token and valid TOTP code', async () => {
    // Enable 2FA
    const setupRes = await apiRequest(app, 'POST', '/auth/2fa/setup', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { secret } = await setupRes.json();
    const validCode = generateTotpCode(secret);
    await apiRequest(app, 'POST', '/auth/2fa/verify', {
      token: ctx.fixtures.users.student.token,
      body: { code: validCode },
    }, ctx);

    // Login step 1
    const loginRes = await apiRequest(app, 'POST', '/auth/login', {
      body: {
        email: 'student@nabd.app',
        password: 'Nabd@2026',
      },
    }, ctx);
    const { pending_token } = await loginRes.json();

    // Login step 2
    const currentCode = generateTotpCode(secret);
    const faLoginRes = await apiRequest(app, 'POST', '/auth/2fa/login', {
      body: {
        pending_token,
        code: currentCode,
      },
    }, ctx);

    expect(faLoginRes.status).toBe(200);
    const faData = await faLoginRes.json();
    expect(faData.access_token).toBeDefined();
    expect(faData.token_type).toBe('bearer');
  });

  it('3.5 should disable 2FA with valid TOTP code', async () => {
    // Setup and enable
    const setupRes = await apiRequest(app, 'POST', '/auth/2fa/setup', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { secret } = await setupRes.json();
    const code = generateTotpCode(secret);
    await apiRequest(app, 'POST', '/auth/2fa/verify', {
      token: ctx.fixtures.users.student.token,
      body: { code },
    }, ctx);

    // Disable
    const disableCode = generateTotpCode(secret);
    const disableRes = await apiRequest(app, 'POST', '/auth/2fa/disable', {
      token: ctx.fixtures.users.student.token,
      body: { code: disableCode },
    }, ctx);

    expect(disableRes.status).toBe(200);

    // Verify disabled
    const meRes = await apiRequest(app, 'GET', '/auth/me', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const meData = await meRes.json();
    expect(meData.totp_enabled).toBe(false);
  });

  it('3.6 should allow standard login without 2FA challenge after 2FA is disabled', async () => {
    // Setup and enable
    const setupRes = await apiRequest(app, 'POST', '/auth/2fa/setup', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { secret } = await setupRes.json();
    const code = generateTotpCode(secret);
    await apiRequest(app, 'POST', '/auth/2fa/verify', {
      token: ctx.fixtures.users.student.token,
      body: { code },
    }, ctx);

    // Disable
    await apiRequest(app, 'POST', '/auth/2fa/disable', {
      token: ctx.fixtures.users.student.token,
      body: { code: generateTotpCode(secret) },
    }, ctx);

    // Login should now yield access_token directly
    const loginRes = await apiRequest(app, 'POST', '/auth/login', {
      body: {
        email: 'student@nabd.app',
        password: 'Nabd@2026',
      },
    }, ctx);

    expect(loginRes.status).toBe(200);
    const data = await loginRes.json();
    expect(data.access_token).toBeDefined();
    expect(data.requires_2fa).toBeUndefined();
  });
});
