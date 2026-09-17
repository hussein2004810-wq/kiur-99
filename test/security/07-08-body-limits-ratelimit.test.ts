import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, type TestContext } from '../harness/test-context';
import { resetRateLimitStore } from '../../src/middleware/rate-limit';
import app from '../../src/index';

describe('Stages 7 & 8: Request Body Limits and Rate Limiting', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
    resetRateLimitStore();
  });

  describe('Stage 7: Request Body Limits', () => {
    it('security.http.oversized-json: rejects JSON bodies larger than 100 KB with 413', async () => {
      // Create a payload > 100 KB
      const largeString = 'A'.repeat(120 * 1024);
      const res = await app.request('/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(largeString.length),
        },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'Password@2026',
          full_name: largeString,
        }),
      }, ctx.bindings);

      expect(res.status).toBe(413);
      const data = await res.json();
      expect(data.detail).toContain('413 Payload Too Large');
    });

    it('accepts valid JSON bodies within 100 KB limit', async () => {
      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: ctx.fixtures.users.student.email,
          password: 'Nabd@2026',
        }),
      }, ctx.bindings);

      expect(res.status).toBe(200);
    });
  });

  describe('Stage 8: Rate Limiting & Abuse Resistance', () => {
    it('security.abuse.login-rate-limit: enforces rate limit after 10 login attempts within window', async () => {
      const attempts = 12;
      let lastStatus = 200;
      let retryAfterHeader: string | null = null;

      for (let i = 0; i < attempts; i++) {
        const res = await app.request('/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'cf-connecting-ip': '192.0.2.1', // consistent test IP
          },
          body: JSON.stringify({
            email: 'wrong@student.com',
            password: 'WrongPassword123',
          }),
        }, ctx.bindings);

        lastStatus = res.status;
        if (res.status === 429) {
          retryAfterHeader = res.headers.get('Retry-After');
          break;
        }
      }

      expect(lastStatus).toBe(429);
      expect(retryAfterHeader).toBeDefined();
      expect(Number(retryAfterHeader)).toBeGreaterThan(0);
    });

    it('security.abuse.forgot-pw-limit: enforces rate limit on password reset request', async () => {
      let hit429 = false;

      for (let i = 0; i < 5; i++) {
        const res = await app.request('/auth/forgot-password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'cf-connecting-ip': '198.51.100.2',
          },
          body: JSON.stringify({
            email: 'student@nabd.app',
          }),
        }, ctx.bindings);

        if (res.status === 429) {
          hit429 = true;
          expect(res.headers.get('Retry-After')).toBeDefined();
          break;
        }
      }

      expect(hit429).toBe(true);
    });
  });
});

