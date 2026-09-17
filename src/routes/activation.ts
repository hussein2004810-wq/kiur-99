/**
 * Activation code redemption routes — mirrors Python app/routers/activation.py
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { requireAuth } from '../middleware/auth';

export const activationRouter = new Hono<AppEnv>();
activationRouter.use('*', requireAuth);

const CODE_VALIDITY_DAYS = 365;
const MAX_FAILED_REDEEMS = 5;
const REDEEM_LOCKOUT_MINUTES = 15;

// POST /api/activation/redeem
activationRouter.post('/redeem', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;

  // Load full user for lockout check
  const fullUser = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
  if (!fullUser) return c.json({ detail: 'المستخدم غير موجود' }, 401);

  // Check redeem lockout
  if (fullUser.redeem_locked_until) {
    const lockedUntil = new Date(fullUser.redeem_locked_until);
    if (lockedUntil > new Date()) {
      const minutesLeft = Math.max(1, Math.floor((lockedUntil.getTime() - Date.now()) / 60000) + 1);
      return c.json({ detail: `محاولات كثيرة فاشلة لتفعيل كود — حاول بعد ${minutesLeft} دقيقة` }, 429);
    }
  }

  const body = await c.req.json<{ code: string }>();
  const codeStr = body.code?.trim().toUpperCase();

  const code = await db
    .select()
    .from(schema.activationCodes)
    .where(eq(schema.activationCodes.code, codeStr))
    .get();

  if (!code) {
    // Register failed attempt
    const attempts = (fullUser.failed_redeem_attempts ?? 0) + 1;
    if (attempts >= MAX_FAILED_REDEEMS) {
      const lockUntil = new Date(Date.now() + REDEEM_LOCKOUT_MINUTES * 60000).toISOString();
      await db.update(schema.users).set({ failed_redeem_attempts: 0, redeem_locked_until: lockUntil }).where(eq(schema.users.id, user.id));
    } else {
      await db.update(schema.users).set({ failed_redeem_attempts: attempts }).where(eq(schema.users.id, user.id));
    }
    return c.json({ detail: 'الكود غير موجود — تأكد من كتابته بشكل صحيح' }, 404);
  }

  if (code.status === 'expired') return c.json({ detail: 'هذا الكود منتهي الصلاحية' }, 400);

  if (code.status === 'active') {
    if (code.activated_by_user_id === user.id) return c.json({ detail: 'هذا الكود مُفعّل مسبقاً على حسابك' }, 400);
    const attempts = (fullUser.failed_redeem_attempts ?? 0) + 1;
    await db.update(schema.users).set({ failed_redeem_attempts: attempts }).where(eq(schema.users.id, user.id));
    return c.json({ detail: 'هذا الكود مُفعّل مسبقاً من مستخدم آخر' }, 400);
  }

  // Redeem
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CODE_VALIDITY_DAYS * 86400000);

  await db.update(schema.activationCodes).set({
    status: 'active',
    activated_by_user_id: user.id,
    activated_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  }).where(eq(schema.activationCodes.id, code.id));

  // Clear failed attempts
  await db.update(schema.users).set({ failed_redeem_attempts: 0, redeem_locked_until: null }).where(eq(schema.users.id, user.id));

  // Get subject name if applicable
  let subjectName = 'VIP — جميع المواد';
  if (code.subject_id) {
    const subject = await db.select({ name: schema.subjects.name }).from(schema.subjects).where(eq(schema.subjects.id, code.subject_id)).get();
    if (subject) subjectName = subject.name;
  }

  return c.json({
    id: code.id,
    code_masked: codeStr.slice(0, 4) + '••••',
    subject_name: subjectName,
    activated_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  });
});

// GET /api/activation/mine
activationRouter.get('/mine', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;

  const codes = await db
    .select()
    .from(schema.activationCodes)
    .where(eq(schema.activationCodes.activated_by_user_id, user.id))
    .orderBy(desc(schema.activationCodes.activated_at));

  const result = await Promise.all(codes.map(async (code) => {
    let subjectName = 'VIP — جميع المواد';
    if (code.subject_id) {
      const subject = await db.select({ name: schema.subjects.name }).from(schema.subjects).where(eq(schema.subjects.id, code.subject_id)).get();
      if (subject) subjectName = subject.name;
    }
    return {
      id: code.id,
      code_masked: code.code.slice(0, 4) + '••••',
      subject_name: subjectName,
      activated_at: code.activated_at,
      expires_at: code.expires_at,
    };
  }));

  return c.json(result);
});
