import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { apiRequest } from '../harness/app';
import mainApp from '../../src/index';
import { redactSensitiveData } from '../../src/services/audit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Phase D Security & Operational Hardening: Dependencies, Rate Limiting & Audit Trail', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = mainApp;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('D.1: Supply Chain Hardening — xlsx is removed from production dependencies', () => {
    const pkgPath = join(process.cwd(), 'package.json');
    const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf8'));
    expect(pkgJson.dependencies['xlsx']).toBeUndefined();
  });

  it('D.2: Deep Audit Redaction — protects passwords, tokens, secrets, and hashes from logs', () => {
    const sensitivePayload = {
      user_id: 'usr_123',
      email: 'student@nabd.app',
      password: 'SuperSecretPassword123!',
      token: 'jwt.token.here',
      secret: 'super-secret-key',
      hash: 'sha256hashvalue',
      nested: {
        totp_secret: 'JBSWY3DPEHPK3PXP',
        refresh_token: 'refresh_tok_123',
        normal_data: 'safe_value',
      },
    };

    const redacted = redactSensitiveData(sensitivePayload) as any;
    expect(redacted.user_id).toBe('usr_123');
    expect(redacted.email).toBe('student@nabd.app');
    expect(redacted.password).toBe('[REDACTED]');
    expect(redacted.token).toBe('[REDACTED]');
    expect(redacted.secret).toBe('[REDACTED]');
    expect(redacted.hash).toBe('[REDACTED]');
    expect(redacted.nested.totp_secret).toBe('[REDACTED]');
    expect(redacted.nested.refresh_token).toBe('[REDACTED]');
    expect(redacted.nested.normal_data).toBe('safe_value');
  });

  it('D.3: Activation Code Lockout — locks account out after 5 consecutive invalid code attempts with 429', async () => {
    const student = ctx.fixtures.users.student;

    // Send 4 wrong attempts
    for (let i = 0; i < 4; i++) {
      const res = await apiRequest(app, 'POST', '/api/activation/redeem', {
        token: student.token,
        body: { code: `WRONG_CODE_${i}` },
      }, ctx);
      expect(res.status).toBe(404);
    }

    // 5th attempt triggers lockout
    const res5 = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: student.token,
      body: { code: 'WRONG_CODE_5' },
    }, ctx);
    expect(res5.status).toBe(429);
    const data5 = await res5.json();
    expect(data5.detail).toContain('تم قفل تفعيل الأكواد مؤقتاً');

    // 6th attempt is blocked by lockout
    const res6 = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: student.token,
      body: { code: 'WRONG_CODE_6' },
    }, ctx);
    expect(res6.status).toBe(429);
  });

  it('D.4: Activation Code Redemption — succeeds, returns subject details & is_vip, and rejects double redemption', async () => {
    const student = ctx.fixtures.users.student;
    const codeVip = ctx.fixtures.activationCodes.vipIdle;

    // First redemption succeeds
    const res1 = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: student.token,
      body: { code: codeVip },
    }, ctx);
    expect(res1.status).toBe(200);
    const data1 = await res1.json();
    expect(data1.is_vip).toBe(true);
    expect(data1.subject_id).toBeNull();

    // Check status endpoint
    const statusRes = await apiRequest(app, 'GET', '/api/activation/status', {
      token: student.token,
    }, ctx);
    expect(statusRes.status).toBe(200);
    const statusData = await statusRes.json();
    expect(statusData.active_subscriptions.length).toBeGreaterThan(0);

    // Double redemption fails with 400
    const res2 = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: student.token,
      body: { code: codeVip },
    }, ctx);
    expect(res2.status).toBe(400);
    const data2 = await res2.json();
    expect(data2.detail).toContain('مستخدم بالفعل');
  });

  it('D.5: Exam starts are limited by account even when the client changes IP address', async () => {
    const student = ctx.fixtures.users.student;

    for (let i = 0; i < 10; i += 1) {
      const response = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
        token: student.token,
        headers: { 'cf-connecting-ip': '198.51.100.10' },
      }, ctx);
      expect(response.status).toBe(200);
    }

    const changedIp = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: student.token,
      headers: { 'cf-connecting-ip': '198.51.100.11' },
    }, ctx);
    expect(changedIp.status).toBe(429);
    expect(Number(changedIp.headers.get('Retry-After'))).toBeGreaterThan(0);
  });
});
