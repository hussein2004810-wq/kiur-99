import { describe, it, expect } from 'vitest';
import { resolveAllowedOrigin } from '../../src/middleware/cors';
import { formatZodError } from '../../src/middleware/error';
import { z } from 'zod';

describe('Adversarial Auditor Stress Tests', () => {
  it('CORS strictly rejects domain spoofing attempts like localhost.attacker.com', () => {
    expect(resolveAllowedOrigin('http://localhost.attacker.com', { DEBUG: 'true' })).toBeNull();
    expect(resolveAllowedOrigin('http://127.0.0.1.attacker.com', { DEBUG: 'true' })).toBeNull();
    expect(resolveAllowedOrigin('http://evil-localhost:3000', { DEBUG: 'true' })).toBeNull();
    expect(resolveAllowedOrigin('null', { DEBUG: 'true' })).toBeNull();
    expect(resolveAllowedOrigin('javascript:alert(1)', { DEBUG: 'true' })).toBeNull();
  });

  it('CORS permits valid localhost in debug mode and restricts in production', () => {
    expect(resolveAllowedOrigin('http://localhost:3000', { DEBUG: 'true' })).toBe('http://localhost:3000');
    expect(resolveAllowedOrigin('http://127.0.0.1:8080', { DEBUG: 'true' })).toBe('http://127.0.0.1:8080');
    expect(resolveAllowedOrigin('https://localhost:443', { DEBUG: 'true' })).toBe('https://localhost:443');

    // In production (DEBUG=false), only configured origins are allowed
    expect(resolveAllowedOrigin('http://localhost:9999', { DEBUG: 'false' })).toBeNull();
    expect(resolveAllowedOrigin('https://malicious.com', { DEBUG: 'false' })).toBeNull();
  });

  it('Zod error formatter cleanly handles nested structures without leaking objects', () => {
    const complexSchema = z.object({
      user: z.object({
        profile: z.object({
          age: z.number(),
        }),
      }),
    });

    const res = complexSchema.safeParse({ user: { profile: { age: 'not-a-number' } } });
    expect(res.success).toBe(false);
    if (!res.success) {
      const formatted = formatZodError(res.error);
      expect(formatted).toContain('user.profile.age');
      expect(formatted).not.toContain('[object Object]');
    }
  });
});
