/**
 * JWT service — HS256 via Web Crypto (jose library).
 * Mirrors Python's security.py JWT helpers exactly.
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

const SESSION_COOKIE_PATH = '/auth/session';
const SESSION_COOKIE_NAME = 'nabd_session';

export interface AccessTokenPayload extends JWTPayload {
  sub: string;   // user_id
  sid: string;   // session_id
}

export interface PendingTwoFAPayload extends JWTPayload {
  pending_2fa_user: string;
}

function getSecretKey(jwtSecret: string): Uint8Array {
  return new TextEncoder().encode(jwtSecret);
}

export async function createAccessToken(
  userId: string,
  sessionId: string,
  jwtSecret: string,
  expiresMinutes = 20160
): Promise<string> {
  return new SignJWT({ sub: userId, sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(`${expiresMinutes}m`)
    .setIssuedAt()
    .sign(getSecretKey(jwtSecret));
}

export async function decodeAccessToken(
  token: string,
  jwtSecret: string
): Promise<AccessTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(jwtSecret));
    return payload as AccessTokenPayload;
  } catch {
    return null;
  }
}

export async function create2faPendingToken(
  userId: string,
  jwtSecret: string
): Promise<string> {
  return new SignJWT({ pending_2fa_user: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('5m')
    .setIssuedAt()
    .sign(getSecretKey(jwtSecret));
}

export async function decode2faPendingToken(
  token: string,
  jwtSecret: string
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(jwtSecret));
    return (payload as PendingTwoFAPayload).pending_2fa_user ?? null;
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
