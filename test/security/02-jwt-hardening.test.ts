import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import {
  createAccessToken,
  decodeAccessToken,
  create2faPendingToken,
  decode2faPendingToken,
  JWT_ISSUER,
  JWT_AUDIENCE,
  JWT_TYPE_ACCESS,
  JWT_TYPE_2FA,
} from '../../src/services/jwt';

describe('Stage 2: JWT Hardening Specification', () => {
  const secret = 'test-secret-at-least-32-characters-long-for-hmac-sha256';
  const rawKey = new TextEncoder().encode(secret);

  it('security.auth.jwt.valid-token: creates and decodes valid access token', async () => {
    const token = await createAccessToken('user_123', 'sess_abc', secret, 30);
    const payload = await decodeAccessToken(token, secret);

    expect(payload).not.toBeNull();
    expect(payload?.sub).toBe('user_123');
    expect(payload?.sid).toBe('sess_abc');
    expect(payload?.iss).toBe(JWT_ISSUER);
    expect(payload?.aud).toBe(JWT_AUDIENCE);
    expect(payload?.type).toBe(JWT_TYPE_ACCESS);
  });

  it('security.auth.jwt.expired: rejects expired access token', async () => {
    const expiredToken = await new SignJWT({
      sub: 'user_123',
      sid: 'sess_abc',
      type: JWT_TYPE_ACCESS,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 100)
      .sign(rawKey);

    const payload = await decodeAccessToken(expiredToken, secret);
    expect(payload).toBeNull();
  });

  it('security.auth.jwt.wrong-issuer: rejects token with invalid issuer', async () => {
    const badIssToken = await new SignJWT({
      sub: 'user_123',
      sid: 'sess_abc',
      type: JWT_TYPE_ACCESS,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('evil-issuer')
      .setAudience(JWT_AUDIENCE)
      .setExpirationTime('30m')
      .sign(rawKey);

    const payload = await decodeAccessToken(badIssToken, secret);
    expect(payload).toBeNull();
  });

  it('security.auth.jwt.wrong-audience: rejects token with invalid audience', async () => {
    const badAudToken = await new SignJWT({
      sub: 'user_123',
      sid: 'sess_abc',
      type: JWT_TYPE_ACCESS,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(JWT_ISSUER)
      .setAudience('wrong-app')
      .setExpirationTime('30m')
      .sign(rawKey);

    const payload = await decodeAccessToken(badAudToken, secret);
    expect(payload).toBeNull();
  });

  it('security.auth.jwt.missing-sid: rejects token missing session id', async () => {
    const noSidToken = await new SignJWT({
      sub: 'user_123',
      type: JWT_TYPE_ACCESS,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setExpirationTime('30m')
      .sign(rawKey);

    const payload = await decodeAccessToken(noSidToken, secret);
    expect(payload).toBeNull();
  });

  it('security.auth.jwt.2fa-as-access: ensures 2FA pending token CANNOT authenticate as access token', async () => {
    const twoFaToken = await create2faPendingToken('user_123', secret);

    // Must decode via 2FA decoder
    const userId = await decode2faPendingToken(twoFaToken, secret);
    expect(userId).toBe('user_123');

    // MUST BE REJECTED by decodeAccessToken
    const accessPayload = await decodeAccessToken(twoFaToken, secret);
    expect(accessPayload).toBeNull();
  });

  it('security.auth.jwt.malformed: rejects malformed or forged token', async () => {
    expect(await decodeAccessToken('not-a-token', secret)).toBeNull();
    expect(await decodeAccessToken('header.payload', secret)).toBeNull();
    expect(await decodeAccessToken('', secret)).toBeNull();
  });
});
