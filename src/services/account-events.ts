import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { redactSensitiveData } from './audit';

export type AccountEventType =
  | 'register'
  | 'login_success'
  | 'login_failure'
  | 'google_login'
  | 'google_link'
  | 'logout'
  | 'logout_all'
  | 'session_revoked'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'password_changed'
  | 'email_verified'
  | 'verification_resent'
  | 'totp_enabled'
  | 'totp_disabled'
  | 'account_locked'
  | 'ban_created'
  | 'ban_lifted'
  | 'academic_change_requested'
  | 'academic_change_reviewed'
  | 'grant_changed';

export interface RecordAccountEventParams {
  userId?: string | null;
  email?: string | null;
  eventType: AccountEventType;
  outcome: 'success' | 'failure';
  ip?: string | null;
  userAgent?: string | null;
  details?: Record<string, any>;
}

/**
 * Generates SHA-256 hash in hex for privacy preservation.
 */
async function hashPrivacyValue(value: string): Promise<string> {
  if (!value) return '';
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/**
 * Records a privacy-preserving account security event (Stage A4).
 * Strips raw IPs and device strings into cryptographically hashed identifiers.
 * Deeply scrubs all tokens, passwords, and secrets.
 */
export async function recordAccountEvent(
  db: ReturnType<typeof drizzle>,
  params: RecordAccountEventParams
): Promise<void> {
  try {
    const rawEmail = (params.email ?? '').trim().toLowerCase();
    const rawIp = params.ip || '127.0.0.1';
    const rawUa = params.userAgent || 'unknown';

    const [emailHash, ipHash, deviceHash] = await Promise.all([
      rawEmail ? hashPrivacyValue(rawEmail) : '',
      hashPrivacyValue(rawIp),
      hashPrivacyValue(rawUa),
    ]);

    const safeDetails = params.details
      ? (redactSensitiveData(params.details) as Record<string, any>)
      : null;

    await db.insert(schema.accountEvents).values({
      id: schema.genId(),
      user_id: params.userId ?? null,
      email_hash: emailHash || null,
      event_type: params.eventType,
      outcome: params.outcome,
      device_hash: deviceHash,
      ip_hash: ipHash,
      details_json: safeDetails ? JSON.stringify(safeDetails) : null,
    });
  } catch (error) {
    // Non-blocking: failures to log account events should never abort primary operations
    console.error('[account-events] Failed to record account security event:', error);
  }
}
