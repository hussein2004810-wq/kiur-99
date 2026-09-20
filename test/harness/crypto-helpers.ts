import crypto from 'node:crypto';

// PBKDF2-HMAC-SHA256 matching Python backend:
// salt = secrets.token_hex(16) -> 32 hex chars
// pbkdf2_hmac('sha256', password, bytes.fromhex(salt), 200000)
// stored: salt$digest
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.pbkdf2Sync(
    password,
    Buffer.from(salt, 'hex'),
    200000,
    32,
    'sha256'
  ).toString('hex');
  return `${salt}$${digest}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash || !storedHash.includes('$')) return false;
  const [salt, digest] = storedHash.split('$');
  const check = crypto.pbkdf2Sync(
    password,
    Buffer.from(salt, 'hex'),
    200000,
    32,
    'sha256'
  ).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(check, 'hex'));
}

// Simple Base64URL encoding/decoding
function base64UrlEncode(str: string | Buffer): string {
  const buf = Buffer.isBuffer(str) ? str : Buffer.from(str);
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(str: string): Buffer {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64');
}

// HS256 JWT Token signing & verification matching Python backend
export function signJwt(payload: Record<string, any>, secret: string, expiresInMinutes = 20160): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + expiresInMinutes * 60;
  const isAccess = typeof payload.sub === 'string';
  const isPendingTwoFactor = typeof payload.pending_2fa_user === 'string';
  const fullPayload = {
    ...payload,
    ...(isAccess ? { type: payload.type ?? 'access' } : {}),
    ...(isPendingTwoFactor ? { type: payload.type ?? 'pending_2fa' } : {}),
    iss: payload.iss ?? 'kiur-api',
    aud: payload.aud ?? 'kiur-app',
    iat: payload.iat ?? Math.floor(Date.now() / 1000),
    exp: payload.exp ?? exp,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac('sha256', secret)
    .update(signatureInput)
    .digest();

  return `${signatureInput}.${base64UrlEncode(signature)}`;
}

export function verifyJwt<T = Record<string, any>>(token: string, secret: string): T | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, sigB64] = parts;
    const signatureInput = `${headerB64}.${payloadB64}`;

    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(signatureInput)
      .digest();

    const actualSig = base64UrlDecode(sigB64);
    if (!crypto.timingSafeEqual(expectedSig, actualSig)) {
      return null;
    }

    const payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf-8'));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return null; // Expired
    }

    return payload as T;
  } catch {
    return null;
  }
}

// RFC 6238 TOTP generation & verification
export function generateTotpSecret(): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let secret = '';
  const bytes = crypto.randomBytes(20);
  for (let i = 0; i < bytes.length; i++) {
    secret += charset[bytes[i] % 32];
  }
  return secret;
}

function base32Decode(base32: string): Buffer {
  const clean = base32.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (let i = 0; i < clean.length; i++) {
    const idx = alphabet.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

export function generateTotpCode(secret: string, timestamp = Date.now(), step = 30): string {
  const counter = Math.floor(timestamp / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter), 0);

  const key = base32Decode(secret);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();

  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % 1000000;

  return code.toString().padStart(6, '0');
}

export function verifyTotpCode(code: string, secret: string, window = 1): boolean {
  const now = Date.now();
  for (let i = -window; i <= window; i++) {
    const expected = generateTotpCode(secret, now + i * 30 * 1000);
    if (expected === code) return true;
  }
  return false;
}
