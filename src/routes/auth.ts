/**
 * Auth routes — mirrors Python app/routers/auth.py (899 lines)
 * Complete: register, login, logout, Google OAuth, 2FA, sessions,
 * profile updates, skills, photos, stats, leaderboard, history,
 * password reset (forgot/reset), session restore.
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and, ne, inArray, desc, isNotNull } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { requireAuth, startNewSession } from '../middleware/auth';
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
import { emailConfigured, sendPasswordReset } from '../services/mailer';
import { createStorageService, safeUploadName, mediaUrl, IMAGE_EXTS, MAX_UPLOAD_BYTES } from '../services/storage';
import { peerIds, rankedPairs, rankOf, streakDays, accuracyPct } from '../services/ranking';
import {
  loginRateLimiter,
  registerRateLimiter,
  forgotPasswordRateLimiter,
  twoFaVerifyRateLimiter,
} from '../middleware/rate-limit';
import { recordAuditEvent } from '../services/audit';

export const authRouter = new Hono<AppEnv>();

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const ADMIN_DASHBOARD_ROLES = new Set(['admin', 'professor', 'reseller']);
const PASSWORD_RESET_TTL_MINUTES = 30;
const PASSWORD_RESET_COOLDOWN_SECONDS = 60;

// ─────────────────────────────────────────── helpers ────────────────────────

function shouldBootstrapAdmin(users: typeof schema.users.$inferSelect[], email: string, bootstrapEmail: string | undefined): boolean {
  if (!bootstrapEmail) return false;
  if (email.trim().toLowerCase() !== bootstrapEmail.trim().toLowerCase()) return false;
  return !users.some((u) => u.role === 'admin');
}

function domainAllowed(email: string, allowedDomains: string): boolean {
  if (!allowedDomains) return true;
  const domains = allowedDomains.split(',').map((d) => d.trim().toLowerCase());
  return domains.some((d) => email.toLowerCase().endsWith('@' + d));
}

function userOut(user: typeof schema.users.$inferSelect) {
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    photo_url: user.photo_url,
    caption: user.caption,
    phone: user.phone,
    section_id: user.section_id,
    university_id: user.university_id,
    stage_id: user.stage_id,
    is_graduate: user.is_graduate,
    is_banned: user.is_banned,
    totp_enabled: user.totp_enabled,
    theme: user.theme,
    language: user.language,
    created_at: user.created_at,
    password_changed_at: user.password_changed_at,
  };
}

// ─────────────────────────────────────────── Google OAuth ────────────────────

authRouter.get('/google/login', async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  const redirectUri = c.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !redirectUri) return c.json({ detail: 'إعدادات Google OAuth غير مهيأة' }, 500);

  const next = c.req.query('next') ?? '';
  const flow = next === 'admin' ? 'admin' : 'student';
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

  const isDebug = (c.env.DEBUG ?? 'true') === 'true';
  const secure = isDebug ? '' : '; Secure';
  c.header('Set-Cookie', `oauth_state=${state}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=300${secure}`);

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

authRouter.get('/google/callback', async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = c.env.GOOGLE_REDIRECT_URI;
  const code = c.req.query('code');
  const state = c.req.query('state') ?? '';

  if (!code) return c.json({ detail: 'كود التفويض مفقود' }, 400);
  if (!clientId || !clientSecret || !redirectUri) return c.json({ detail: 'إعدادات Google OAuth غير مهيأة' }, 500);

  // Validate OAuth state against cookie (CSRF protection)
  const cookieHeader = c.req.header('Cookie') ?? '';
  const stateCookieMatch = cookieHeader.match(/(?:^|; )oauth_state=([^;]+)/);
  const expectedState = stateCookieMatch ? stateCookieMatch[1] : null;

  // Clear state cookie
  const isDebug = (c.env.DEBUG ?? 'true') === 'true';
  const secure = isDebug ? '' : '; Secure';
  c.header('Set-Cookie', `oauth_state=; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);

  if (!state || (expectedState && state !== expectedState)) {
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
  const userInfo = await userInfoRes.json<{ email: string; name: string; sub: string }>();

  const { email, name, sub } = userInfo;
  if (!domainAllowed(email, c.env.ALLOWED_UNIVERSITY_DOMAINS ?? '')) {
    const isAdminFlow = state === 'admin';
    const base = new URL(c.req.url).origin;
    const redirectBase = isAdminFlow ? `${base}/admin` : base;
    return c.redirect(`${redirectBase}#google_error=domain`);
  }

  const db = drizzle(c.env.DB, { schema });

  // Find or create user
  let user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  const allUsers = await db.select().from(schema.users);
  const bootstrapEmail = c.env.BOOTSTRAP_ADMIN_EMAIL;

  if (user) {
    if (!user.google_sub) {
      await db.update(schema.users).set({ google_sub: sub }).where(eq(schema.users.id, user.id));
    }
    if (user.role !== 'admin' && shouldBootstrapAdmin(allUsers, email, bootstrapEmail)) {
      await db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, user.id));
      user = { ...user, role: 'admin' };
    }
  } else {
    const role = shouldBootstrapAdmin(allUsers, email, bootstrapEmail) ? 'admin' : 'student';
    const id = schema.genId();
    await db.insert(schema.users).values({ id, email, full_name: name, google_sub: sub, role });
    user = await db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  }

  if (!user) return c.json({ detail: 'خطأ في إنشاء المستخدم' }, 500);

  const isAdminFlow = state === 'admin';
  const base = new URL(c.req.url).origin;
  const adminBase = c.env.ADMIN_FRONTEND_URL || `${base}/admin`;
  const studentBase = c.env.FRONTEND_URL || base;
  const redirectBase = isAdminFlow ? adminBase : studentBase;

  if (isAdminFlow && !ADMIN_DASHBOARD_ROLES.has(user.role ?? '')) {
    return c.redirect(`${redirectBase}#google_error=role`);
  }

  const jwtSecret = c.env.JWT_SECRET;
  const expiresMinutes = parseInt(c.env.JWT_EXPIRES_MINUTES ?? '20160');

  if (user.totp_enabled) {
    const pending = await create2faPendingToken(user.id, jwtSecret);
    return c.redirect(`${redirectBase}#requires_2fa=1&pending_token=${pending}`);
  }

  const session = await startNewSession(db, user.id, 'متصفح');
  const token = await createAccessToken(user.id, session.id, jwtSecret, expiresMinutes);
  const response = c.redirect(`${redirectBase}#access_token=${token}`);
  setSessionCookie(response, token, expiresMinutes, isDebug);
  return response;
});

// ─────────────────────────────────────────── Dev login ───────────────────────

authRouter.post('/dev-login', async (c) => {
  if ((c.env.DEBUG ?? 'true') !== 'true') return c.json(null, 404);

  const email = c.req.query('email') ?? '';
  const name = c.req.query('name') ?? 'طالب تجريبي';
  if (!email) return c.json({ detail: 'email مطلوب' }, 400);

  const db = drizzle(c.env.DB, { schema });
  const allUsers = await db.select().from(schema.users);
  const bootstrapEmail = c.env.BOOTSTRAP_ADMIN_EMAIL;

  let user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  if (!user) {
    const role = shouldBootstrapAdmin(allUsers, email, bootstrapEmail) ? 'admin' : 'student';
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
  const body = await c.req.json<{ email: string; password?: string; full_name?: string }>();
  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';
  const fullName = (body.full_name ?? '').trim();

  if (!email || !password || !fullName) return c.json({ detail: 'جميع الحقول مطلوبة' }, 400);
  if (!domainAllowed(email, c.env.ALLOWED_UNIVERSITY_DOMAINS ?? '')) return c.json({ detail: 'الرجاء التسجيل ببريدك الجامعي الرسمي' }, 403);
  if (password.length < 8) return c.json({ detail: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' }, 400);

  const existing = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  if (existing) return c.json({ detail: 'البريد الإلكتروني مستخدم مسبقاً' }, 400);

  const allUsers = await db.select().from(schema.users).all();
  const role = shouldBootstrapAdmin(allUsers, email, c.env.BOOTSTRAP_ADMIN_EMAIL) ? 'admin' : 'student';

  const id = schema.genId();
  const passwordHash = await hashPassword(password);
  await db.insert(schema.users).values({ id, email, full_name: fullName, password_hash: passwordHash, role });

  const user = await db.select().from(schema.users).where(eq(schema.users.id, id)).get();

  const jwtSecret = c.env.JWT_SECRET;
  const expiresMinutes = parseInt(c.env.JWT_EXPIRES_MINUTES ?? '20160');
  const isDebug = (c.env.DEBUG ?? 'true') === 'true';
  const session = await startNewSession(db, user!.id, 'متصفح');
  const token = await createAccessToken(user!.id, session.id, jwtSecret, expiresMinutes);

  const response = c.json({ access_token: token, user: userOut(user!) });
  setSessionCookie(response, token, expiresMinutes, isDebug);

  recordAuditEvent({
    event: 'AUTH_REGISTER_SUCCESS',
    status: 'SUCCESS',
    actorId: user!.id,
    ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
    userAgent: c.req.header('user-agent'),
    details: { email, role },
  });

  return response;
});

// ─────────────────────────────────────────── Login ───────────────────────────

authRouter.post('/login', loginRateLimiter, async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();
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
        await db.update(schema.users).set({ failed_login_attempts: 0, locked_until: lockUntil }).where(eq(schema.users.id, user.id));
        recordAuditEvent({
          event: 'AUTH_ACCOUNT_LOCKED',
          status: 'LOCKED',
          actorId: user.id,
          ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
          details: { email, reason: 'max_failed_attempts_reached' },
        });
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

  if (user.is_banned) return c.json({ detail: 'هذا الحساب محظور' }, 403);
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
  const isDebug = (c.env.DEBUG ?? 'true') === 'true';
  const session = await startNewSession(db, user.id, 'متصفح');
  const token = await createAccessToken(user.id, session.id, jwtSecret, expiresMinutes);

  recordAuditEvent({
    event: 'AUTH_LOGIN_SUCCESS',
    status: 'SUCCESS',
    actorId: user.id,
    ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
    userAgent: c.req.header('user-agent'),
    details: { email },
  });

  const response = c.json({ access_token: token, user: userOut(user!) });
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
  clearSessionCookie(response, (c.env.DEBUG ?? 'true') === 'true');
  return response;
});

// ─────────────────────────────────────────── 2FA ─────────────────────────────

authRouter.post('/2fa/verify', twoFaVerifyRateLimiter, async (c) => {
  const body = await c.req.json<{ pending_token: string; code: string }>();
  const jwtSecret = c.env.JWT_SECRET;
  const userId = await decode2faPendingToken(body.pending_token, jwtSecret);
  if (!userId) return c.json({ detail: 'انتهت صلاحية الجلسة المؤقتة — سجّل الدخول من جديد' }, 401);

  const db = drizzle(c.env.DB, { schema });
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user || !user.totp_enabled) return c.json({ detail: 'جلسة غير صالحة' }, 401);
  if (user.is_banned) return c.json({ detail: 'هذا الحساب محظور' }, 403);

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutesLeft = Math.max(1, Math.floor((new Date(user.locked_until).getTime() - Date.now()) / 60000) + 1);
    return c.json({ detail: `تم قفل الحساب مؤقتاً — حاول بعد ${minutesLeft} دقيقة` }, 429);
  }

  const valid = await verifyTotp(user.totp_secret ?? '', body.code);
  if (!valid) {
    const attempts = (user.failed_login_attempts ?? 0) + 1;
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      await db.update(schema.users).set({ failed_login_attempts: 0, locked_until: new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString() }).where(eq(schema.users.id, userId));
      recordAuditEvent({
        event: 'AUTH_ACCOUNT_LOCKED',
        status: 'LOCKED',
        actorId: user.id,
        ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
        details: { reason: '2fa_max_attempts' },
      });
    } else {
      await db.update(schema.users).set({ failed_login_attempts: attempts }).where(eq(schema.users.id, userId));
    }
    return c.json({ detail: 'رمز التحقق غير صحيح' }, 401);
  }

  await db.update(schema.users).set({ failed_login_attempts: 0, locked_until: null }).where(eq(schema.users.id, userId));
  const expiresMinutes = parseInt(c.env.JWT_EXPIRES_MINUTES ?? '20160');
  const isDebug = (c.env.DEBUG ?? 'true') === 'true';
  const session = await startNewSession(db, user.id, 'متصفح');
  const token = await createAccessToken(user.id, session.id, jwtSecret, expiresMinutes);

  recordAuditEvent({
    event: 'AUTH_2FA_VERIFIED',
    status: 'SUCCESS',
    actorId: user.id,
    ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
  });

  const response = c.json({ access_token: token, user: userOut(user!) });
  setSessionCookie(response, token, expiresMinutes, isDebug);
  return response;
});

authRouter.post('/2fa/setup', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const secret = await generateTotpSecret();
  await db.update(schema.users).set({ totp_secret: secret }).where(eq(schema.users.id, user.id));
  return c.json({ secret, otpauth_uri: totpProvisioningUri(secret, user.email) });
});

authRouter.post('/2fa/enable', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;
  const body = await c.req.json<{ code: string }>();

  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user?.totp_secret) return c.json({ detail: 'لم تبدئي إعداد التحقق بخطوتين بعد' }, 400);
  if (!(await verifyTotp(user.totp_secret, body.code))) return c.json({ detail: 'رمز التحقق غير صحيح' }, 403);

  await db.update(schema.users).set({ totp_enabled: true }).where(eq(schema.users.id, userId));

  recordAuditEvent({
    event: 'AUTH_2FA_ENABLED',
    status: 'SUCCESS',
    actorId: userId,
  });

  return c.json({ ok: true });
});

authRouter.post('/2fa/disable', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;
  const body = await c.req.json<{ code: string }>();

  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user?.totp_enabled) return c.json({ detail: 'التحقق بخطوتين غير مفعّل أصلاً' }, 400);
  if (!(await verifyTotp(user.totp_secret ?? '', body.code))) return c.json({ detail: 'رمز التحقق غير صحيح' }, 403);

  await db.update(schema.users).set({ totp_enabled: false, totp_secret: null }).where(eq(schema.users.id, userId));

  recordAuditEvent({
    event: 'AUTH_2FA_DISABLED',
    status: 'SUCCESS',
    actorId: userId,
  });

  return c.json({ ok: true });
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
    full_name: string; phone: string;
    section_id: string; university_id: string;
    stage_id?: string; is_graduate?: boolean;
  }>();

  if (!body.full_name?.trim()) return c.json({ detail: 'الاسم الكامل مطلوب' }, 400);
  if (!body.phone?.trim()) return c.json({ detail: 'رقم الهاتف مطلوب' }, 400);

  const uni = await db.select().from(schema.universities).where(eq(schema.universities.id, body.university_id)).get();
  if (!uni || uni.section_id !== body.section_id) return c.json({ detail: 'الجامعة المختارة لا تتبع القسم المختار' }, 400);

  let stageId: string | null = null;
  if (!body.is_graduate) {
    if (!body.stage_id) return c.json({ detail: 'المرحلة الدراسية مطلوبة للطلاب غير المتخرجين' }, 400);
    const stage = await db.select().from(schema.stages).where(eq(schema.stages.id, body.stage_id)).get();
    if (!stage || stage.university_id !== body.university_id) return c.json({ detail: 'المرحلة المختارة لا تتبع الجامعة المختارة' }, 400);
    stageId = body.stage_id;
  }

  await db.update(schema.users).set({
    full_name: body.full_name.trim(),
    phone: body.phone.trim(),
    section_id: body.section_id,
    university_id: body.university_id,
    is_graduate: body.is_graduate ?? false,
    stage_id: stageId,
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
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  if (!file) return c.json({ detail: 'الملف مطلوب' }, 400);

  const contents = await file.arrayBuffer();
  if (contents.byteLength > MAX_UPLOAD_BYTES) return c.json({ detail: 'الملف أكبر من الحد المسموح (20 ميغابايت)' }, 400);

  const storage = createStorageService(c.env.R2_BUCKET);
  const storedName = safeUploadName(file.name, IMAGE_EXTS, 'photo');
  await storage.save(storedName, contents, file.type || 'image/jpeg');

  const photoUrl = mediaUrl(storedName);
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
  const text = (body.text ?? '').trim().slice(0, 40);
  if (!text) return c.json({ detail: 'اكتب مهارة قبل الإضافة' }, 400);

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

authRouter.get('/me/sessions', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const sessions = await db.select().from(schema.userSessions)
    .where(and(eq(schema.userSessions.user_id, c.get('user')!.id), eq(schema.userSessions.is_active, true)))
    .orderBy(desc(schema.userSessions.created_at));
  return c.json(sessions);
});

authRouter.post('/session/restore', async (c) => {
  const cookieHeader = c.req.header('Cookie') ?? '';
  const token = getSessionCookieValue(cookieHeader);
  if (!token) return c.json({ detail: 'لا توجد جلسة محفوظة' }, 401);

  const jwtSecret = c.env.JWT_SECRET;
  const payload = await decodeAccessToken(token, jwtSecret);
  if (!payload) return c.json({ detail: 'انتهت صلاحية الجلسة' }, 401);

  const db = drizzle(c.env.DB, { schema });
  const session = await db.select().from(schema.userSessions).where(eq(schema.userSessions.id, payload.sid)).get();
  if (!session?.is_active) return c.json({ detail: 'تم تسجيل الدخول من جهاز آخر' }, 401);

  const user = await db.select().from(schema.users).where(eq(schema.users.id, payload.sub)).get();
  if (!user) return c.json({ detail: 'المستخدم غير موجود' }, 401);
  if (user.is_banned) return c.json({ detail: 'هذا الحساب محظور' }, 403);

  const expiresMinutes = parseInt(c.env.JWT_EXPIRES_MINUTES ?? '20160');
  const isDebug = (c.env.DEBUG ?? 'true') === 'true';
  const fresh = await createAccessToken(user.id, session.id, jwtSecret, expiresMinutes);

  const response = c.json({ access_token: fresh, user: userOut(user!) });
  setSessionCookie(response, fresh, expiresMinutes, isDebug);
  return response;
});

// ─────────────────────────────────────────── Password change/reset ────────────

authRouter.post('/change-password', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.get('user')!.id;
  const currentSessionId = c.get('session')?.id;
  const body = await c.req.json<{ current_password?: string; new_password: string }>();

  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (user?.password_hash && !(await verifyPassword(body.current_password ?? '', user.password_hash))) {
    return c.json({ detail: 'كلمة المرور الحالية غير صحيحة' }, 403);
  }
  if ((body.new_password ?? '').length < 8) return c.json({ detail: 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل' }, 400);

  const newHash = await hashPassword(body.new_password);
  await db.update(schema.users).set({ password_hash: newHash, password_changed_at: new Date().toISOString() }).where(eq(schema.users.id, userId));

  // Revoke all other active sessions for this user upon password change
  if (currentSessionId) {
    await db
      .update(schema.userSessions)
      .set({ is_active: false })
      .where(and(eq(schema.userSessions.user_id, userId), ne(schema.userSessions.id, currentSessionId)));
  }

  recordAuditEvent({
    event: 'AUTH_PASSWORD_CHANGED',
    status: 'SUCCESS',
    actorId: userId,
  });

  return c.json({ ok: true });
});

authRouter.post('/forgot-password', forgotPasswordRateLimiter, async (c) => {
  const mailerConfig = {
    smtpHost: c.env.SMTP_HOST,
    smtpUser: c.env.SMTP_USER,
    smtpPassword: c.env.SMTP_PASSWORD,
    smtpFrom: c.env.SMTP_FROM,
    smtpFromName: c.env.SMTP_FROM_NAME,
  };

  if (!emailConfigured(mailerConfig)) {
    return c.json({ detail: 'خدمة البريد غير مهيأة على الخادم — لا يمكن إرسال رابط الاستعادة. راجع إعدادات SMTP.' }, 503);
  }

  const body = await c.req.json<{ email: string }>();
  const email = (body.email ?? '').trim().toLowerCase();
  const db = drizzle(c.env.DB, { schema });
  const user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();

  if (user && !user.is_banned) {
    const now = new Date();
    const recentlySent = user.reset_requested_at &&
      (now.getTime() - new Date(user.reset_requested_at).getTime()) / 1000 < PASSWORD_RESET_COOLDOWN_SECONDS;

    if (!recentlySent) {
      const rawToken = generateResetToken();
      const tokenHash = await hashResetToken(rawToken);
      const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MINUTES * 60000).toISOString();

      await db.update(schema.users).set({
        reset_token_hash: tokenHash,
        reset_token_expires_at: expiresAt,
        reset_requested_at: now.toISOString(),
      }).where(eq(schema.users.id, user.id));

      const base = new URL(c.req.url).origin;
      const isAdminRole = ADMIN_DASHBOARD_ROLES.has(user.role ?? '');
      const resetLink = isAdminRole ? `${base}/admin#reset_token=${rawToken}` : `${base}/#reset_token=${rawToken}`;

      // Send in background (waitUntil doesn't block response)
      c.executionCtx.waitUntil(
        sendPasswordReset(mailerConfig, email, user.full_name ?? '', resetLink, PASSWORD_RESET_TTL_MINUTES)
      );
      const mailPromise = sendPasswordReset(mailerConfig, email, user.full_name ?? '', resetLink, PASSWORD_RESET_TTL_MINUTES);
      try {
        if (c.executionCtx) {
          c.executionCtx.waitUntil(mailPromise);
        } else {
          mailPromise.catch(console.error);
        }
      } catch {
        mailPromise.catch(console.error);
      }
    }
  }

  recordAuditEvent({
    event: 'AUTH_PASSWORD_RESET_REQUESTED',
    status: 'SUCCESS',
    details: { email },
  });

  return c.json({ ok: true, message: 'إذا كان هذا البريد مسجّلاً لدينا، فقد أُرسل إليه رابط لإعادة التعيين.' });
});

authRouter.post('/reset-password', async (c) => {
  const body = await c.req.json<{ token: string; new_password: string }>();
  if ((body.new_password ?? '').length < 8) return c.json({ detail: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' }, 400);

  const token = (body.token ?? '').trim();
  if (!token) return c.json({ detail: 'رابط غير صالح' }, 400);

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
