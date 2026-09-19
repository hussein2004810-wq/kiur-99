/**
 * Structured Security Audit Logger (SEC-LOG-001, SEC-LOG-002)
 *
 * Requirements:
 * - Record: auth success/failure category, lockouts, session revocation,
 *   2FA changes, password reset completion, privileged actions, role changes,
 *   bans, security-rule denials.
 * - SEC-LOG-002: Secrets, tokens, passwords, TOTP secrets, reset tokens
 *   or sensitive payloads MUST NEVER be logged.
 */

export type AuditEventType =
  | 'AUTH_LOGIN_SUCCESS'
  | 'AUTH_LOGIN_FAILED'
  | 'AUTH_ACCOUNT_LOCKED'
  | 'AUTH_LOGOUT'
  | 'AUTH_SESSION_REVOKED'
  | 'AUTH_PASSWORD_CHANGED'
  | 'AUTH_PASSWORD_RESET_REQUESTED'
  | 'AUTH_PASSWORD_RESET_COMPLETED'
  | 'AUTH_2FA_ENABLED'
  | 'AUTH_2FA_DISABLED'
  | 'AUTH_2FA_VERIFIED'
  | 'AUTH_REGISTER_SUCCESS'
  | 'ADMIN_ROLE_CHANGED'
  | 'ADMIN_USER_BANNED'
  | 'ADMIN_USER_UNBANNED'
  | 'ADMIN_SUBJECT_SOFT_DELETED'
  | 'ADMIN_QUESTION_SOFT_DELETED'
  | 'ADMIN_QUESTIONS_IMPORTED'
  | 'ADMIN_ACADEMIC_CHANGE_REVIEWED'
  | 'ADMIN_ITEM_RESTORED'
  | 'ADMIN_ITEM_PURGED'
  | 'ADMIN_CERTIFICATE_REVOKED'
  | 'ADMIN_GLIMPSE_CREATED'
  | 'ADMIN_GLIMPSE_PUBLISHED'
  | 'ADMIN_GLIMPSE_DELETED'
  | 'ADMIN_ACADEMIC_UNIVERSITY_CREATED'
  | 'ADMIN_ACADEMIC_UNIVERSITY_DELETED'
  | 'ADMIN_ACADEMIC_PROGRAM_CREATED'
  | 'ADMIN_ACADEMIC_DEPARTMENT_CREATED'
  | 'ADMIN_ACADEMIC_SECTION_CREATED'
  | 'ADMIN_ACADEMIC_STAGE_DELETED'
  | 'ADMIN_ACADEMIC_SUBJECT_UPDATED'
  | 'ADMIN_ACADEMIC_SUBJECT_DELETED'
  | 'ADMIN_ACADEMIC_CSV_IMPORTED'
  | 'SECURITY_RULE_DENIAL'
  | 'SECURITY_CSRF_DENIAL'
  | 'SECURITY_RATE_LIMITED';

export interface AuditLogEntry {
  timestamp: string;
  event: AuditEventType;
  actorId?: string | null;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  status: 'SUCCESS' | 'FAILURE' | 'DENIED' | 'LOCKED';
  details?: Record<string, unknown>;
}

const SENSITIVE_KEY_PATTERN = /(password|token|secret|authorization|cookie|totp|reset_token|bearer|credential|api_key|salt|hash)/i;

/**
 * Deep redaction scrubber to enforce SEC-LOG-002.
 * Replaces any values matching sensitive keys with '[REDACTED]'.
 */
export function redactSensitiveData(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveData(item));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = redactSensitiveData(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// In-memory test sink for automated security verification
const auditLogBuffer: AuditLogEntry[] = [];
const MAX_BUFFER_SIZE = 500;

export function recordAuditEvent(entry: Omit<AuditLogEntry, 'timestamp'>): AuditLogEntry {
  const sanitizedDetails = entry.details
    ? (redactSensitiveData(entry.details) as Record<string, unknown>)
    : undefined;

  const fullEntry: AuditLogEntry = {
    timestamp: new Date().toISOString(),
    event: entry.event,
    actorId: entry.actorId ?? null,
    targetId: entry.targetId ?? null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    status: entry.status,
    details: sanitizedDetails,
  };

  // Keep test buffer bounded
  auditLogBuffer.push(fullEntry);
  if (auditLogBuffer.length > MAX_BUFFER_SIZE) {
    auditLogBuffer.shift();
  }

  // Cloudflare Workers logs standard JSON to stderr/stdout for CF Logpush/Tail
  const level = fullEntry.status === 'SUCCESS' ? 'info' : 'warn';
  const serialized = JSON.stringify({ audit: true, ...fullEntry });
  if (level === 'info') {
    console.info(serialized);
  } else {
    console.warn(serialized);
  }

  return fullEntry;
}

/**
 * Inspection helper for security test assertions
 */
export function getAuditLogs(): readonly AuditLogEntry[] {
  return auditLogBuffer;
}

export function clearAuditLogs(): void {
  auditLogBuffer.length = 0;
}

