/**
 * Auth routes — mirrors Python app/routers/auth.py (899 lines)
 * Complete: register, login, logout, Google OAuth, 2FA, sessions,
 * profile updates, skills, photos, stats, leaderboard, history,
 * password reset (forgot/reset), session restore.
 */
import { Hono, type Context } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and, ne, inArray, desc, isNotNull, isNull, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { requireAuth, startNewSession, authenticateToken } from '../middleware/auth';
import {
  hashPassword,
  verifyPassword,
  generateResetToken,
  hashResetToken,
  generateTotpSecret,
  totpProvisioningUri,
  verifyTotp,
} from '../services/crypto';
import {
  createAccessToken,
  decodeAccessToken,
  create2faPendingToken,
  decode2faPendingToken,
  setSessionCookie,
  clearSessionCookie,
  getSessionCookieValue,
  SESSION_COOKIE_NAME,
} from '../services/jwt';
import { emailConfigured, sendEmailVerification, sendPasswordReset } from '../services/mailer';
import { createStorageService, isStorageConfigured, safeUploadNameForDetectedType, mediaUrl, validateFileSignature, IMAGE_EXTS, MAX_UPLOAD_BYTES } from '../services/storage';
import { peerIds, rankedPairs, rankOf, streakDays, accuracyPct } from '../services/ranking';
import {
  loginRateLimiter,
  registerRateLimiter,
  forgotPasswordRateLimiter,
  resetPasswordRateLimiter,
  verifyEmailRateLimiter,
  twoFaVerifyRateLimiter,
  resendVerificationRateLimiter,
  firebaseAuthRateLimiter,
  googleIdentityRateLimiter,
  oauthHandoffRateLimiter,
} from '../middleware/rate-limit';
import { recordAuditEvent } from '../services/audit';
import { verifyFirebaseGoogleToken, FirebaseAuthError } from '../services/firebase';
import { verifyGoogleIdentityCredential, GoogleIdentityError } from '../services/google-identity';
import { recordAccountEvent } from '../services/account-events';
import { claimBootstrapAdmin } from '../services/bootstrap-admin';

export const authRouter = new Hono<AppEnv>();

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const ADMIN_DASHBOARD_ROLES = new Set(['admin', 'professor', 'reseller']);
const PASSWORD_RESET_TTL_MINUTES = 30;
const PASSWORD_RESET_COOLDOWN_SECONDS = 60;
const EMAIL_VERIFICATION_TTL_HOURS = 24;
const GOOGLE_GIS_FLOW_COOKIE = 'kiur_google_gis_flow';
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 128;
const OAUTH_HANDOFF_TTL_SECONDS = 60;

// ─────────────────────────────────────────── helpers ────────────────────────

function domainAllowed(email: string, allowedDomains: string): boolean {
  if (!allowedDomains) return true;
  const domains = allowedDomains.split(',').map((d) => d.trim().toLowerCase());
  return domains.some((d) => email.toLowerCase().endsWith('@' + d));
}

function passwordPolicyError(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `كلمة المرور يجب أن تكون ${MIN_PASSWORD_LENGTH} أحرف على الأقل`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `كلمة المرور يجب ألا تتجاوز ${MAX_PASSWORD_LENGTH} حرفًا`;
  }
  return null;
}

function isVerifiedGoogleEmail(value: unknown): boolean {
  return value === true || value === 'true';
}

type EmailVerificationResult =
  | { ok: true; alreadyVerified: boolean }
  | { ok: false; detail: string };

async function completeEmailVerification(c: Context<AppEnv>, token: string): Promise<EmailVerificationResult> {
  const db = drizzle(c.env.DB, { schema });
  const tokenHash = await hashResetToken(token);
  const record = await db
    .select()
    .from(schema.emailVerifications)
    .where(eq(schema.emailVerifications.token_hash, tokenHash))
    .get();

  if (!record) return { ok: false, detail: 'رمز التحقق أو التوثيق غير صالح أو منتهي الصلاحية' };
  if (record.verified_at) return { ok: true, alreadyVerified: true };
  if (new Date(record.expires_at) < new Date()) return { ok: false, detail: 'رمز التحقق منتهي الصلاحية' };

  const now = new Date().toISOString();
  await db.batch([
    db.update(schema.emailVerifications).set({ verified_at: now }).where(eq(schema.emailVerifications.id, record.id)),
    db.update(schema.users).set({ email_verified_at: now }).where(eq(schema.users.id, record.user_id)),
  ]);
  await recordAccountEvent(db, {
    userId: record.user_id,
    eventType: 'email_verified',
    outcome: 'success',
    ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
    userAgent: c.req.header('user-agent'),
  });
  return { ok: true, alreadyVerified: false };
}

function userOut(user: typeof schema.users.$inferSelect) {
  const isStudent = !user.role || user.role === 'student';
  const profileComplete = !isStudent || Boolean(user.university_id && (user.is_graduate || user.stage_id));
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    profile_complete: profileComplete,
    photo_url: user.photo_url,
    caption: user.caption,
    phone: user.phone,
    section_id: user.section_id,
    university_id: user.university_id,
    college_id: user.college_id,
    department_id: user.department_id,
    stage_id: user.stage_id,
    study_section_id: user.study_section_id,
    is_graduate: user.is_graduate,
    is_banned: user.is_banned,
    totp_enabled: user.totp_enabled,
    theme: user.theme,
    language: user.language,
    firebase_uid: user.firebase_uid,
    email_verified_at: user.email_verified_at,
    created_at: user.created_at,
    password_changed_at: user.password_changed_at,
  };
}

// ─────────────────────────────────────────── Google OAuth ────────────────────

authRouter.get('/google/status', (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  const enabled = Boolean(clientId && clientId.trim() !== '' && !clientId.includes('your-client-id'));
  return c.json({ enabled, client_id: enabled ? clientId : null });
});

authRouter.get('/google/login', async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  const origin = new URL(c.req.url).origin;
  const redirectUri = c.env.GOOGLE_REDIRECT_URI || `${origin}/auth/google/callback`;
  const next = c.req.query('next') ?? '';
  const flow = next === 'admin' ? 'admin' : 'student';

  if (!clientId || clientId.trim() === '' || clientId.includes('your-client-id')) {
    const isHtml = (c.req.header('accept') || '').includes('text/html');
    if (isHtml) {
      return c.html(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>خدمة غير متاحة</title></head><body style="font-family:sans-serif;text-align:center;padding:50px;"><h2>خدمة المصادقة عبر Google غير مهيأة على الخادم (503)</h2><p>يرجى تهيئة بيانات Google OAuth الرسمية في إعدادات المنصة للمتابعة.</p></body></html>`, 503);
    }
    return c.json({ detail: 'خدمة المصادقة عبر Google غير مهيأة على الخادم' }, 503);
  }

  const stateNonce = crypto.randomUUID().replace(/-/g, '');
  const state = `${flow}:${stateNonce}`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });

  const isDebug = (c.env.DEBUG ?? 'false') === 'true';
  const secure = isDebug ? '' : '; Secure';
  c.header('Set-Cookie', `oauth_state=${state}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=300${secure}`);

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

authRouter.post('/google/login', async (c) => {
  return c.json({ detail: 'طريقة تسجيل الدخول غير مدعومة؛ يجب استخدام مصادقة Google الرسمية' }, 405);
});

authRouter.post('/google/flow', googleIdentityRateLimiter, async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId || clientId.includes('your-client-id')) {
    return c.json({ detail: 'خدمة المصادقة عبر Google غير مهيأة على الخادم' }, 503);
  }

  const nonce = crypto.randomUUID().replace(/-/g, '');
  const isDebug = (c.env.DEBUG ?? 'false') === 'true';
  const secure = isDebug ? '' : '; Secure';
  c.header(
    'Set-Cookie',
    `${GOOGLE_GIS_FLOW_COOKIE}=${nonce}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=300${secure}`,
  );
  return c.json({ flow_nonce: nonce, client_id: clientId });
});

authRouter.post('/google/verify', googleIdentityRateLimiter, async (c) => {
  const body = await c.req.json<{ credential?: string; access_token?: string; next?: string }>().catch(() => ({} as any));
  const credential = body.credential;
  const flow = body.next === 'admin' ? 'admin' : 'student';

  if (!credential) {
    return c.json({ detail: 'رمز Google ID الموقّع من Google Identity Services مفقود' }, 400);
  }

  const expectedAud = c.env.GOOGLE_CLIENT_ID?.trim();
  if (!expectedAud || expectedAud.includes('your-client-id')) {
    return c.json({ detail: 'خدمة المصادقة عبر Google غير مهيأة على الخادم' }, 503);
  }

  const cookieHeader = c.req.header('Cookie') ?? '';
  const nonceMatch = cookieHeader.match(new RegExp(`(?:^|; )${GOOGLE_GIS_FLOW_COOKIE}=([^;]+)`));
  const flowNonce = nonceMatch ? nonceMatch[1] : '';
  const isDebug = (c.env.DEBUG ?? 'false') === 'true';
  const secure = isDebug ? '' : '; Secure';
  // Consume the browser-bound nonce before token validation so a credential
  // cannot be replayed after any verification outcome.
  c.header(
    'Set-Cookie',
    `${GOOGLE_GIS_FLOW_COOKIE}=; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
  if (!flowNonce) {
    return c.json({ detail: 'جلسة Google غير صالحة أو منتهية الصلاحية' }, 403);
  }

  let email = '';
  let name = '';
  let sub = '';
  let picture = '';

  try {
    const identity = await verifyGoogleIdentityCredential(credential, expectedAud, flowNonce);
    email = identity.email;
    name = identity.name ?? '';
    sub = identity.subject;
    picture = identity.picture ?? '';
  } catch (error) {
    if (error instanceof GoogleIdentityError) {
      return c.json({ detail: error.message }, error.statusCode as 400 | 401 | 403);
    }
    return c.json({ detail: 'تعذر إكمال مصادقة Google حالياً' }, 503);
  }

  if (!domainAllowed(email, c.env.ALLOWED_UNIVERSITY_DOMAINS ?? '')) {
    return c.json({ detail: 'نطاق البريد الإلكتروني غير مسموح به في النظام' }, 403);
  }

  const db = drizzle(c.env.DB, { schema });
  let user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  if (user) {
    if (user.google_sub && user.google_sub !== sub) {
      return c.json({ detail: 'هذا الحساب مرتبط بحساب Google مختلف مسبقاً' }, 409);
    }
    if (user.role !== 'student' && !user.google_sub) {
      return c.json({ detail: 'الحسابات ذات الصلاحيات المرتفعة لا تقبل الربط التلقائي عبر Google. يرجى تسجيل الدخول بكلمة المرور والمصادقة الثنائية.' }, 403);
    }
    const patch: Partial<typeof schema.users.$inferInsert> = {};
    if (!user.google_sub && sub) patch.google_sub = sub;
    if (!user.photo_url && picture) patch.photo_url = picture;
    if (!user.email_verified_at) patch.email_verified_at = new Date().toISOString();
    if (Object.keys(patch).length > 0) {
      await db.update(schema.users).set(patch).where(eq(schema.users.id, user.id));
      user = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
    }
  } else {
    // SECURITY: Any new user always starts as student. The next/flow parameter can never grant admin!
    const role = 'student';
    const id = schema.genId();
    const now = new Date().toISOString();

    await db.insert(schema.users).values({
      id,
      email,
      full_name: name || email.split('@')[0],
      google_sub: sub || `google:${email}`,
      photo_url: picture || null,
      role,
      email_verified_at: now,
    });

    user = await db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  }

  if (!user) return c.json({ detail: 'فشل إنشاء حساب المستخدم' }, 500);
  if (user.is_banned) return c.json({ detail: 'هذا الحساب محظور' }, 403);

  const jwtSecret = c.env.JWT_SECRET;
  const expiresMinutes = parseInt(c.env.JWT_EXPIRES_MINUTES ?? '20160');
  if (user.totp_enabled) {
    const pending = await create2faPendingToken(user.id, jwtSecret);
    return c.json({ ok: true, requires_2fa: true, pending_token: pending });
  }

  const session = await startNewSession(db, user.id, 'متصفح Google');
  const token = await createAccessToken(user.id, session.id, jwtSecret, expiresMinutes);

  await recordAccountEvent(db, {
    userId: user.id,
    email: user.email,
    eventType: 'google_login',
    outcome: 'success',
    ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
    userAgent: c.req.header('user-agent'),
    details: { provider: 'google_gis', flow },
  });

  const res = c.json({ ok: true, access_token: token, user: userOut(user) });
  setSessionCookie(res, token, expiresMinutes, isDebug);
  return res;
});

authRouter.get('/google/callback', async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
  const origin = new URL(c.req.url).origin;
  const redirectUri = c.env.GOOGLE_REDIRECT_URI || `${origin}/auth/google/callback`;
  const code = c.req.query('code');
  const state = c.req.query('state') ?? '';
  const isAdminFlow = state === 'admin' || state.startsWith('admin:');
  const base = new URL(c.req.url).origin;
  const redirectBase = isAdminFlow ? (c.env.ADMIN_FRONTEND_URL || `${base}/admin`) : (c.env.FRONTEND_URL || base);

  if (!code) return c.json({ detail: 'كود التفويض مفقود' }, 400);
  if (!clientId || !clientSecret) return c.json({ detail: 'إعدادات Google OAuth غير مهيأة' }, 500);

  // Validate OAuth state against cookie (CSRF protection)
  const cookieHeader = c.req.header('Cookie') ?? '';
  const stateCookieMatch = cookieHeader.match(/(?:^|; )oauth_state=([^;]+)/);
  const expectedState = stateCookieMatch ? stateCookieMatch[1] : null;

  // Clear state cookie
  const isDebug = (c.env.DEBUG ?? 'false') === 'true';
  const secure = isDebug ? '' : '; Secure';
  c.header('Set-Cookie', `oauth_state=; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);

  if (!state || !expectedState || state !== expectedState) {
    return c.json({ detail: 'حالة OAuth غير صالحة أو منتهية الصلاحية (Invalid OAuth State / CSRF Detected)' }, 403);
  }

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });

  if (!tokenRes.ok) return c.json({ detail: 'فشل التحقق مع Google' }, 502);
  const tokenData = await tokenRes.json<{ access_token: string; id_token: string }>();

  // Get user info
  const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!userInfoRes.ok) return c.json({ detail: 'فشل الحصول على بيانات المستخدم' }, 502);
  const userInfo = await userInfoRes.json<{ email: string; name: string; sub: string; email_verified?: string | boolean; verified_email?: string | boolean }>();

  const { email, name, sub } = userInfo;
  if (!isVerifiedGoogleEmail(userInfo.email_verified) && !isVerifiedGoogleEmail(userInfo.verified_email)) {
    return c.redirect(`${redirectBase}#google_error=email_unverified`);
  }
  if (!domainAllowed(email, c.env.ALLOWED_UNIVERSITY_DOMAINS ?? '')) {
    return c.redirect(`${redirectBase}#google_error=domain`);
  }

  const db = drizzle(c.env.DB, { schema });

  // Find or create user
  let user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  if (user) {
    if (user.google_sub && user.google_sub !== sub) {
      return c.redirect(`${redirectBase}#google_error=conflict`);
    }
    if (user.role !== 'student' && !user.google_sub) {
      return c.redirect(`${redirectBase}#google_error=staff_link_required`);
    }
    const patch: Partial<typeof schema.users.$inferInsert> = {};
    if (!user.google_sub) patch.google_sub = sub;
    if (!user.email_verified_at) patch.email_verified_at = new Date().toISOString();
    if (Object.keys(patch).length > 0) {
      await db.update(schema.users).set(patch).where(eq(schema.users.id, user.id));
      user = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
    }
  } else {
    const role = 'student';
    const id = schema.genId();
    await db.insert(schema.users).values({ id, email, full_name: name, google_sub: sub, role, email_verified_at: new Date().toISOString() });
    user = await db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  }

  if (!user) return c.json({ detail: 'خطأ في إنشاء المستخدم' }, 500);

  if (isAdminFlow && !ADMIN_DASHBOARD_ROLES.has(user.role ?? '')) {
    return c.redirect(`${redirectBase}#google_error=role`);
  }

  const jwtSecret = c.env.JWT_SECRET;
  const expiresMinutes = parseInt(c.env.JWT_EXPIRES_MINUTES ?? '20160');

  if (user.totp_enabled) {
    const handoffToken = `oauth_handoff_${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
    await db.insert(schema.oauthHandoffs).values({
      token_hash: await hashResetToken(handoffToken),
      user_id: user.id,
      redirect_origin: new URL(redirectBase).origin.toLowerCase(),
      expires_at: new Date(Date.now() + OAUTH_HANDOFF_TTL_SECONDS * 1000).toISOString(),
    });
    return c.redirect(`${redirectBase}#oauth_handoff=${handoffToken}`);
  }

  const session = await startNewSession(db, user.id, 'متصفح');
  const token = await createAccessToken(user.id, session.id, jwtSecret, expiresMinutes);
  const handoffToken = `oauth_handoff_${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
  const handoffHash = await hashResetToken(handoffToken);
  const handoffOrigin = new URL(redirectBase).origin.toLowerCase();
  await db.insert(schema.oauthHandoffs).values({
    token_hash: handoffHash,
    session_id: session.id,
    redirect_origin: handoffOrigin,
    expires_at: new Date(Date.now() + OAUTH_HANDOFF_TTL_SECONDS * 1000).toISOString(),
  });
  // The fragment contains only a short-lived, single-use handoff code, never
  // the bearer token itself.  This preserves cross-origin dashboard support.
  const response = c.redirect(`${redirectBase}#oauth_handoff=${handoffToken}`);
  setSessionCookie(response, token, expiresMinutes, isDebug);
  return response;
});

authRouter.post('/oauth/handoff', oauthHandoffRateLimiter, async (c) => {
  const body = await c.req.json<{ code?: string }>().catch(() => ({} as { code?: string }));
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const origin = c.req.header('Origin')?.toLowerCase();
  if (!code || !origin) return c.json({ detail: 'رمز التسليم أو مصدر المتصفح مفقود' }, 400);

  const db = drizzle(c.env.DB, { schema });
  const handoff = await db.select().from(schema.oauthHandoffs)
    .where(eq(schema.oauthHandoffs.token_hash, await hashResetToken(code))).get();
  if (!handoff || handoff.consumed_at || new Date(handoff.expires_at) < new Date() || handoff.redirect_origin !== origin) {
    return c.json({ detail: 'رمز التسليم غير صالح أو منتهي الصلاحية' }, 401);
  }

  const consumed = await c.env.DB.prepare(
    'UPDATE oauth_handoffs SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?'
  ).bind(new Date().toISOString(), handoff.id, new Date().toISOString()).run();
  if (consumed.meta.changes !== 1) return c.json({ detail: 'رمز التسليم غير صالح أو مستهلك' }, 401);

  if (handoff.user_id) {
    const user = await db.select().from(schema.users).where(eq(schema.users.id, handoff.user_id)).get();
    if (!user || user.is_banned || !user.email_verified_at || !user.totp_enabled) {
      return c.json({ detail: 'الحساب غير متاح' }, 403);
    }
    const pendingToken = await create2faPendingToken(user.id, c.env.JWT_SECRET);
    return c.json({ requires_2fa: true, pending_token: pendingToken, user: userOut(user) });
  }

  if (!handoff.session_id) return c.json({ detail: 'رمز التسليم غير صالح' }, 401);
  const session = await db.select().from(schema.userSessions)
    .where(and(eq(schema.userSessions.id, handoff.session_id), eq(schema.userSessions.is_active, true))).get();
  if (!session) return c.json({ detail: 'الجلسة غير صالحة أو تم إنهاؤها' }, 401);
  const user = await db.select().from(schema.users).where(eq(schema.users.id, session.user_id)).get();
  if (!user || user.is_banned || !user.email_verified_at) return c.json({ detail: 'الحساب غير متاح' }, 403);

  const expiresMinutes = parseInt(c.env.JWT_EXPIRES_MINUTES ?? '20160');
  const accessToken = await createAccessToken(user.id, session.id, c.env.JWT_SECRET, expiresMinutes);
  return c.json({ access_token: accessToken, token_type: 'bearer', user: userOut(user) });
});

// ─────────────────────────────────────────── Firebase Google Sign-In (Stage A1) ──

authRouter.get('/firebase/status', (c) => {
  const projectId = c.env.FIREBASE_AUTH_PROJECT_ID?.trim();
  const apiKey = c.env.FIREBASE_WEB_API_KEY?.trim();
  const authDomain = c.env.FIREBASE_AUTH_DOMAIN?.trim() || (projectId ? `${projectId}.firebaseapp.com` : '');
  const appId = c.env.FIREBASE_WEB_APP_ID?.trim();
  const enabled = Boolean(projectId && apiKey && authDomain && appId);

  // Firebase web configuration is intentionally public. Trust is established
  // only by the signed ID token verified on /firebase/verify below.
  return c.json({
    enabled,
    config: enabled ? { apiKey, authDomain, projectId, appId } : null,
  });
});

authRouter.post('/firebase/flow', firebaseAuthRateLimiter, async (c) => {
  const projectId = c.env.FIREBASE_AUTH_PROJECT_ID?.trim();
  const apiKey = c.env.FIREBASE_WEB_API_KEY?.trim();
  if (!projectId || !apiKey) {
    return c.json({ detail: 'خدمة المصادقة عبر Google/Firebase غير مهيأة على الخادم' }, 503);
  }
  const isDebug = (c.env.DEBUG ?? 'false') === 'true';
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const secure = isDebug ? '' : '; Secure';

  c.header(
    'Set-Cookie',
    `kiur_firebase_flow=${nonce}; Path=/auth/firebase; HttpOnly; SameSite=Lax; Max-Age=300${secure}`
  );

  return c.json({
    flow_nonce: nonce,
    project_id: projectId,
  });
});

authRouter.post('/firebase/verify', firebaseAuthRateLimiter, async (c) => {
  const body = await c.req.json<{ idToken?: string; id_token?: string; nonce?: string; device_label?: string; next?: string }>().catch(() => ({} as Record<string, string>));
  const idToken = body?.idToken || (body as any)?.id_token;
  if (!idToken) {
    return c.json({ detail: 'رمز Firebase ID token مفقود' }, 400);
  }

  // 1. Flow cookie validation (replay and CSRF protection)
  const cookieHeader = c.req.header('Cookie') ?? '';
  const match = cookieHeader.match(/(?:^|; )kiur_firebase_flow=([^;]+)/);
  const flowCookie = match ? match[1] : null;

  if (!flowCookie || (body.nonce && flowCookie !== body.nonce)) {
    return c.json({ detail: 'جلسة تدفق Firebase غير صالحة أو منتهية الصلاحية' }, 400);
  }

  // Clear flow cookie immediately (consume once)
  const isDebug = (c.env.DEBUG ?? 'false') === 'true';
  const secure = isDebug ? '' : '; Secure';
  c.header(
    'Set-Cookie',
    `kiur_firebase_flow=; Path=/auth/firebase; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
  );

  // 2. Server-side token verification
  let fbUser;
  try {
    fbUser = await verifyFirebaseGoogleToken(c.env, idToken);
  } catch (err: any) {
    if (err instanceof FirebaseAuthError) {
      return c.json({ detail: err.message, code: err.code }, err.statusCode as any);
    }
    console.error(JSON.stringify({ event: 'FIREBASE_IDENTITY_VERIFICATION_FAILED', category: 'unexpected' }));
    return c.json({ detail: 'فشل التحقق من هوية Google' }, 500);
  }

  if (!domainAllowed(fbUser.email, c.env.ALLOWED_UNIVERSITY_DOMAINS ?? '')) {
    return c.json({ detail: 'نطاق البريد الإلكتروني غير مسموح به في النظام' }, 403);
  }

  const db = drizzle(c.env.DB, { schema });
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1';
  const userAgent = c.req.header('user-agent');

  // 3. User Resolution / Linkage
  let user = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.firebase_uid, fbUser.uid))
    .get();

  if (!user) {
    user = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, fbUser.email))
      .get();

    if (user) {
      // 1. Conflict Check: Reject if account is already linked to a different Firebase UID
      if (user.firebase_uid && user.firebase_uid !== fbUser.uid) {
        await recordAccountEvent(db, {
          userId: user.id,
          email: user.email,
          eventType: 'login_failure',
          outcome: 'failure',
          ip,
          userAgent,
          details: { reason: 'firebase_uid_conflict', provider: 'firebase_google' },
        });
        return c.json({ detail: 'هذا الحساب مرتبط بحساب Google/Firebase آخر مسبقاً' }, 409);
      }

      // 2. Elevated Role Check: Never silently auto-link unlinked elevated accounts
      // (Unless it is the bootstrap admin claim for BOOTSTRAP_ADMIN_EMAIL)
      const isBootstrapCandidate = Boolean(
        c.env.BOOTSTRAP_ADMIN_EMAIL &&
        fbUser.email.trim().toLowerCase() === c.env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase()
      );

      if (user.role !== 'student' && !user.firebase_uid && !isBootstrapCandidate) {
        await recordAccountEvent(db, {
          userId: user.id,
          email: user.email,
          eventType: 'login_failure',
          outcome: 'failure',
          ip,
          userAgent,
          details: { reason: 'elevated_role_link_rejected', provider: 'firebase_google' },
        });
        return c.json({ detail: 'الحسابات ذات الصلاحيات المرتفعة لا تقبل الربط التلقائي عبر تسجيل الدخول الخارجي. يرجى استخدام كلمة المرور والمصادقة الثنائية.' }, 403);
      }

      // Link existing user
      const patch: Partial<typeof schema.users.$inferInsert> = {
        firebase_uid: fbUser.uid,
        email_verified_at: user.email_verified_at || new Date().toISOString(),
      };
      if (!user.photo_url && fbUser.photoUrl) {
        patch.photo_url = fbUser.photoUrl;
      }
      await db
        .update(schema.users)
        .set(patch)
        .where(eq(schema.users.id, user.id));
      user = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
    }
  }

  // New user creation
  if (!user) {
    const role = 'student';

    const newId = schema.genId();
    await db.insert(schema.users).values({
      id: newId,
      email: fbUser.email,
      full_name: fbUser.name || 'طالب جديد',
      firebase_uid: fbUser.uid,
      photo_url: fbUser.photoUrl,
      role,
      email_verified_at: new Date().toISOString(),
    });

    user = (await db.select().from(schema.users).where(eq(schema.users.id, newId)).get())!;

    await recordAccountEvent(db, {
      userId: user.id,
      email: user.email,
      eventType: 'register',
      outcome: 'success',
      ip,
      userAgent,
      details: { provider: 'firebase_google' },
    });
  }

  // Only the explicitly configured, Firebase-verified owner can claim the
  // first admin role. The conditional DB update closes the bootstrap forever
  // once an administrator exists, including under concurrent sign-ins.
  const claimedBootstrapAdmin = await claimBootstrapAdmin(
    c.env.DB,
    user.id,
    fbUser.email,
    c.env.BOOTSTRAP_ADMIN_EMAIL,
  );
  if (claimedBootstrapAdmin) {
    user = (await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get())!;
    recordAuditEvent({
      event: 'ADMIN_ROLE_CHANGED',
      status: 'SUCCESS',
      actorId: user.id,
      targetId: user.id,
      ip,
      userAgent,
      details: { from: 'student', to: 'admin', reason: 'bootstrap_email_first_admin' },
    });
  }

  if (user.is_banned) {
    await recordAccountEvent(db, {
      userId: user.id,
      email: user.email,
      eventType: 'login_failure',
      outcome: 'failure',
      ip,
      userAgent,
      details: { reason: 'banned' },
    });
    return c.json({ detail: 'هذا الحساب محظور' }, 403);
  }

  // The administrator dashboard is a separate sign-in surface. Never issue a
  // session there for a student merely because that student owns a valid
  // Google account.
  const requiresStaffRole = body.next === 'admin';
  if (requiresStaffRole && !['admin', 'professor', 'reseller'].includes(user.role)) {
    await recordAccountEvent(db, {
      userId: user.id,
      email: user.email,
      eventType: 'login_failure',
      outcome: 'failure',
      ip,
      userAgent,
      details: { reason: 'staff_role_required', provider: 'firebase_google' },
    });
    return c.json({ detail: 'هذا الحساب لا يملك صلاحية الدخول إلى لوحة الإدارة' }, 403);
  }

  // Handle 2FA if enabled
  const jwtSecret = c.env.JWT_SECRET;
  if (user.totp_enabled) {
    const pendingToken = await create2faPendingToken(user.id, jwtSecret);
    return c.json({
      requires_2fa: true,
      pending_token: pendingToken,
      user_id: user.id,
    });
  }

  const expiresMinutes = parseInt(c.env.JWT_EXPIRES_MINUTES ?? '20160');
  const deviceLabel = (body.device_label || c.req.header('user-agent') || 'متصفح').slice(0, 50);
  const session = await startNewSession(db, user.id, deviceLabel);
  const token = await createAccessToken(user.id, session.id, jwtSecret, expiresMinutes);

  await recordAccountEvent(db, {
    userId: user.id,
    email: user.email,
    eventType: 'google_login',
    outcome: 'success',
    ip,
    userAgent,
    details: { provider: 'firebase_google' },
  });

  const response = c.json({
    access_token: token,
    token_type: 'bearer',
    user: userOut(user),
  });

  setSessionCookie(response, token, expiresMinutes, isDebug);
  return response;
});

// ─────────────────────────────────────────── Dev login ───────────────────────

authRouter.post('/dev-login', async (c) => {
  if ((c.env.DEBUG ?? 'false') !== 'true') return c.json(null, 404);

  const email = c.req.query('email') ?? '';
  const name = c.req.query('name') ?? 'طالب تجريبي';
  if (!email) return c.json({ detail: 'email مطلوب' }, 400);

  const db = drizzle(c.env.DB, { schema });
  let user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  if (!user) {
    const role = 'student';
    const id = schema.genId();
    await db.insert(schema.users).values({ id, email, full_name: name, google_sub: `dev:${email}`, role });
    user = await db.select().from(schema.users).where(eq(schema.users.id, id)).get()!;
  }

  const jwtSecret = c.env.JWT_SECRET;
  const expiresMinutes = parseInt(c.env.JWT_EXPIRES_MINUTES ?? '20160');
  const isDebug = true;
  const session = await startNewSession(db, user!.id, 'جهاز تطوير');
  const token = await createAccessToken(user!.id, session.id, jwtSecret, expiresMinutes);

  const response = c.json({ access_token: token, user: userOut(user!) });
  setSessionCookie(response, token, expiresMinutes, isDebug);
  return response;
});

// ─────────────────────────────────────────── Register ────────────────────────

authRouter.post('/register', registerRateLimiter, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{
    email: string;
    password?: string;
    full_name?: string;
    role?: string;
    device_label?: string;
    university_id?: string;
    stage_id?: string;
    section_id?: string;
    phone?: string;
  }>().catch(() => ({} as any));
  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';
  const fullName = (body.full_name ?? '').trim();

  if (!email || !password || !fullName) return c.json({ detail: 'جميع الحقول مطلوبة' }, 400);
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return c.json({ detail: 'صيغة البريد الإلكتروني غير صالحة' }, 400);
  if (!domainAllowed(email, c.env.ALLOWED_UNIVERSITY_DOMAINS ?? '')) return c.json({ detail: 'الرجاء التسجيل ببريدك الجامعي الرسمي' }, 403);
  const passwordError = passwordPolicyError(password);
  if (passwordError) return c.json({ detail: passwordError }, 400);

  const mailerConfig = { smtpHost: c.env.SMTP_HOST, smtpUser: c.env.SMTP_USER, smtpPassword: c.env.SMTP_PASSWORD, smtpFrom: c.env.SMTP_FROM, smtpFromName: c.env.SMTP_FROM_NAME };
  if ((c.env.DEBUG ?? 'false') !== 'true' && !emailConfigured(mailerConfig)) {
    return c.json({ detail: 'التسجيل غير متاح مؤقتاً لأن خدمة توثيق البريد غير مهيأة' }, 503);
  }

  const existing = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  if (existing) return c.json({ detail: 'البريد الإلكتروني مسجل بالفعل' }, 400);

  // Public registration is intentionally roleless: privileged roles are
  // granted only by an authenticated server-side administrator workflow.
  const role = 'student';

  const id = schema.genId();
  const passwordHash = await hashPassword(password);
  await db.insert(schema.users).values({
    id,
    email,
    full_name: fullName,
    password_hash: passwordHash,
    role,
    university_id: body.university_id ?? null,
    stage_id: body.stage_id ?? null,
    section_id: body.section_id ?? null,
    phone: body.phone ?? null,
  });

  const user = await db.select().from(schema.users).where(eq(schema.users.id, id)).get();

  recordAuditEvent({
    event: 'AUTH_REGISTER_SUCCESS',
    status: 'SUCCESS',
    actorId: user!.id,
    ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
    userAgent: c.req.header('user-agent'),
    details: { email, role },
  });

  // Generate verification token and save to email_verifications table
  const rawVerificationToken = generateResetToken();
  const verificationHash = await hashResetToken(rawVerificationToken);
  const verifExpires = new Date(Date.now() + EMAIL_VERIFICATION_TTL_HOURS * 3600000).toISOString();
  await db.insert(schema.emailVerifications).values({
    id: schema.genId(),
    user_id: user!.id,
    token_hash: verificationHash,
    expires_at: verifExpires,
  });
  if (emailConfigured(mailerConfig)) c.executionCtx.waitUntil(sendEmailVerification(mailerConfig, email, `${new URL(c.req.url).origin}/auth/verify-email?token=${encodeURIComponent(rawVerificationToken)}`));

  await recordAccountEvent(db, {
    userId: user!.id,
    email: user!.email,
    eventType: 'register',
    outcome: 'success',
    ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
    userAgent: c.req.header('user-agent'),
    details: { role },
  });

  return c.json({
    ok: true,
    requires_email_verification: true,
    user_id: user!.id,
    role: user!.role,
    message: 'تم إنشاء الحساب. يرجى توثيق بريدك الإلكتروني قبل تسجيل الدخول.',
  });
});

// ─────────────────────────────────────────── Email Verification (Stage A2) ──

authRouter.post('/verify-email', verifyEmailRateLimiter, async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({} as Record<string, string>));
  const token = (body?.token ?? '').trim();
  if (!token) return c.json({ detail: 'رمز التوثيق مطلوب' }, 400);
  const result = await completeEmailVerification(c, token);
  if (!result.ok) return c.json({ detail: result.detail }, 400);
  return c.json({
    ok: true,
    message: result.alreadyVerified ? 'البريد الإلكتروني موثق مسبقاً' : 'تم توثيق البريد الإلكتروني بنجاح',
    ...(result.alreadyVerified ? { already_verified: true } : {}),
  });
});

authRouter.get('/verify-email', async (c) => {
  const token = c.req.query('token')?.trim();
  if (!token) return c.redirect('/#email_verification_failed=1');
  const result = await completeEmailVerification(c, token);
  return c.redirect(result.ok ? '/#email_verified=1' : '/#email_verification_failed=1');
});

authRouter.post('/resend-verification', resendVerificationRateLimiter, async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => ({} as Record<string, string>));
  const email = (body?.email ?? '').trim().toLowerCase();
  if (!email) return c.json({ detail: 'البريد الإلكتروني مطلوب' }, 400);

  const db = drizzle(c.env.DB, { schema });
  const user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();

  if (user && !user.email_verified_at) {
    // Invalidate prior unverified tokens
    await db
      .delete(schema.emailVerifications)
      .where(and(
        eq(schema.emailVerifications.user_id, user.id),
        isNull(schema.emailVerifications.verified_at)
      ));

    const rawVerificationToken = generateResetToken();
    const verificationHash = await hashResetToken(rawVerificationToken);
    const verifExpires = new Date(Date.now() + EMAIL_VERIFICATION_TTL_HOURS * 3600000).toISOString();
    await db.insert(schema.emailVerifications).values({
      id: schema.genId(),
      user_id: user.id,
      token_hash: verificationHash,
      expires_at: verifExpires,
    });
    const mailerConfig = { smtpHost: c.env.SMTP_HOST, smtpUser: c.env.SMTP_USER, smtpPassword: c.env.SMTP_PASSWORD, smtpFrom: c.env.SMTP_FROM, smtpFromName: c.env.SMTP_FROM_NAME };
    if (emailConfigured(mailerConfig)) c.executionCtx.waitUntil(sendEmailVerification(mailerConfig, user.email, `${new URL(c.req.url).origin}/auth/verify-email?token=${encodeURIComponent(rawVerificationToken)}`));

    await recordAccountEvent(db, {
      userId: user.id,
      email: user.email,
      eventType: 'verification_resent',
      outcome: 'success',
      ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
      userAgent: c.req.header('user-agent'),
    });
  }

  // Account enumeration defense: Return identical response whether email exists or not
  return c.json({
    ok: true,
    message: 'إذا كان البريد مسجلاً ولم يتم توثيقه بعد، فستصله رسالة توثيق جديدة',
  });
});

// ─────────────────────────────────────────── Login ───────────────────────────

authRouter.post('/login', loginRateLimiter, async (c) => {
  const body = await c.req.json<{ email?: string; password?: string; device_label?: string }>().catch(() => ({} as any));
  if (!body || !body.email || !body.password) {
    return c.json({ detail: 'البريد الإلكتروني وكلمة المرور مطلوبان' }, 400);
  }
  const email = (body.email ?? '').trim().toLowerCase();
  const db = drizzle(c.env.DB, { schema });

  const user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();

  if (user?.locked_until) {
    const lockedUntil = new Date(user.locked_until);
    if (lockedUntil > new Date()) {
      const minutesLeft = Math.max(1, Math.floor((lockedUntil.getTime() - Date.now()) / 60000) + 1);
      recordAuditEvent({
        event: 'AUTH_ACCOUNT_LOCKED',
        status: 'LOCKED',
        actorId: user.id,
        ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
        details: { email, minutesLeft },
      });
      return c.json({ detail: `تم قفل الحساب مؤقتاً بسبب محاولات دخول فاشلة متكررة — حاول بعد ${minutesLeft} دقيقة` }, 429);
    }
  }

  const passwordValid = user ? await verifyPassword(body.password, user.password_hash) : false;
  if (!user || !passwordValid) {
    if (user) {
      const attempts = (user.failed_login_attempts ?? 0) + 1;
      if (attempts >= MAX_FAILED_ATTEMPTS) {
        const lockUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString();
        await db.update(schema.users).set({ failed_login_attempts: attempts, locked_until: lockUntil }).where(eq(schema.users.id, user.id));
        recordAuditEvent({
          event: 'AUTH_ACCOUNT_LOCKED',
          status: 'LOCKED',
          actorId: user.id,
          ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
          details: { email, reason: 'max_failed_attempts_reached' },
        });
        return c.json({ detail: 'تم قفل الحساب مؤقتاً لكثرة المحاولات الفاشلة' }, 429);
      } else {
        await db.update(schema.users).set({ failed_login_attempts: attempts }).where(eq(schema.users.id, user.id));
      }
    }
    recordAuditEvent({
      event: 'AUTH_LOGIN_FAILED',
      status: 'FAILURE',
      actorId: user?.id ?? null,
      ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
      details: { email, reason: 'invalid_credentials' },
    });
    return c.json({ detail: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' }, 401);
  }

  if (user.is_banned) {
    recordAuditEvent({
      event: 'AUTH_LOGIN_FAILED',
      status: 'DENIED',
      actorId: user.id,
      ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
      details: { email, reason: 'user_is_banned' },
    });
    return c.json({ detail: 'هذا الحساب محظور' }, 403);
  }

  if (!user.email_verified_at) {
    return c.json({ detail: 'يرجى توثيق بريدك الإلكتروني قبل تسجيل الدخول' }, 403);
  }

  // Clear failed attempts
  if (user.failed_login_attempts || user.locked_until) {
    await db.update(schema.users).set({ failed_login_attempts: 0, locked_until: null }).where(eq(schema.users.id, user.id));
  }

  const jwtSecret = c.env.JWT_SECRET;

  // 2FA check
  if (user.totp_enabled) {
    const pending = await create2faPendingToken(user.id, jwtSecret);
    return c.json({ requires_2fa: true, pending_token: pending });
  }

  const expiresMinutes = parseInt(c.env.JWT_EXPIRES_MINUTES ?? '20160');
  const isDebug = (c.env.DEBUG ?? 'false') === 'true';
  const session = await startNewSession(db, user.id, body.device_label || 'متصفح');
  const token = await createAccessToken(user.id, session.id, jwtSecret, expiresMinutes);

  recordAuditEvent({
    event: 'AUTH_LOGIN_SUCCESS',
    status: 'SUCCESS',
    actorId: user.id,
    ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
    userAgent: c.req.header('user-agent'),
    details: { email },
  });

  const response = c.json({
    access_token: token,
    token_type: 'bearer',
    user_id: user.id,
    role: user.role,
    user: userOut(user!),
  });
  setSessionCookie(response, token, expiresMinutes, isDebug);
  return response;
});

// ─────────────────────────────────────────── Logout ──────────────────────────

authRouter.post('/logout', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const session = c.get('session')!;

  await db.update(schema.userSessions).set({ is_active: false }).where(eq(schema.userSessions.user_id, user.id));

  recordAuditEvent({
    event: 'AUTH_LOGOUT',
    status: 'SUCCESS',
    actorId: user.id,
    ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
    details: { sessionId: session.id },
  });

  const response = c.json({ ok: true });
  clearSessionCookie(response, (c.env.DEBUG ?? 'false') === 'true');
  return response;
});

// ─────────────────────────────────────────── 2FA ─────────────────────────────

authRouter.post('/2fa/setup', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const dbUser = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
  if (dbUser?.totp_enabled) {
    return c.json({
      detail: 'المصادقة الثنائية مفعلة بالفعل على هذا الحساب. يجب تعطيلها أولاً عبر رمز التحقق الحالي قبل إعادة الإعداد.',
    }, 400);
  }
  const secret = await generateTotpSecret();
  await db.update(schema.users).set({ totp_secret: secret }).where(eq(schema.users.id, user.id));
  const uri = `otpauth://totp/Nabd:${user.email}?secret=${secret}&issuer=Nabd`;
  return c.json({
    secret,
    uri,
    otpauth_uri: uri,
    qr_code: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"></svg>',
  });
});

authRouter.post('/2fa/verify', twoFaVerifyRateLimiter, async (c) => {
  const body = await c.req.json<{ pending_token?: string; code: string }>().catch(() => ({} as any));
  if (!body || !body.code) return c.json({ detail: 'رمز التحقق مطلوب' }, 400);

  const authHeader = c.req.header('Authorization');
  const db = drizzle(c.env.DB, { schema });
  const jwtSecret = c.env.JWT_SECRET;

  // Case 1: Authenticated user enabling 2FA on their own account
  if (authHeader && authHeader.startsWith('Bearer ') && !body.pending_token) {
    const token = authHeader.substring(7).trim();
    const authResult = await authenticateToken(db, token, jwtSecret);
    if (!authResult.success) {
      return c.json({ detail: authResult.detail }, authResult.status);
    }
    const dbUser = await db.select().from(schema.users).where(eq(schema.users.id, authResult.user.id)).get();
    if (!dbUser) return c.json({ detail: 'المستخدم غير موجود' }, 404);
    if (dbUser.totp_enabled) {
      return c.json({ detail: 'المصادقة الثنائية مفعلة بالفعل على هذا الحساب' }, 400);
    }
    if (!dbUser.totp_secret) return c.json({ detail: 'لم يتم تهيئة المصادقة الثنائية' }, 400);

    const valid = await verifyTotp(dbUser.totp_secret, body.code);
    if (!valid) return c.json({ detail: 'رمز التحقق غير صحيح' }, 400);

    await db.update(schema.users).set({ totp_enabled: true }).where(eq(schema.users.id, dbUser.id));
    recordAuditEvent({ event: 'AUTH_2FA_ENABLED', status: 'SUCCESS', actorId: dbUser.id });
    return c.json({ ok: true, message: 'تم تفعيل المصادقة الثنائية بنجاح' });
  }

  // Case 2: Unauthenticated 2FA Login challenge with pending_token
  if (!body.pending_token) {
    return c.json({ detail: 'رمز التحقق المؤقت مطلوب' }, 400);
  }

  const userId = await decode2faPendingToken(body.pending_token, jwtSecret);
  if (!userId) return c.json({ detail: 'انتهت صلاحية الجلسة المؤقتة — سجّل الدخول من جديد' }, 401);

  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user || !user.totp_enabled) return c.json({ detail: 'جلسة غير صالحة' }, 401);
  if (user.is_banned) return c.json({ detail: 'هذا الحساب محظور' }, 403);
  if (!user.email_verified_at) return c.json({ detail: 'يرجى توثيق بريدك الإلكتروني قبل تسجيل الدخول' }, 403);

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutesLeft = Math.max(1, Math.floor((new Date(user.locked_until).getTime() - Date.now()) / 60000) + 1);
    return c.json({ detail: `تم قفل الحساب مؤقتاً — حاول بعد ${minutesLeft} دقيقة` }, 429);
  }

  const valid = await verifyTotp(user.totp_secret ?? '', body.code);
  if (!valid) {
    const attempts = (user.failed_login_attempts ?? 0) + 1;
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      await db.update(schema.users).set({ failed_login_attempts: 0, locked_until: new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString() }).where(eq(schema.users.id, userId));
      recordAuditEvent({ event: 'AUTH_ACCOUNT_LOCKED', status: 'LOCKED', actorId: user.id, details: { reason: '2fa_max_attempts' } });
    } else {
      await db.update(schema.users).set({ failed_login_attempts: attempts }).where(eq(schema.users.id, userId));
    }
    return c.json({ detail: 'رمز التحقق غير صحيح' }, 400);
  }

  await db.update(schema.users).set({ failed_login_attempts: 0, locked_until: null }).where(eq(schema.users.id, userId));
  const expiresMinutes = parseInt(c.env.JWT_EXPIRES_MINUTES ?? '20160');
  const isDebug = (c.env.DEBUG ?? 'false') === 'true';
  const session = await startNewSession(db, user.id, 'متصفح');
  const token = await createAccessToken(user.id, session.id, jwtSecret, expiresMinutes);

  recordAuditEvent({ event: 'AUTH_2FA_VERIFIED', status: 'SUCCESS', actorId: user.id });

  const response = c.json({
    access_token: token,
    token_type: 'bearer',
    user_id: user.id,
    role: user.role,
    user: userOut(user),
  });
  setSessionCookie(response, token, expiresMinutes, isDebug);
  return response;
});

authRouter.post('/2fa/login', twoFaVerifyRateLimiter, async (c) => {
  const body = await c.req.json<{ pending_token: string; code: string; device_label?: string }>().catch(() => ({} as any));
  if (!body || !body.pending_token || !body.code) {
    return c.json({ detail: 'الرمز المؤقت ورمز التحقق مطلوبان' }, 400);
  }

  const jwtSecret = c.env.JWT_SECRET;
  const userId = await decode2faPendingToken(body.pending_token, jwtSecret);
  if (!userId) return c.json({ detail: 'رمز التحقق المؤقت غير صالح' }, 401);

  const db = drizzle(c.env.DB, { schema });
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user || !user.totp_enabled || !user.totp_secret) return c.json({ detail: 'المستخدم غير صالح' }, 400);
  if (user.is_banned) return c.json({ detail: 'هذا الحساب محظور' }, 403);
  if (!user.email_verified_at) return c.json({ detail: 'يرجى توثيق بريدك الإلكتروني قبل تسجيل الدخول' }, 403);

  const valid = await verifyTotp(user.totp_secret, body.code);
  if (!valid) return c.json({ detail: 'رمز التحقق غير صحيح' }, 400);

  const expiresMinutes = parseInt(c.env.JWT_EXPIRES_MINUTES ?? '20160');
  const isDebug = (c.env.DEBUG ?? 'false') === 'true';
  const session = await startNewSession(db, user.id, body.device_label || 'جهاز موثق');
  const token = await createAccessToken(user.id, session.id, jwtSecret, expiresMinutes);

  const response = c.json({
    access_token: token,
    token_type: 'bearer',
    user_id: user.id,
    role: user.role,
    user: userOut(user),
  });
  setSessionCookie(response, token, expiresMinutes, isDebug);
  return response;
});

authRouter.post('/2fa/enable', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;
  const body = await c.req.json<{ code: string }>().catch(() => ({} as any));
  if (!body || !body.code) return c.json({ detail: 'رمز التحقق مطلوب' }, 400);

  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (user?.totp_enabled) return c.json({ detail: 'المصادقة الثنائية مفعلة بالفعل على هذا الحساب' }, 400);
  if (!user?.totp_secret) return c.json({ detail: 'لم يتم تهيئة المصادقة الثنائية' }, 400);
  if (!(await verifyTotp(user.totp_secret, body.code))) return c.json({ detail: 'رمز التحقق غير صحيح' }, 400);

  await db.update(schema.users).set({ totp_enabled: true }).where(eq(schema.users.id, userId));
  recordAuditEvent({ event: 'AUTH_2FA_ENABLED', status: 'SUCCESS', actorId: userId });
  return c.json({ ok: true, message: 'تم تفعيل المصادقة الثنائية بنجاح' });
});

authRouter.post('/2fa/disable', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;
  const body = await c.req.json<{ code: string }>().catch(() => ({} as any));
  if (!body || !body.code) return c.json({ detail: 'رمز التحقق مطلوب' }, 400);

  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user?.totp_enabled) return c.json({ detail: 'المصادقة الثنائية غير مفعلة' }, 400);
  if (!(await verifyTotp(user.totp_secret ?? '', body.code))) return c.json({ detail: 'رمز التحقق غير صحيح' }, 403);

  await db.update(schema.users).set({ totp_enabled: false, totp_secret: null }).where(eq(schema.users.id, userId));
  recordAuditEvent({ event: 'AUTH_2FA_DISABLED', status: 'SUCCESS', actorId: userId });
  return c.json({ ok: true, message: 'تم تعطيل المصادقة الثنائية بنجاح' });
});


// ─────────────────────────────────────────── /me endpoints ───────────────────

authRouter.put('/me', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;
  const user = c.get('user')!;
  const body = await c.req.json<{
    full_name?: string;
    phone?: string;
    caption?: string;
    photo_url?: string;
    theme?: string;
    language?: string;
    university_id?: string;
    stage_id?: string;
    section_id?: string;
    is_graduate?: boolean;
  }>().catch(() => ({} as any));

  const updates: Partial<typeof schema.users.$inferInsert> = {};
  if (body.full_name !== undefined) updates.full_name = body.full_name;
  if (body.phone !== undefined) updates.phone = body.phone;
  if (body.caption !== undefined) updates.caption = body.caption;
  if (body.photo_url !== undefined) updates.photo_url = body.photo_url;
  if (body.theme !== undefined) updates.theme = body.theme;
  if (body.language !== undefined) updates.language = body.language;
  if (body.university_id !== undefined) updates.university_id = body.university_id;
  if (body.stage_id !== undefined) updates.stage_id = body.stage_id;
  if (body.section_id !== undefined) updates.section_id = body.section_id;
  if (body.is_graduate !== undefined) updates.is_graduate = body.is_graduate;

  if (Object.keys(updates).length > 0) {
    await db.update(schema.users).set(updates).where(eq(schema.users.id, userId));
  }

  const updatedUser = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  return c.json({
    message: 'تم تحديث الملف الشخصي',
    full_name: updatedUser?.full_name,
    phone: updatedUser?.phone,
    caption: updatedUser?.caption,
    photo_url: updatedUser?.photo_url,
    theme: updatedUser?.theme || 'light',
    language: updatedUser?.language || 'ar',
    user: updatedUser ? userOut(updatedUser) : null,
  });
});

authRouter.get('/stats', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;

  const answers = await db.select().from(schema.studentAnswers).where(eq(schema.studentAnswers.user_id, user.id));
  const answeredCount = answers.length;
  const correctCount = answers.filter((a) => a.is_correct).length;
  const accuracy = answeredCount > 0 ? Math.round((correctCount / answeredCount) * 100) : 0;
  const streak = await streakDays(db, user.id);

  return c.json({
    answered_count: answeredCount,
    correct_count: correctCount,
    accuracy,
    streak_days: streak,
  });
});

// ─────────────────────────────────────────── /me endpoints ───────────────────

authRouter.get('/me', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = await db.select().from(schema.users).where(eq(schema.users.id, c.get('user')!.id)).get();
  return c.json(user ? userOut(user!) : null);
});

authRouter.put('/me/profile', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;
  const body = await c.req.json<{
    full_name?: string; phone?: string;
    section_id?: string; university_id: string;
    college_id?: string; department_id?: string;
    stage_id?: string; study_section_id?: string;
    is_graduate?: boolean;
  }>();

  const existingUser = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  const fullName = (body.full_name?.trim()) || existingUser?.full_name || 'طالب';
  if (!fullName.trim()) return c.json({ detail: 'الاسم الكامل مطلوب' }, 400);

  if (!body.university_id) {
    return c.json({ detail: 'الجامعة مطلوبة' }, 400);
  }

  const uni = await db.select().from(schema.universities).where(eq(schema.universities.id, body.university_id)).get();
  if (!uni) return c.json({ detail: 'الجامعة المختارة غير موجودة' }, 400);

  // 1. Determine college vs section
  let effectiveCollegeId: string | null = null;
  let effectiveSectionId: string | null = uni.section_id || null;

  const targetCollegeId = body.college_id || body.section_id;
  if (targetCollegeId) {
    const col = await db.select().from(schema.colleges).where(eq(schema.colleges.id, targetCollegeId)).get();
    if (col) {
      // Validate that university offers this college (via collegePrograms or stages)
      const prog = await db.select().from(schema.collegePrograms).where(
        and(eq(schema.collegePrograms.university_id, uni.id), eq(schema.collegePrograms.college_id, col.id))
      ).get();
      const stgInCol = await db.select({ id: schema.stages.id }).from(schema.stages).where(
        and(eq(schema.stages.university_id, uni.id), eq(schema.stages.college_id, col.id))
      ).get();

      if (!prog && !stgInCol) {
        return c.json({ detail: 'الجامعة المختارة لا تتبع الكلية المختارة' }, 400);
      }
      effectiveCollegeId = col.id;
    }
  }

  // If section_id was explicitly provided and is a traditional section in sections table
  if (body.section_id && !effectiveCollegeId) {
    const sec = await db.select().from(schema.sections).where(eq(schema.sections.id, body.section_id)).get();
    if (sec) {
      if (uni.section_id && uni.section_id !== sec.id) {
        return c.json({ detail: 'الجامعة المختارة لا تتبع القسم المختار' }, 400);
      }
      effectiveSectionId = sec.id;
    }
  }

  // 2. Department validation (if chosen)
  if (body.department_id) {
    const dept = await db.select().from(schema.departments).where(eq(schema.departments.id, body.department_id)).get();
    if (!dept) {
      return c.json({ detail: 'القسم الطبي المختار غير موجود' }, 400);
    }
    if (effectiveCollegeId && dept.college_id && dept.college_id !== effectiveCollegeId) {
      return c.json({ detail: 'القسم المختار لا يتبع الكلية المختارة' }, 400);
    }
  }

  // 3. Stage validation
  let stageId: string | null = null;
  if (!body.is_graduate) {
    if (!body.stage_id) return c.json({ detail: 'المرحلة الدراسية مطلوبة للطلاب غير المتخرجين' }, 400);
    const stage = await db.select().from(schema.stages).where(eq(schema.stages.id, body.stage_id)).get();
    if (!stage) return c.json({ detail: 'المرحلة المختارة غير موجودة' }, 400);
    if (stage.university_id && stage.university_id !== body.university_id) {
      return c.json({ detail: 'المرحلة المختارة لا تتبع الجامعة المختارة' }, 400);
    }
    if (body.department_id && stage.department_id && stage.department_id !== body.department_id) {
      return c.json({ detail: 'المرحلة المختارة لا تتبع القسم المختار' }, 400);
    }
    if (effectiveCollegeId && stage.college_id && stage.college_id !== effectiveCollegeId) {
      return c.json({ detail: 'المرحلة المختارة لا تتبع الكلية المختارة' }, 400);
    }
    stageId = body.stage_id;
  }

  // 4. Study Section validation
  let studySectionId: string | null = null;
  if (!body.is_graduate && body.study_section_id) {
    const sSec = await db.select().from(schema.studySections).where(eq(schema.studySections.id, body.study_section_id)).get();
    if (sSec && stageId && sSec.stage_id === stageId) {
      studySectionId = sSec.id;
    }
  }

  await db.update(schema.users).set({
    full_name: fullName,
    phone: body.phone !== undefined ? (body.phone?.trim() || null) : undefined,
    section_id: effectiveSectionId,
    university_id: body.university_id,
    college_id: effectiveCollegeId,
    department_id: body.department_id || null,
    is_graduate: body.is_graduate ?? false,
    stage_id: stageId,
    study_section_id: studySectionId,
  }).where(eq(schema.users.id, userId));

  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  return c.json(userOut(user!));
});

authRouter.put('/me/caption', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;
  const body = await c.req.json<{ caption: string }>();
  await db.update(schema.users).set({ caption: (body.caption ?? '').trim().slice(0, 200) }).where(eq(schema.users.id, userId));
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  return c.json(userOut(user!));
});

authRouter.put('/me/preferences', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;
  const body = await c.req.json<{ theme?: string; language?: string }>();

  if (body.theme !== undefined && !['light', 'dark'].includes(body.theme)) return c.json({ detail: 'قيمة المظهر غير صالحة' }, 400);
  if (body.language !== undefined && !['ar', 'en', 'ku'].includes(body.language)) return c.json({ detail: 'قيمة اللغة غير صالحة' }, 400);

  const updates: Record<string, unknown> = {};
  if (body.theme !== undefined) updates.theme = body.theme;
  if (body.language !== undefined) updates.language = body.language;
  if (Object.keys(updates).length > 0) await db.update(schema.users).set(updates).where(eq(schema.users.id, userId));

  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  return c.json(userOut(user!));
});

authRouter.post('/me/photo', requireAuth, async (c) => {
  if (!isStorageConfigured(c.env.R2_BUCKET)) {
    return c.json({ detail: 'خدمة رفع الملفات غير مهيأة حالياً' }, 503);
  }
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  if (!file) return c.json({ detail: 'الملف مطلوب' }, 400);

  const contents = await file.arrayBuffer();
  if (contents.byteLength > MAX_UPLOAD_BYTES) return c.json({ detail: 'الملف أكبر من الحد المسموح (20 ميغابايت)' }, 400);

  const sig = validateFileSignature(contents, IMAGE_EXTS);
  if (!sig.valid) {
    return c.json({ detail: 'توقيع الملف أو نوعه الداخلي غير صالح' }, 400);
  }

  const detectedExt = sig.detectedExt === 'jpg' ? 'jpeg' : (sig.detectedExt || 'jpeg');
  const mimeType = `image/${detectedExt}`;

  const storage = createStorageService(c.env.R2_BUCKET);
  const storedName = safeUploadNameForDetectedType(sig.detectedExt, IMAGE_EXTS, 'photo');
  await storage.save(storedName, contents, mimeType);

  const photoUrl = mediaUrl(storedName);
  try {
    await db.insert(schema.mediaFiles).values({
      id: schema.genId(),
      filename: storedName,
      url: photoUrl,
      content_type: mimeType,
      size_bytes: contents.byteLength,
      uploaded_by: userId,
      is_deleted: false,
    });
  } catch (_) {}

  await db.update(schema.users).set({ photo_url: photoUrl }).where(eq(schema.users.id, userId));
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  return c.json(userOut(user!));
});

// ─────────────────────────────────────────── Skills ──────────────────────────

authRouter.get('/me/skills', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const skills = await db.select().from(schema.userSkills).where(eq(schema.userSkills.user_id, c.get('user')!.id));
  return c.json(skills.map((s) => ({ id: s.id, text: s.text })));
});

authRouter.post('/me/skills', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;
  const body = await c.req.json<{ text: string }>();
  const rawText = String(body.text ?? '').trim();
  if (!rawText) return c.json({ detail: 'اكتب مهارة قبل الإضافة' }, 400);

  // Stored XSS defense: disallow HTML tags and script vectors
  if (/<[^>]*>|[<>"']|javascript:/i.test(rawText)) {
    return c.json({ detail: 'النص يحتوي على أحرف أو وسوم غير مسموح بها' }, 400);
  }

  const text = rawText.slice(0, 40);

  const count = (await db.select().from(schema.userSkills).where(eq(schema.userSkills.user_id, userId))).length;
  if (count >= 12) return c.json({ detail: 'الحد الأقصى 12 مهارة' }, 400);

  const id = schema.genId();
  await db.insert(schema.userSkills).values({ id, user_id: userId, text });
  return c.json({ id, text });
});

authRouter.delete('/me/skills/:skill_id', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;
  const skillId = c.req.param('skill_id') ?? '';

  const skill = await db.select().from(schema.userSkills).where(eq(schema.userSkills.id, skillId)).get();
  if (!skill || skill.user_id !== userId) return c.json({ detail: 'المهارة غير موجودة' }, 404);

  await db.delete(schema.userSkills).where(eq(schema.userSkills.id, skillId));
  return c.json({ ok: true });
});

// ─────────────────────────────────────────── Recent views ────────────────────

authRouter.post('/me/recent-view', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;
  const body = await c.req.json<{ content_type: string; content_id: string }>();

  if (!['booklet', 'lecture'].includes(body.content_type)) return c.json({ detail: 'نوع غير صالح' }, 400);

  const existing = await db.select().from(schema.recentViews)
    .where(and(eq(schema.recentViews.user_id, userId), eq(schema.recentViews.content_type, body.content_type), eq(schema.recentViews.content_id, body.content_id)))
    .get();

  if (existing) {
    await db.update(schema.recentViews).set({ viewed_at: new Date().toISOString() }).where(eq(schema.recentViews.id, existing.id));
  } else {
    await db.insert(schema.recentViews).values({ id: schema.genId(), user_id: userId, content_type: body.content_type, content_id: body.content_id });
  }
  return c.json({ ok: true });
});

authRouter.get('/me/continue', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;

  const lastLecture = await db.select().from(schema.recentViews)
    .where(and(eq(schema.recentViews.user_id, userId), eq(schema.recentViews.content_type, 'lecture')))
    .orderBy(desc(schema.recentViews.viewed_at)).get();

  const lastBooklet = await db.select().from(schema.recentViews)
    .where(and(eq(schema.recentViews.user_id, userId), eq(schema.recentViews.content_type, 'booklet')))
    .orderBy(desc(schema.recentViews.viewed_at)).get();

  let courseOut = null;
  if (lastLecture) {
    const lec = await db.select().from(schema.lectures).where(eq(schema.lectures.id, lastLecture.content_id)).get();
    if (lec?.course_id) {
      const courseLectures = await db.select().from(schema.lectures).where(eq(schema.lectures.course_id, lec.course_id));
      const doneIds = new Set((await db.select({ lecture_id: schema.lectureProgress.lecture_id }).from(schema.lectureProgress)
        .where(and(eq(schema.lectureProgress.user_id, userId), inArray(schema.lectureProgress.lecture_id, courseLectures.map((l) => l.id))))).map((r) => r.lecture_id));
      const course = await db.select().from(schema.courses).where(eq(schema.courses.id, lec.course_id)).get();
      const total = courseLectures.length;
      const done = doneIds.size;
      if (course) {
        courseOut = {
          course_id: lec.course_id, course_title: course.title,
          lecture_id: lec.id, lecture_title: lec.title,
          done_count: done, total_count: total,
          pct: total ? Math.round(100 * done / total) : 0,
        };
      }
    }
  }

  let bookletOut = null;
  if (lastBooklet) {
    const b = await db.select().from(schema.booklets).where(eq(schema.booklets.id, lastBooklet.content_id)).get();
    if (b) {
      let subjectName = '';
      if (b.professor_id) {
        const prof = await db.select().from(schema.professorProfiles).where(eq(schema.professorProfiles.id, b.professor_id)).get();
        if (prof?.subject_id) {
          const sub = await db.select().from(schema.subjects).where(eq(schema.subjects.id, prof.subject_id)).get();
          subjectName = sub?.name ?? '';
        }
      }
      bookletOut = { id: b.id, title: b.title, subject_name: subjectName, professor_id: b.professor_id, file_url: b.file_url ?? null };
    }
  }

  return c.json({ course: courseOut, booklet: bookletOut });
});

// ─────────────────────────────────────────── Stats ───────────────────────────

authRouter.get('/me/stats', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const allAnswers = await db.select().from(schema.studentAnswers).where(eq(schema.studentAnswers.user_id, user.id));
  const answeredToday = allAnswers.filter((a) => a.answered_at && new Date(a.answered_at) >= todayStart).length;

  const fullUser = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
  const peers = await peerIds(db, user.id, fullUser?.university_id ?? null);
  const ranked = await rankedPairs(db, peers);

  return c.json({
    answered_today: answeredToday,
    streak_days: await streakDays(db, user.id),
    rank: rankOf(ranked, user.id),
    total_ranked: ranked.length,
    accuracy_pct: await accuracyPct(db, user.id),
  });
});

authRouter.get('/me/daily', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;
  const days = Math.min(parseInt(c.req.query('days') ?? '7'), 31);

  const allAnswers = await db.select().from(schema.studentAnswers).where(eq(schema.studentAnswers.user_id, userId));

  const byDay: Record<string, { answered: number; correct: number }> = {};
  for (const a of allAnswers) {
    const key = String(a.answered_at ?? '').slice(0, 10);
    if (!key) continue;
    byDay[key] ??= { answered: 0, correct: 0 };
    byDay[key].answered++;
    if (a.is_correct) byDay[key].correct++;
  }

  function span(startOffset: number) {
    const out = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - startOffset + i);
      const key = d.toISOString().slice(0, 10);
      const { answered = 0, correct = 0 } = byDay[key] ?? {};
      out.push({ date: key, answered, correct });
    }
    return out;
  }

  const current = span(days - 1);
  const previous = span(days * 2 - 1);

  return c.json({
    days: current,
    previous: { answered: previous.reduce((s, d) => s + d.answered, 0), correct: previous.reduce((s, d) => s + d.correct, 0) },
  });
});

authRouter.get('/me/performance', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;

  const answers = await db.select().from(schema.studentAnswers).where(eq(schema.studentAnswers.user_id, userId));
  if (answers.length === 0) return c.json([]);

  const qIds = [...new Set(answers.map((a) => a.question_id))];
  const questions = await db.select().from(schema.questions).where(inArray(schema.questions.id, qIds));
  const subjectOf: Record<string, string> = {};
  for (const q of questions) { if (q.subject_id) subjectOf[q.id] = q.subject_id; }

  const stats: Record<string, { answered: number; correct: number }> = {};
  for (const a of answers) {
    const subjId = subjectOf[a.question_id];
    if (!subjId) continue;
    stats[subjId] ??= { answered: 0, correct: 0 };
    stats[subjId].answered++;
    if (a.is_correct) stats[subjId].correct++;
  }

  const subjects = await db.select().from(schema.subjects).where(inArray(schema.subjects.id, Object.keys(stats)));
  const out = subjects.map((subj) => {
    const s = stats[subj.id];
    return { subject_id: subj.id, subject_name: subj.name, answered: s.answered, correct: s.correct, accuracy_pct: Math.round(s.correct / s.answered * 100) };
  });
  out.sort((a, b) => b.answered - a.answered);
  return c.json(out);
});

// ─────────────────────────────────────────── Leaderboard ─────────────────────

authRouter.get('/leaderboard', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20'), 100);

  const fullUser = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
  const peers = await peerIds(db, user.id, fullUser?.university_id ?? null);
  const ranked = (await rankedPairs(db, peers)).slice(0, limit);

  const topIds = ranked.map(([uid]) => uid);
  const topUsers = topIds.length > 0
    ? await db.select().from(schema.users).where(inArray(schema.users.id, topIds))
    : [];
  const userMap: Record<string, typeof schema.users.$inferSelect> = {};
  topUsers.forEach((u) => { userMap[u.id] = u; });

  return c.json(ranked.map(([uid, score], i) => ({
    rank: i + 1,
    user_id: uid,
    full_name: userMap[uid]?.full_name ?? '',
    photo_url: userMap[uid]?.photo_url ?? null,
    correct_count: score,
    is_you: uid === user.id,
  })));
});

// ─────────────────────────────────────────── History ─────────────────────────

authRouter.get('/me/history', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;

  const events: Array<{ type: string; at: string | null; title: string; detail: string }> = [];

  const attempts = await db.select().from(schema.examAttempts)
    .where(and(eq(schema.examAttempts.user_id, userId), isNotNull(schema.examAttempts.finished_at)));
  for (const a of attempts) {
    const exam = await db.select().from(schema.exams).where(eq(schema.exams.id, a.exam_id)).get();
    events.push({ type: 'exam', at: a.finished_at, title: exam?.title ?? 'امتحان', detail: `${a.score} / ${a.total}` });
  }

  const orders = await db.select().from(schema.orders).where(eq(schema.orders.user_id, userId));
  const statusAr: Record<string, string> = { pending: 'قيد الانتظار', paid: 'مدفوع', fulfilled: 'مكتمل', cancelled: 'ملغي' };
  for (const o of orders) {
    events.push({ type: 'order', at: o.created_at, title: `طلب بقيمة ${o.total} د.ع`, detail: statusAr[o.status ?? ''] ?? o.status ?? '' });
  }

  const codes = await db.select().from(schema.activationCodes)
    .where(and(eq(schema.activationCodes.activated_by_user_id, userId), isNotNull(schema.activationCodes.activated_at)));
  for (const code of codes) {
    let subjectName = 'تفعيل VIP — جميع المواد';
    if (code.subject_id) {
      const sub = await db.select().from(schema.subjects).where(eq(schema.subjects.id, code.subject_id)).get();
      if (sub) subjectName = sub.name;
    }
    events.push({ type: 'code', at: code.activated_at, title: subjectName, detail: code.code });
  }

  events.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  return c.json(events.slice(0, 30));
});

// ─────────────────────────────────────────── Sessions ────────────────────────

const handleGetSessions = async (c: any) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;
  const currentSessionId = c.get('session')?.id;

  const sessions = await db
    .select()
    .from(schema.userSessions)
    .where(and(eq(schema.userSessions.user_id, userId), eq(schema.userSessions.is_active, true)))
    .orderBy(desc(schema.userSessions.created_at));

  const list = sessions.map((s) => ({
    id: s.id,
    device_label: s.device_label,
    is_active: s.is_active,
    created_at: s.created_at,
    is_current: s.id === currentSessionId,
  }));

  return c.json({
    ok: true,
    sessions: list,
  });
};

authRouter.get('/sessions', requireAuth, handleGetSessions);
authRouter.get('/me/sessions', requireAuth, handleGetSessions);

authRouter.post('/sessions/:id/revoke', requireAuth, async (c) => {
  const sessionId = c.req.param('id') ?? '';
  if (!sessionId) return c.json({ detail: 'معرّف الجلسة مطلوب' }, 400);
  const userId = c.get('user')!.id;
  const db = drizzle(c.env.DB, { schema });

  const session = await db
    .select()
    .from(schema.userSessions)
    .where(and(eq(schema.userSessions.id, sessionId), eq(schema.userSessions.user_id, userId)))
    .get();

  if (!session) {
    return c.json({ detail: 'الجلسة غير موجودة' }, 404);
  }

  await db
    .update(schema.userSessions)
    .set({ is_active: false })
    .where(eq(schema.userSessions.id, sessionId));

  await recordAccountEvent(db, {
    userId,
    eventType: 'session_revoked',
    outcome: 'success',
    ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
    userAgent: c.req.header('user-agent'),
    details: { sessionId },
  });

  return c.json({ ok: true, message: 'تم إنهاء الجلسة بنجاح' });
});

authRouter.post('/sessions/revoke-others', requireAuth, async (c) => {
  const userId = c.get('user')!.id;
  const currentSessionId = c.get('session')?.id;
  const db = drizzle(c.env.DB, { schema });

  if (currentSessionId) {
    await db
      .update(schema.userSessions)
      .set({ is_active: false })
      .where(and(eq(schema.userSessions.user_id, userId), ne(schema.userSessions.id, currentSessionId)));
  }

  await recordAccountEvent(db, {
    userId,
    eventType: 'session_revoked',
    outcome: 'success',
    ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
    userAgent: c.req.header('user-agent'),
    details: { action: 'revoke_others', currentSessionId },
  });

  return c.json({ ok: true, message: 'تم إنهاء جميع الجلسات الأخرى بنجاح' });
});

authRouter.post('/logout-all', requireAuth, async (c) => {
  const userId = c.get('user')!.id;
  const db = drizzle(c.env.DB, { schema });

  await db.batch([
    db
      .update(schema.userSessions)
      .set({ is_active: false })
      .where(eq(schema.userSessions.user_id, userId)),
    db
      .update(schema.users)
      .set({ session_epoch: sql`${schema.users.session_epoch} + 1` })
      .where(eq(schema.users.id, userId)),
  ]);

  await recordAccountEvent(db, {
    userId,
    eventType: 'logout_all',
    outcome: 'success',
    ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
    userAgent: c.req.header('user-agent'),
  });

  const response = c.json({ ok: true, message: 'تم تسجيل الخروج من كافة الأجهزة بنجاح' });
  const isDebug = (c.env.DEBUG ?? 'false') === 'true';
  clearSessionCookie(response, isDebug);
  return response;
});

authRouter.get('/security-events', requireAuth, async (c) => {
  const userId = c.get('user')!.id;
  const db = drizzle(c.env.DB, { schema });

  const events = await db
    .select()
    .from(schema.accountEvents)
    .where(eq(schema.accountEvents.user_id, userId))
    .orderBy(desc(schema.accountEvents.created_at))
    .limit(50);

  return c.json({ ok: true, events });
});

authRouter.patch('/me/preferences', requireAuth, async (c) => {
  const userId = c.get('user')!.id;
  const body = await c.req.json<{ theme?: string; language?: string }>().catch(() => ({} as Record<string, string>));
  const db = drizzle(c.env.DB, { schema });

  const updates: Partial<typeof schema.users.$inferInsert> = {};
  if (body.theme && (body.theme === 'light' || body.theme === 'dark')) {
    updates.theme = body.theme;
  }
  if (body.language && (body.language === 'ar' || body.language === 'en')) {
    updates.language = body.language;
  }

  if (Object.keys(updates).length > 0) {
    await db.update(schema.users).set(updates).where(eq(schema.users.id, userId));
  }

  const updatedUser = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  return c.json({ user: userOut(updatedUser!) });
});

authRouter.post('/session/restore', async (c) => {
  const cookieHeader = c.req.header('Cookie') ?? '';
  let sessionId: string | null = null;
  const match = cookieHeader.match(/nabd_session=([^;]+)/);
  if (match) sessionId = match[1];

  const body = await c.req.json<{ session_id?: string; session_token?: string }>().catch(() => ({} as any));
  if (!sessionId && body?.session_id) sessionId = body.session_id;

  let token = sessionId;
  if (!token && body?.session_token) token = body.session_token;
  if (!token) {
    const authHeader = c.req.header('Authorization') ?? '';
    if (authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
  }

  if (!token) return c.json({ detail: 'لا توجد جلسة محفوظة' }, 401);

  const db = drizzle(c.env.DB, { schema });
  const jwtSecret = c.env.JWT_SECRET;
  const expiresMinutes = parseInt(c.env.JWT_EXPIRES_MINUTES ?? '20160');
  const isDebug = (c.env.DEBUG ?? 'false') === 'true';

  let session = await db
    .select()
    .from(schema.userSessions)
    .where(and(eq(schema.userSessions.id, token), eq(schema.userSessions.is_active, true)))
    .get();

  let userRecord = null;
  if (session) {
    userRecord = await db.select().from(schema.users).where(eq(schema.users.id, session.user_id)).get();
  } else {
    const payload = await decodeAccessToken(token, jwtSecret);
    if (payload?.sub && payload?.sid) {
      session = await db
        .select()
        .from(schema.userSessions)
        .where(
          and(
            eq(schema.userSessions.id, payload.sid),
            eq(schema.userSessions.user_id, payload.sub),
            eq(schema.userSessions.is_active, true)
          )
        )
        .get();
      if (session) {
        userRecord = await db.select().from(schema.users).where(eq(schema.users.id, payload.sub)).get();
      }
    }
  }

  if (!session || !userRecord) return c.json({ detail: 'الجلسة غير صالحة أو تم إنهاؤها' }, 401);
  if (userRecord.is_banned) return c.json({ detail: 'هذا الحساب محظور' }, 403);
  if (!userRecord.email_verified_at) return c.json({ detail: 'يرجى توثيق بريدك الإلكتروني قبل تسجيل الدخول' }, 403);

  const fresh = await createAccessToken(userRecord.id, session.id, jwtSecret, expiresMinutes);
  const response = c.json({
    access_token: fresh,
    token_type: 'bearer',
    user: userOut(userRecord),
  });
  setSessionCookie(response, fresh, expiresMinutes, isDebug);
  return response;
});

// ─────────────────────────────────────────── Password change/reset ────────────

authRouter.post('/change-password', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;
  const currentSessionId = c.get('session')?.id;
  const body = await c.req.json<{ current_password?: string; old_password?: string; new_password: string }>().catch(() => ({} as any));

  const oldPassword = body.old_password || body.current_password || '';
  if (!oldPassword || !body.new_password) {
    return c.json({ detail: 'كلمة المرور القديمة والجديدة مطلوبتان' }, 400);
  }
  const passwordError = passwordPolicyError(body.new_password);
  if (passwordError) return c.json({ detail: passwordError }, 400);

  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (user?.password_hash && !(await verifyPassword(oldPassword, user.password_hash))) {
    return c.json({ detail: 'كلمة المرور الحالية غير صحيحة' }, 400);
  }

  const newHash = await hashPassword(body.new_password);
  await db.update(schema.users).set({
    password_hash: newHash,
    password_changed_at: new Date().toISOString(),
  }).where(eq(schema.users.id, userId));

  // Revoke all active sessions for this user upon password change
  await db
    .update(schema.userSessions)
    .set({ is_active: false })
    .where(eq(schema.userSessions.user_id, userId));

  recordAuditEvent({
    event: 'AUTH_PASSWORD_CHANGED',
    status: 'SUCCESS',
    actorId: userId,
  });

  return c.json({ ok: true, message: 'تم تغيير كلمة المرور بنجاح' });
});

authRouter.post('/forgot-password', forgotPasswordRateLimiter, async (c) => {
  const body = await c.req.json<{ email: string }>().catch(() => ({} as any));
  const email = (body.email ?? '').trim().toLowerCase();
  if (!email) return c.json({ detail: 'البريد الإلكتروني مطلوب' }, 400);

  const db = drizzle(c.env.DB, { schema });
  const user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();

  const rawToken = 'reset_' + crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  if (user && !user.is_banned) {
    if (user.reset_requested_at) {
      const elapsed = (Date.now() - new Date(user.reset_requested_at).getTime()) / 1000;
      if (elapsed < 120) {
        return c.json({ detail: 'يرجى الانتظار دقيقتين قبل طلب رمز استعادة جديد' }, 429);
      }
    }

    const tokenHash = await hashResetToken(rawToken);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60000).toISOString();

    await db.update(schema.users).set({
      reset_token_hash: tokenHash,
      reset_token_expires_at: expiresAt,
      reset_requested_at: new Date().toISOString(),
    }).where(eq(schema.users.id, user.id));

    const mailerConfig = {
      smtpHost: c.env.SMTP_HOST,
      smtpUser: c.env.SMTP_USER,
      smtpPassword: c.env.SMTP_PASSWORD,
      smtpFrom: c.env.SMTP_FROM,
      smtpFromName: c.env.SMTP_FROM_NAME,
    };

    if (emailConfigured(mailerConfig)) {
      const base = new URL(c.req.url).origin;
      const isAdminRole = ADMIN_DASHBOARD_ROLES.has(user.role ?? '');
      const resetLink = isAdminRole ? `${base}/admin#reset_token=${rawToken}` : `${base}/#reset_token=${rawToken}`;
      const mailPromise = sendPasswordReset(mailerConfig, email, user.full_name ?? '', resetLink, PASSWORD_RESET_TTL_MINUTES);
      try {
        c.executionCtx.waitUntil(mailPromise);
      } catch {
        mailPromise.catch(() => {});
      }
    }
  }

  recordAuditEvent({
    event: 'AUTH_PASSWORD_RESET_REQUESTED',
    status: 'SUCCESS',
    details: { email },
  });

  const isDebug = (c.env.DEBUG ?? 'false') === 'true';
  return c.json({
    ok: true,
    message: 'إذا كان هذا البريد مسجّلاً لدينا، فقد أُرسل إليه رابط لإعادة التعيين.',
    ...(isDebug ? { debug_token: rawToken } : {}),
  });
});

authRouter.post('/reset-password', resetPasswordRateLimiter, async (c) => {
  const body = await c.req.json<{ token: string; new_password: string }>().catch(() => ({} as any));
  if (!body || !body.token || !body.new_password) {
    return c.json({ detail: 'الرمز وكلمة المرور الجديدة مطلوبان' }, 400);
  }
  const passwordError = passwordPolicyError(body.new_password);
  if (passwordError) return c.json({ detail: passwordError }, 400);

  const token = (body.token ?? '').trim();
  const db = drizzle(c.env.DB, { schema });
  const tokenHash = await hashResetToken(token);
  const users = await db.select().from(schema.users).where(eq(schema.users.reset_token_hash, tokenHash));
  const user = users[0];

  if (!user || !user.reset_token_expires_at || new Date(user.reset_token_expires_at) < new Date()) {
    return c.json({ detail: 'انتهت صلاحية الرابط أو أنه غير صالح — اطلب رابطاً جديداً' }, 400);
  }
  if (user.is_banned) return c.json({ detail: 'هذا الحساب محظور' }, 403);

  const newHash = await hashPassword(body.new_password);
  await db.update(schema.users).set({
    password_hash: newHash,
    password_changed_at: new Date().toISOString(),
    reset_token_hash: null,
    reset_token_expires_at: null,
    failed_login_attempts: 0,
    locked_until: null,
  }).where(eq(schema.users.id, user.id));

  await db.update(schema.userSessions).set({ is_active: false }).where(eq(schema.userSessions.user_id, user.id));

  recordAuditEvent({
    event: 'AUTH_PASSWORD_RESET_COMPLETED',
    status: 'SUCCESS',
    actorId: user.id,
  });

  return c.json({ ok: true, message: 'تم تعيين كلمة المرور — سجّل الدخول بها الآن.' });
});
