import type { AppBindings } from './types';

export const DEFAULT_JWT_SECRET = 'dev-secret-change-me';
export const SESSION_COOKIE_NAME = 'nabd_session';
export const DEFAULT_JWT_EXPIRES_MINUTES = 60 * 24 * 14; // 14 days (20160 minutes)
export const DEFAULT_PASSWORD_RESET_TTL_MINUTES = 60;
export const DEFAULT_PASSWORD_RESET_COOLDOWN_SECONDS = 120;

export interface AppConfig {
  isDebug: boolean;
  jwtSecret: string;
  jwtAlgorithm: string;
  jwtExpiresMinutes: number;
  corsOriginsList: string[];
  allowedUniversityDomainsList: string[];
  frontendUrl: string;
  adminFrontendUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  bootstrapAdminEmail: string;
  passwordResetTtlMinutes: number;
  passwordResetCooldownSeconds: number;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  smtpFrom: string;
  smtpFromName: string;
}

/**
 * Parses and returns typed configuration options from Worker environment bindings.
 */
export function getConfig(env?: AppBindings): AppConfig {
  const isDebug = env?.DEBUG === 'true' || env?.DEBUG === '1';
  const jwtSecret = env?.JWT_SECRET || DEFAULT_JWT_SECRET;
  const jwtAlgorithm = env?.JWT_ALGORITHM || 'HS256';
  const jwtExpiresMinutes = parseInt(env?.JWT_EXPIRES_MINUTES || '20160', 10) || DEFAULT_JWT_EXPIRES_MINUTES;

  const rawCors = env?.CORS_ORIGINS || 'http://localhost:5500,http://127.0.0.1:5500,http://localhost:8787,http://127.0.0.1:8787';
  const corsOriginsList = rawCors
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const rawDomains = env?.ALLOWED_UNIVERSITY_DOMAINS || '';
  const allowedUniversityDomainsList = rawDomains
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const frontendUrl = env?.FRONTEND_URL || 'http://localhost:8787';
  const adminFrontendUrl = env?.ADMIN_FRONTEND_URL || '';
  const googleClientId = env?.GOOGLE_CLIENT_ID || '';
  const googleClientSecret = env?.GOOGLE_CLIENT_SECRET || '';
  const googleRedirectUri = env?.GOOGLE_REDIRECT_URI || `${frontendUrl}/auth/google/callback`;
  const bootstrapAdminEmail = (env?.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();

  const passwordResetTtlMinutes = parseInt(env?.PASSWORD_RESET_TTL_MINUTES || '60', 10) || DEFAULT_PASSWORD_RESET_TTL_MINUTES;
  const passwordResetCooldownSeconds = parseInt(env?.PASSWORD_RESET_COOLDOWN_SECONDS || '120', 10) || DEFAULT_PASSWORD_RESET_COOLDOWN_SECONDS;

  const smtpHost = env?.SMTP_HOST || '';
  const smtpPort = parseInt(env?.SMTP_PORT || '587', 10) || 587;
  const smtpUser = env?.SMTP_USER || '';
  const smtpPassword = env?.SMTP_PASSWORD || '';
  const smtpFrom = env?.SMTP_FROM || 'no-reply@nabd.edu';
  const smtpFromName = env?.SMTP_FROM_NAME || 'Kiur';

  return {
    isDebug,
    jwtSecret,
    jwtAlgorithm,
    jwtExpiresMinutes,
    corsOriginsList,
    allowedUniversityDomainsList,
    frontendUrl,
    adminFrontendUrl,
    googleClientId,
    googleClientSecret,
    googleRedirectUri,
    bootstrapAdminEmail,
    passwordResetTtlMinutes,
    passwordResetCooldownSeconds,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPassword,
    smtpFrom,
    smtpFromName,
  };
}
