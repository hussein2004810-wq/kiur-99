import type { Role } from './db/schema';

/**
 * Cloudflare Worker Environment Bindings.
 * Injected automatically by the Cloudflare runtime via `c.env`.
 */
export interface AppBindings {
  DB: D1Database;
  R2_BUCKET?: R2Bucket;
  JWT_SECRET: string;
  JWT_ALGORITHM?: string;
  JWT_EXPIRES_MINUTES?: string;
  DEBUG?: string;
  CORS_ORIGINS?: string;
  BOOTSTRAP_ADMIN_EMAIL?: string;
  ALLOWED_UNIVERSITY_DOMAINS?: string;
  FRONTEND_URL?: string;
  ADMIN_FRONTEND_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  PASSWORD_RESET_TTL_MINUTES?: string;
  PASSWORD_RESET_COOLDOWN_SECONDS?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM?: string;
  SMTP_FROM_NAME?: string;
  ASSETS?: Fetcher;
}

/**
 * Authenticated user context attached to `c.var.user`.
 * Strictly typed with `snake_case` properties matching the database and frontend contract.
 */
export interface CurrentUser {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  is_banned: boolean;
  university_id?: string | null;
  stage_id?: string | null;
  section_id?: string | null;
}

/**
 * Single-active-session anti-piracy context attached to `c.var.session`.
 */
export interface CurrentSession {
  id: string;
  user_id: string;
  device_label: string;
  is_active: boolean;
}

/**
 * Hono context variables accessible via `c.get()` and `c.set()`.
 */
export interface AppVariables {
  user?: CurrentUser;
  session?: CurrentSession;
  requestId?: string;
}

/**
 * Master Hono App Environment typing.
 */
export type AppEnv = {
  Bindings: AppBindings;
  Variables: AppVariables;
};
