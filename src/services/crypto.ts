/**
 * Cryptographic services — Web Crypto API only (no Node.js crypto).
 * Mirrors Python's security.py: PBKDF2-HMAC-SHA256, TOTP, JWT helpers.
 */

// ──────────────────────────────────────────────────────────────────
// Password hashing  (PBKDF2-HMAC-SHA256, 100k iterations)
// Format: "<16-byte-hex-salt>$<32-byte-hex-digest>"
// ──────────────────────────────────────────────────────────────────
const PBKDF2_ITERATIONS = 100_000;

function hexToUint8(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

function uint8ToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hashPassword(password: string): Promise<string> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = uint8ToHex(saltBytes.buffer);

  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: PBKDF2_ITERATIONS },
    keyMaterial, 256
  );
  return `${salt}$${uint8ToHex(derivedBits)}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string | null
): Promise<boolean> {
  if (!storedHash || !storedHash.includes('$')) return false;
  const [salt, digestHex] = storedHash.split('$', 2);
  const saltBytes = hexToUint8(salt);

  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: PBKDF2_ITERATIONS },
    keyMaterial, 256
  );
  const derivedHex = uint8ToHex(derivedBits);

  // Constant-time comparison
  if (derivedHex.length !== digestHex.length) return false;
  let diff = 0;
  for (let i = 0; i < derivedHex.length; i++) {
    diff |= derivedHex.charCodeAt(i) ^ digestHex.charCodeAt(i);
  }
  return diff === 0;
}

// ──────────────────────────────────────────────────────────────────
// Password reset token (SHA-256, no salt needed — 32-byte raw token)
// ──────────────────────────────────────────────────────────────────
export function generateResetToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export async function hashResetToken(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return uint8ToHex(hash);
}

// ──────────────────────────────────────────────────────────────────
// TOTP — RFC 6238 (mirrors Python security.py exactly)
// ──────────────────────────────────────────────────────────────────
const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;

function base32Decode(base32: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const input = base32.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  let index = 0;
  const output = new Uint8Array(Math.floor((input.length * 5) / 8));

  for (let i = 0; i < input.length; i++) {
    const charIndex = alphabet.indexOf(input[i]);
    if (charIndex < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | charIndex;
    bits += 5;
    if (bits >= 8) {
      output[index++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return output;
}

async function totpCodeAt(secret: string, counter: number): Promise<string> {
  const key = base32Decode(secret);
  const counterBytes = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = c & 0xff;
    c = Math.floor(c / 256);
  }

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, counterBytes);
  const digest = new Uint8Array(sig);
  const offset = digest[digest.length - 1] & 0x0f;
  const codeInt =
    (((digest[offset] & 0x7f) << 24) |
      ((digest[offset + 1] & 0xff) << 16) |
      ((digest[offset + 2] & 0xff) << 8) |
      (digest[offset + 3] & 0xff)) %
    Math.pow(10, TOTP_DIGITS);
  return String(codeInt).padStart(TOTP_DIGITS, '0');
}

export async function verifyTotp(
  secret: string,
  code: string,
  window = 1
): Promise<boolean> {
  if (!secret || !code || !/^\d+$/.test(code)) return false;
  const current = Math.floor(Date.now() / 1000 / TOTP_PERIOD);
  for (let offset = -window; offset <= window; offset++) {
    if ((await totpCodeAt(secret, current + offset)) === code) return true;
  }
  return false;
}

export async function generateTotpCode(secret: string): Promise<string> {
  const current = Math.floor(Date.now() / 1000 / TOTP_PERIOD);
  return await totpCodeAt(secret, current);
}

export async function generateTotpSecret(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let result = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += alphabet[(value << (5 - bits)) & 31];
  while (result.length % 8 !== 0) result += '=';
  return result;
}

export function totpProvisioningUri(
  secret: string,
  email: string,
  issuer = 'Kiur'
): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return (
    `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}` +
    `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`
  );
}
