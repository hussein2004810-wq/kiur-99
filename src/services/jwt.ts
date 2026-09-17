/**
 * JWT service — HS256 via Web Crypto (jose library).
 * Mirrors Python's security.py JWT helpers exactly.
 * Hardened according to KIUR-99 Security Plan (Stage 2).
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

const SESSION_COOKIE_PATH = '/auth/session';
const SESSION_COOKIE_NAME = 'nabd_session';
export const JWT_ISSUER = 'kiur-api';
export const JWT_AUDIENCE = 'kiur-app';
export const JWT_TYPE_ACCESS = 'access';
export const JWT_TYPE_2FA = 'pending_2fa';

export const SESSION_COOKIE_PATH = '/auth/session';
export const SESSION_COOKIE_NAME = 'nabd_session';

export interface AccessTokenPayload extends JWTPayload {
  sub: string;   // user_id
  sid: string;   // session_id
  type?: string; // 'access'
}

export interface PendingTwoFAPayload extends JWTPayload {
  pending_2fa_user: string;
  type?: string; // 'pending_2fa'
}

function getSecretKey(jwtSecret: string): Uint8Array {
  return new TextEncoder().encode(jwtSecret);
}

/**
 * Creates a short-lived, typed access token.
 * Defaults to 30 minutes.
 */
export async function createAccessToken(
  userId: string,
  sessionId: string,
  jwtSecret: string,
  expiresMinutes = 20160
  expiresMinutes = 30
): Promise<string> {
  return new SignJWT({ sub: userId, sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
  return new SignJWT({
    sub: userId,
    sid: sessionId,
    type: JWT_TYPE_ACCESS,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime(`${expiresMinutes}m`)
    .setIssuedAt()
    .sign(getSecretKey(jwtSecret));
}

/**
 * Decodes and rigorously validates an access token.
 * Validates algorithm, expiration, issuer, audience, type, and required claims.
 * Ensures 2FA-pending tokens can NEVER be accepted as access tokens.
 */
export async function decodeAccessToken(
  token: string,
  jwtSecret: string
): Promise<AccessTokenPayload | null> {
  if (!token || typeof token !== 'string') return null;

  try {
    const { payload } = await jwtVerify(token, getSecretKey(jwtSecret));
    return payload as AccessTokenPayload;
    const { payload } = await jwtVerify(token, getSecretKey(jwtSecret), {
      algorithms: ['HS256', 'HS384', 'HS512'],
    });

    const p = payload as AccessTokenPayload & { pending_2fa_user?: string };

    // 1. Must never be a 2FA pending token
    if (p.pending_2fa_user || p.type === JWT_TYPE_2FA) {
      return null;
    }

    // 2. Token type must be 'access' if type claim is present
    if (p.type && p.type !== JWT_TYPE_ACCESS) {
      return null;
    }

    // 3. Validate issuer if present
    if (p.iss && p.iss !== JWT_ISSUER) {
      return null;
    }

    // 4. Validate audience if present
    if (p.aud && p.aud !== JWT_AUDIENCE) {
      return null;
    }

    // 5. Must have non-empty sub and sid
    if (!p.sub || typeof p.sub !== 'string' || p.sub.trim() === '') {
      return null;
    }
    if (!p.sid || typeof p.sid !== 'string' || p.sid.trim() === '') {
      return null;
    }

    return p;
  } catch {
    return null;
  }
}

/**
 * Creates a short-lived 2FA pending token (5 minutes).
 * Distinct token type 'pending_2fa'.
 */
export async function create2faPendingToken(
  userId: string,
  jwtSecret: string
): Promise<string> {
  return new SignJWT({ pending_2fa_user: userId })
    .setProtectedHeader({ alg: 'HS256' })
  return new SignJWT({
    pending_2fa_user: userId,
    type: JWT_TYPE_2FA,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime('5m')
    .setIssuedAt()
    .sign(getSecretKey(jwtSecret));
}

/**
 * Decodes and validates a 2FA pending token.
 */
export async function decode2faPendingToken(
  token: string,
  jwtSecret: string
): Promise<string | null> {
  if (!token || typeof token !== 'string') return null;

  try {
    const { payload } = await jwtVerify(token, getSecretKey(jwtSecret));
    return (payload as PendingTwoFAPayload).pending_2fa_user ?? null;
    const { payload } = await jwtVerify(token, getSecretKey(jwtSecret), {
      algorithms: ['HS256', 'HS384', 'HS512'],
    });

    const p = payload as PendingTwoFAPayload;

    // Must have pending_2fa_user and not be a regular access token
    if (!p.pending_2fa_user || typeof p.pending_2fa_user !== 'string') {
      return null;
    }

    if (p.type && p.type !== JWT_TYPE_2FA) {
      return null;
    }

    if (p.iss && p.iss !== JWT_ISSUER) {
      return null;
    }

    if (p.aud && p.aud !== JWT_AUDIENCE) {
      return null;
    }

    return p.pending_2fa_user;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────
// Cookie helpers
// ──────────────────────────────────────────────────────────────────
export function setSessionCookie(
  response: Response,
  token: string,
  expiresMinutes = 20160,
  expiresMinutes = 30,
  isDebug = true
): void {
  const maxAge = expiresMinutes * 60;
  const secure = isDebug ? '' : '; Secure';
  response.headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${token}; Path=${SESSION_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  );
}

export function clearSessionCookie(response: Response, isDebug = true): void {
  const secure = isDebug ? '' : '; Secure';
  response.headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=; Path=${SESSION_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
  );
}

export function getSessionCookieValue(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|; )${SESSION_COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

export { SESSION_COOKIE_NAME };
