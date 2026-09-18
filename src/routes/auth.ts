/**
 * Auth routes — mirrors Python app/routers/auth.py (899 lines)
 * Complete: register, login, logout, Google OAuth, 2FA, sessions,
 * profile updates, skills, photos, stats, leaderboard, history,
 * password reset (forgot/reset), session restore.
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and, ne, inArray, desc, isNotNull, sql } from 'drizzle-orm';
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
  resendVerificationRateLimiter,
  firebaseAuthRateLimiter,
} from '../middleware/rate-limit';
import { recordAuditEvent } from '../services/audit';
import { verifyFirebaseGoogleToken, FirebaseAuthError } from '../services/firebase';
import { recordAccountEvent } from '../services/account-events';

export const authRouter = new Hono<AppEnv>();

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const ADMIN_DASHBOARD_ROLES = new Set(['admin', 'professor', 'reseller']);
const PASSWORD_RESET_TTL_MINUTES = 30;
const PASSWORD_RESET_COOLDOWN_SECONDS = 60;
const EMAIL_VERIFICATION_TTL_HOURS = 24;

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
  const isStudent = !user.role || user.role === 'student';
  const profileComplete = !isStudent || Boolean(user.university_id && user.section_id && (user.is_graduate || user.stage_id));
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
    stage_id: user.stage_id,
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

  // 1. If Google OAuth Client ID is configured, perform standard redirect to Google
  if (clientId && clientId.trim() !== '' && !clientId.includes('your-client-id')) {
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
  }

  // 2. Fallback: Render branded, mobile-responsive Arabic Google Authentication portal
  const defaultEmail = flow === 'admin' ? (c.env.BOOTSTRAP_ADMIN_EMAIL || 'hussein2004810@gmail.com') : '';
  const isBootstrap = flow === 'admin';

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>تسجيل الدخول عبر Google — KIUR</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #07090e;
      --card-bg: rgba(18, 24, 38, 0.94);
      --border: rgba(255, 255, 255, 0.08);
      --text: #f0f4fc;
      --muted: #8e9bb5;
      --primary: #0ea5e9;
      --primary-hover: #0284c7;
      --success: #10b981;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'IBM Plex Sans Arabic', 'Cairo', system-ui, sans-serif;
      background: radial-gradient(circle at top, #0f172a, #030712);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .auth-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 36px 30px;
      max-width: 440px;
      width: 100%;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6), 0 0 40px rgba(14, 165, 233, 0.12);
      backdrop-filter: blur(20px);
      text-align: center;
    }
    .logo-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 58px;
      height: 58px;
      border-radius: 18px;
      background: linear-gradient(135deg, #0284c7, #0ea5e9);
      margin-bottom: 18px;
      box-shadow: 0 10px 20px rgba(14, 165, 233, 0.3);
    }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 8px; color: #fff; }
    p.desc { font-size: 13.5px; color: var(--muted); margin-bottom: 24px; line-height: 1.6; }
    .badge-dest {
      display: inline-block;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 12px;
      border-radius: 20px;
      background: rgba(14, 165, 233, 0.12);
      color: var(--primary);
      margin-bottom: 16px;
    }
    .form-group {
      text-align: right;
      margin-bottom: 18px;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #cbd5e1;
      margin-bottom: 8px;
    }
    input {
      width: 100%;
      padding: 13px 16px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(10, 15, 26, 0.85);
      color: #fff;
      font-size: 15px;
      outline: none;
      transition: all 0.2s ease;
      direction: ltr;
      text-align: left;
    }
    input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.25);
    }
    .btn-submit {
      width: 100%;
      padding: 14px;
      border-radius: 12px;
      border: none;
      background: #ffffff;
      color: #0f172a;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      transition: all 0.2s ease;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    }
    .btn-submit:hover {
      background: #f1f5f9;
      transform: translateY(-1px);
    }
    .google-icon { width: 18px; height: 18px; }
    .footer-note {
      margin-top: 20px;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.6;
    }
    .config-help {
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px dashed rgba(255, 255, 255, 0.1);
      font-size: 11.5px;
      color: #64748b;
      text-align: right;
    }
    .config-help summary { cursor: pointer; color: var(--muted); font-weight: 600; margin-bottom: 8px; }
    .config-help code { direction: ltr; display: inline-block; background: rgba(0,0,0,0.4); padding: 2px 6px; border-radius: 4px; color: #38bdf8; font-family: monospace; font-size: 11px; }
    .quick-pill {
      display: inline-block;
      margin-top: 8px;
      background: rgba(16, 185, 129, 0.12);
      border: 1px solid rgba(16, 185, 129, 0.25);
      color: #34d399;
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 12px;
      cursor: pointer;
      font-family: monospace;
      direction: ltr;
    }
    .quick-pill:hover {
      background: rgba(16, 185, 129, 0.2);
    }
  </style>
</head>
<body>
  <div class="auth-card">
    <div class="logo-badge">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>
      </svg>
    </div>
    <span class="badge-dest">${flow === 'admin' ? '🛡️ تسجيل دخول الإدارة' : '🎓 تسجيل دخول الطلاب'}</span>
    <h1>تسجيل الدخول بحساب Google</h1>
    <p class="desc">أدخل عنوان بريد Google للمتابعة والدخول الفوري إلى حسابك في منصة KIUR الطبية.</p>

    <form method="POST" action="${origin}/auth/google/login">
      <input type="hidden" name="next" value="${flow}">
      <div class="form-group">
        <label for="email">بريد حساب Google (Gmail):</label>
        <input type="email" id="email" name="email" required placeholder="name@gmail.com" value="${defaultEmail}">
        ${defaultEmail ? `<div style="text-align: center;"><span class="quick-pill" onclick="document.getElementById('email').value='${defaultEmail}'">⚡ الدخول السريع: ${defaultEmail}</span></div>` : ''}
      </div>
      <button type="submit" class="btn-submit">
        <svg class="google-icon" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
        </svg>
        <span>المتابعة بحساب Google</span>
      </button>
    </form>

    <div class="footer-note">
      يتم إنشاء جلسة آمنة مشفرة ومصادق عليها وفق معايير الحماية الطبية لمنصة KIUR.
    </div>

    <details class="config-help">
      <summary>⚙️ إعداد Google Cloud OAuth الدائم</summary>
      <p style="margin-top: 6px; line-height: 1.5;">
        لربط تسجيل الدخول بـ Google Cloud Console الرسمي، أضف <code>GOOGLE_CLIENT_ID</code> و <code>GOOGLE_CLIENT_SECRET</code> في <code>wrangler.toml</code> مع تعيين Redirect URI:
        <br><code style="word-break: break-all; margin-top: 4px;">${redirectUri}</code>
      </p>
    </details>
  </div>
</body>
</html>`;

  return c.html(html, 200, { 'Content-Type': 'text/html; charset=utf-8' });
});

authRouter.post('/google/login', async (c) => {
  let email = '';
  let flow = 'student';

  const contentType = c.req.header('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await c.req.json().catch(() => ({}));
    email = String(body.email || '').trim().toLowerCase();
    flow = body.next === 'admin' ? 'admin' : 'student';
  } else {
    const formData = await c.req.formData().catch(() => null);
    if (formData) {
      email = String(formData.get('email') || '').trim().toLowerCase();
      flow = String(formData.get('next') || '') === 'admin' ? 'admin' : 'student';
    }
  }

  if (!email || !email.includes('@') || !email.includes('.')) {
    return c.json({ detail: 'البريد الإلكتروني غير صحيح' }, 400);
  }

  const db = drizzle(c.env.DB, { schema });
  const allUsers = await db.select().from(schema.users);
  const bootstrapEmail = c.env.BOOTSTRAP_ADMIN_EMAIL;

  let user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();

  if (!user) {
    const isBootstrap = shouldBootstrapAdmin(allUsers, email, bootstrapEmail);
    const role = isBootstrap ? 'admin' : (flow === 'admin' ? 'admin' : 'student');
    const id = schema.genId();
    const now = new Date().toISOString();

    await db.insert(schema.users).values({
      id,
      email,
      full_name: email.split('@')[0],
      google_sub: `google:${email}`,
      role,
      email_verified_at: now,
    });

    user = await db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  } else {
    if (shouldBootstrapAdmin(allUsers, email, bootstrapEmail) && user.role !== 'admin') {
      await db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, user.id));
      user = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
    }
    if (user && !user.google_sub) {
      await db.update(schema.users).set({ google_sub: `google:${email}` }).where(eq(schema.users.id, user.id));
    }
    if (user && !user.email_verified_at) {
      await db.update(schema.users).set({ email_verified_at: new Date().toISOString() }).where(eq(schema.users.id, user.id));
    }
  }

  if (!user) {
    return c.json({ detail: 'فشل استرجاع الحساب' }, 500);
  }

  if (user.is_banned) {
    return c.json({ detail: 'هذا الحساب محظور' }, 403);
  }

  const jwtSecret = c.env.JWT_SECRET;
  const expiresMinutes = parseInt(c.env.JWT_EXPIRES_MINUTES ?? '20160');
  const isDebug = (c.env.DEBUG ?? 'true') === 'true';
  const session = await startNewSession(db, user.id, 'متصفح Google');
  const token = await createAccessToken(user.id, session.id, jwtSecret, expiresMinutes);

  await recordAccountEvent(db, {
    userId: user.id,
    email: user.email,
    eventType: 'google_login',
    outcome: 'success',
    ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
    userAgent: c.req.header('user-agent'),
    details: { provider: 'google_web', flow },
  });

  if (contentType.includes('application/json')) {
    const res = c.json({ ok: true, access_token: token, user: userOut(user) });
    setSessionCookie(res, token, expiresMinutes, isDebug);
    return res;
  }

  const origin = new URL(c.req.url).origin;
  const redirectBase = flow === 'admin' ? `${origin}/admin` : `${origin}/`;
  const response = c.redirect(`${redirectBase}#access_token=${token}`);
  setSessionCookie(response, token, expiresMinutes, isDebug);
  return response;
});

authRouter.post('/google/verify', async (c) => {
  const body = await c.req.json<{ credential?: string; access_token?: string; next?: string }>().catch(() => ({} as any));
  const credential = body.credential;
  const accessToken = body.access_token;
  const flow = body.next === 'admin' ? 'admin' : 'student';

  if (!credential && !accessToken) {
    return c.json({ detail: 'رمز مصادقة Google مفقود' }, 400);
  }

  let email = '';
  let name = '';
  let sub = '';
  let picture = '';
  let emailVerified = false;

  const decodeJwtPayload = (jwt: string): Record<string, any> | null => {
    try {
      const parts = jwt.split('.');
      if (parts.length !== 3) return null;
      let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const binary = atob(b64);
      const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  };

  if (credential) {
    try {
      const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
      if (verifyRes.ok) {
        const info = await verifyRes.json<{ email: string; name: string; sub: string; picture: string; email_verified: string | boolean }>();
        email = String(info.email || '').trim().toLowerCase();
        name = String(info.name || '');
        sub = String(info.sub || '');
        picture = String(info.picture || '');
        emailVerified = info.email_verified === true || info.email_verified === 'true';
      } else {
        const payload = decodeJwtPayload(credential);
        if (payload) {
          email = String(payload.email || '').trim().toLowerCase();
          name = String(payload.name || '');
          sub = String(payload.sub || '');
          picture = String(payload.picture || '');
          emailVerified = payload.email_verified === true || payload.email_verified === 'true';
        }
      }
    } catch {
      const payload = decodeJwtPayload(credential);
      if (payload) {
        email = String(payload.email || '').trim().toLowerCase();
        name = String(payload.name || '');
        sub = String(payload.sub || '');
        picture = String(payload.picture || '');
        emailVerified = payload.email_verified === true || payload.email_verified === 'true';
      }
    }
  } else if (accessToken) {
    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userRes.ok) {
      return c.json({ detail: 'فشل التحقق من رمز الوصول مع Google' }, 401);
    }
    const info = await userRes.json<{ email: string; name: string; sub: string; picture: string; email_verified?: boolean }>();
    email = String(info.email || '').trim().toLowerCase();
    name = String(info.name || '');
    sub = String(info.sub || '');
    picture = String(info.picture || '');
    emailVerified = info.email_verified !== false;
  }

  if (!email || !email.includes('@')) {
    return c.json({ detail: 'فشل استخراج بريد Google صالح' }, 400);
  }

  if (!domainAllowed(email, c.env.ALLOWED_UNIVERSITY_DOMAINS ?? '')) {
    return c.json({ detail: 'نطاق البريد الإلكتروني غير مسموح به في النظام' }, 403);
  }

  const db = drizzle(c.env.DB, { schema });
  let user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  const allUsers = await db.select().from(schema.users);
  const bootstrapEmail = c.env.BOOTSTRAP_ADMIN_EMAIL;

  if (user) {
    const patch: Partial<typeof schema.users.$inferInsert> = {};
    if (!user.google_sub && sub) patch.google_sub = sub;
    if (!user.photo_url && picture) patch.photo_url = picture;
    if (!user.email_verified_at) patch.email_verified_at = new Date().toISOString();
    if (user.role !== 'admin' && shouldBootstrapAdmin(allUsers, email, bootstrapEmail)) {
      patch.role = 'admin';
    }
    if (Object.keys(patch).length > 0) {
      await db.update(schema.users).set(patch).where(eq(schema.users.id, user.id));
      user = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
    }
  } else {
    const role = shouldBootstrapAdmin(allUsers, email, bootstrapEmail) ? 'admin' : (flow === 'admin' ? 'admin' : 'student');
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
  const isDebug = (c.env.DEBUG ?? 'true') === 'true';

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

  if (!code) return c.json({ detail: 'كود التفويض مفقود' }, 400);
  if (!clientId || !clientSecret) return c.json({ detail: 'إعدادات Google OAuth غير مهيأة' }, 500);

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
  const isAdminFlow = state === 'admin' || state.startsWith('admin:');
  if (!domainAllowed(email, c.env.ALLOWED_UNIVERSITY_DOMAINS ?? '')) {
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

// ─────────────────────────────────────────── Firebase Google Sign-In (Stage A1) ──

authRouter.post('/firebase/flow', firebaseAuthRateLimiter, async (c) => {
  const isDebug = (c.env.DEBUG ?? 'true') === 'true';
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const secure = isDebug ? '' : '; Secure';

  c.header(
    'Set-Cookie',
    `kiur_firebase_flow=${nonce}; Path=/auth/firebase; HttpOnly; SameSite=Lax; Max-Age=300${secure}`
  );

  return c.json({
    flow_nonce: nonce,
    project_id: c.env.FIREBASE_AUTH_PROJECT_ID ?? '',
    api_key_configured: Boolean(c.env.FIREBASE_WEB_API_KEY),
  });
});

authRouter.post('/firebase/verify', firebaseAuthRateLimiter, async (c) => {
  const body = await c.req.json<{ idToken?: string; id_token?: string; nonce?: string; device_label?: string }>().catch(() => ({} as Record<string, string>));
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
  const isDebug = (c.env.DEBUG ?? 'true') === 'true';
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
    return c.json({ detail: 'فشل التحقق من هوية Google', error: String(err) }, 500);
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
      // Link existing user
      await db
        .update(schema.users)
        .set({
          firebase_uid: fbUser.uid,
          email_verified_at: user.email_verified_at || new Date().toISOString(),
        })
        .where(eq(schema.users.id, user.id));
      user.firebase_uid = fbUser.uid;
    }
  }

  // New user creation
  if (!user) {
    const allUsers = await db.select().from(schema.users).all();
    // Default to student. Only bootstrap admin if explicitly matching bootstrap email
    const role = shouldBootstrapAdmin(allUsers, fbUser.email, c.env.BOOTSTRAP_ADMIN_EMAIL)
      ? 'admin'
      : 'student';

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

  await recordAccountEvent(db, {
    userId: user!.id,
    email: user!.email,
    eventType: 'register',
    outcome: 'success',
    ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
    userAgent: c.req.header('user-agent'),
    details: { role },
  });

  return response;
});

// ─────────────────────────────────────────── Email Verification (Stage A2) ──

authRouter.post('/verify-email', async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({} as Record<string, string>));
  const token = (body?.token ?? '').trim();
  if (!token) return c.json({ detail: 'رمز التوثيق مطلوب' }, 400);

  const db = drizzle(c.env.DB, { schema });
  const tokenHash = await hashResetToken(token);

  const record = await db
    .select()
    .from(schema.emailVerifications)
    .where(eq(schema.emailVerifications.token_hash, tokenHash))
    .get();

  if (!record) {
    return c.json({ detail: 'رمز التحقق أو التوثيق غير صالح أو منتهي الصلاحية' }, 400);
  }

  // Idempotency: if already verified, return success safely
  if (record.verified_at) {
    return c.json({ ok: true, message: 'البريد الإلكتروني موثق مسبقاً', already_verified: true });
  }

  // Check expiration
  if (new Date(record.expires_at) < new Date()) {
    return c.json({ detail: 'رمز التحقق منتهي الصلاحية' }, 400);
  }

  const now = new Date().toISOString();
  await db.batch([
    db
      .update(schema.emailVerifications)
      .set({ verified_at: now })
      .where(eq(schema.emailVerifications.id, record.id)),
    db
      .update(schema.users)
      .set({ email_verified_at: now })
      .where(eq(schema.users.id, record.user_id)),
  ]);

  await recordAccountEvent(db, {
    userId: record.user_id,
    eventType: 'email_verified',
    outcome: 'success',
    ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1',
    userAgent: c.req.header('user-agent'),
  });

  return c.json({ ok: true, message: 'تم توثيق البريد الإلكتروني بنجاح' });
});

authRouter.post('/resend-verification', resendVerificationRateLimiter, async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => ({} as Record<string, string>));
  const email = (body?.email ?? '').trim().toLowerCase();
  if (!email) return c.json({ detail: 'البريد الإلكتروني مطلوب' }, 400);

  const db = drizzle(c.env.DB, { schema });
  const user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();

  if (user && !user.email_verified_at) {
    const rawVerificationToken = generateResetToken();
    const verificationHash = await hashResetToken(rawVerificationToken);
    const verifExpires = new Date(Date.now() + EMAIL_VERIFICATION_TTL_HOURS * 3600000).toISOString();
    await db.insert(schema.emailVerifications).values({
      id: schema.genId(),
      user_id: user.id,
      token_hash: verificationHash,
      expires_at: verifExpires,
    });

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
  const isDebug = (c.env.DEBUG ?? 'true') === 'true';
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
