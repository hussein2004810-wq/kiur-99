/**
 * Bans and appeals routes — mirrors Python app/routers/bans.py
 * Uses requireAuth but allows banned users (to check their ban status).
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { decodeAccessToken } from '../services/jwt';

export const bansRouter = new Hono<AppEnv>();

// Middleware that allows banned users (unlike requireAuth which blocks them)
async function requireAuthAllowBanned(c: any, next: any) {
  const authHeader = c.req.header('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return c.json({ detail: 'مطلوب تسجيل الدخول' }, 401);

  const payload = await decodeAccessToken(token, c.env.JWT_SECRET);
  if (!payload || !payload.sub || !payload.sid) return c.json({ detail: 'انتهت صلاحية الجلسة' }, 401);

  const db = drizzle(c.env.DB, { schema });
  const session = await db.select().from(schema.userSessions).where(eq(schema.userSessions.id, payload.sid)).get();
  if (!session || !session.is_active) return c.json({ detail: 'تم تسجيل الدخول من جهاز آخر' }, 401);

  const user = await db.select().from(schema.users).where(eq(schema.users.id, payload.sub)).get();
  if (!user) return c.json({ detail: 'المستخدم غير موجود' }, 401);

  c.set('user', {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    is_banned: user.is_banned ?? false,
    university_id: user.university_id,
    stage_id: user.stage_id,
    section_id: user.section_id,
  });
  await next();
}

bansRouter.use('*', requireAuthAllowBanned);

// GET /api/bans/mine
bansRouter.get('/mine', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;

  const record = await db
    .select()
    .from(schema.banRecords)
    .where(eq(schema.banRecords.user_id, user.id))
    .orderBy(desc(schema.banRecords.created_at))
    .get();

  if (!record) return c.json({ is_banned: user.is_banned });

  return c.json({
    is_banned: user.is_banned,
    reason: record.reason,
    status: record.status,
    appeal_message: record.appeal_message,
    appealed_at: record.appealed_at,
  });
});

// POST /api/bans/appeal
bansRouter.post('/appeal', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;

  if (!user.is_banned) return c.json({ detail: 'حسابك غير محظور' }, 400);

  const record = await db
    .select()
    .from(schema.banRecords)
    .where(eq(schema.banRecords.user_id, user.id) && eq(schema.banRecords.status, 'active'))
    .orderBy(desc(schema.banRecords.created_at))
    .get();

  if (!record) return c.json({ detail: 'لا يوجد سجل حظر نشط لهذا الحساب' }, 404);

  const body = await c.req.json<{ message: string }>();
  if (!body.message?.trim()) return c.json({ detail: 'الرجاء كتابة سبب الطعن' }, 400);

  await db.update(schema.banRecords).set({
    appeal_message: body.message.trim(),
    appealed_at: new Date().toISOString(),
    status: 'appealed',
  }).where(eq(schema.banRecords.id, record.id));

  return c.json({ ok: true });
});
