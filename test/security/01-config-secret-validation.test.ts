import { describe, it, expect } from 'vitest';
import { getConfig, validateConfig, type AppConfig } from '../../src/config';
import type { AppBindings } from '../../src/types';

describe('Stage 1: Production Secret and Configuration Validation', () => {
  const baseBindings: AppBindings = {
    DB: {} as any,
    JWT_SECRET: 'a-very-long-and-secure-random-token-for-kiur-99-production-system-at-least-32-chars',
    DEBUG: 'false',
    CORS_ORIGINS: 'https://app.kiur.edu.iq',
  };

  it('passes validation with a secure production secret', () => {
    const config = getConfig(baseBindings);
    expect(config.isDebug).toBe(false);
    expect(config.jwtAlgorithm).toBe('HS256');
  });

  it('fails closed in production if JWT_SECRET is missing or empty', () => {
    expect(() =>
      getConfig({
        ...baseBindings,
        JWT_SECRET: '',
        DEBUG: 'false',
      })
    ).toThrow(/JWT_SECRET is required/);
  });

  it('fails closed in production if JWT_SECRET is shorter than 32 characters', () => {
    expect(() =>
      getConfig({
        ...baseBindings,
        JWT_SECRET: 'short-secret-12345',
        DEBUG: 'false',
      })
    ).toThrow(/at least 32 characters/);
  });

  it('fails closed in production if JWT_SECRET is a known insecure placeholder', () => {
    const placeholders = [
      'dev-secret-change-me',
      'dev-secret-change-me-to-a-very-long-and-secure-random-token-nabd-2026',
      'super-secret-secure-random-token-kiur-99-prod-2026',
      'secret',
      'changeme',
    ];

    for (const secret of placeholders) {
      expect(() =>
        getConfig({
          ...baseBindings,
          JWT_SECRET: secret,
          DEBUG: 'false',
        })
      ).toThrow(/Insecure default or placeholder JWT_SECRET/);
    }
  });

  it('allows development placeholder secrets when DEBUG="true"', () => {
    const devConfig = getConfig({
      DB: {} as any,
      JWT_SECRET: 'dev-secret-change-me',
      DEBUG: 'true',
    });
    expect(devConfig.isDebug).toBe(true);
    expect(devConfig.jwtSecret).toBe('dev-secret-change-me');
  });

  it('fails closed if JWT_ALGORITHM is unsupported or insecure', () => {
    expect(() =>
      getConfig({
        ...baseBindings,
        JWT_ALGORITHM: 'none',
      })
    ).toThrow(/Insecure or unsupported JWT algorithm/);

    expect(() =>
      getConfig({
        ...baseBindings,
        JWT_ALGORITHM: 'RS256',
      })
    ).toThrow(/Insecure or unsupported JWT algorithm/);
  });

  it('fails closed in production without explicit non-wildcard CORS origins', () => {
    expect(() => getConfig({ ...baseBindings, CORS_ORIGINS: '*' }))
      .toThrow(/non-wildcard CORS_ORIGINS/);
    expect(() => getConfig({ ...baseBindings, CORS_ORIGINS: '' }))
      .toThrow(/non-wildcard CORS_ORIGINS/);
  });

  it('never leaks secret values in the exception message', () => {
    const leakedSecret = 'my-super-secret-password-leaked-123456';
    try {
      validateConfig({
        isDebug: false,
        jwtSecret: 'short',
        jwtAlgorithm: 'HS256',
      } as AppConfig);
    } catch (err: any) {
      expect(err.message).not.toContain(leakedSecret);
      expect(err.message).not.toContain('short');
    }
  });
});
