/**
 * Reseller routes — mirrors Python app/routers/reseller.py
 * Enhanced with quota enforcement, IDOR ownership protection, and audit logging.
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, and, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { requireAuth } from '../middleware/auth';
import { recordAuditEvent } from '../services/audit';

export const resellerRouter = new Hono<AppEnv>();
resellerRouter.use('*', requireAuth);

// GET /api/reseller/summary
resellerRouter.get('/summary', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  if (user.role !== 'reseller' && user.role !== 'admin') {
    return c.json({ detail: 'هذه الواجهة مخصصة للمندوبين فقط' }, 403);
  }

  const codes = await db.select().from(schema.activationCodes).where(eq(schema.activationCodes.reseller_id, user.id));
  const sold = codes.filter((code) => code.sold_at !== null);
  const activated = codes.filter((code) => code.status === 'active');

  // Build weekly sales (last 7 days)
  const weeklyData: Record<string, number> = {};
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    weeklyData[d.toISOString().slice(0, 10)] = 0;
  }
  for (const code of sold) {
    if (!code.sold_at) continue;
    const dateKey = code.sold_at.slice(0, 10);
    if (weeklyData[dateKey] !== undefined) weeklyData[dateKey]++;
  }
  const weeklySales = Object.entries(weeklyData).map(([date, count]) => ({ date, count }));

  return c.json({
    available: codes.length - sold.length,
    sold: sold.length,
    activated: activated.length,
    weekly_sales: weeklySales,
  });
});

// GET /api/reseller/inventory
resellerRouter.get('/inventory', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  if (user.role !== 'reseller' && user.role !== 'admin') {
    return c.json({ detail: 'هذه الواجهة مخصصة للمندوبين فقط' }, 403);
  }

  const rows = await db
    .select()
    .from(schema.activationCodes)
    .where(eq(schema.activationCodes.reseller_id, user.id))
    .orderBy(desc(schema.activationCodes.id));

  return c.json(rows);
});

// GET /api/reseller/stats
resellerRouter.get('/stats', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  if (user.role !== 'reseller' && user.role !== 'admin') {
    return c.json({ detail: 'هذه الواجهة مخصصة للمندوبين فقط' }, 403);
  }

  const codes = await db.select().from(schema.activationCodes).where(eq(schema.activationCodes.reseller_id, user.id));
  const active = codes.filter((code) => code.status === 'active');

  return c.json({
    total_codes: codes.length,
    active_codes: active.length,
  });
});

// GET /api/reseller/codes
resellerRouter.get('/codes', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  if (user.role !== 'reseller' && user.role !== 'admin') {
    return c.json({ detail: 'هذه الواجهة مخصصة للمندوبين فقط' }, 403);
  }

  const codes = await db
    .select()
    .from(schema.activationCodes)
    .where(eq(schema.activationCodes.reseller_id, user.id))
    .orderBy(desc(schema.activationCodes.sold_at));

  const result = await Promise.all(codes.map(async (code) => {
    let subjectName = 'VIP — جميع المواد';
    if (code.subject_id) {
      const subject = await db.select().from(schema.subjects).where(eq(schema.subjects.id, code.subject_id)).get();
      if (subject) subjectName = subject.name;
    }
    return { id: code.id, code: code.code, status: code.status, subject_name: subjectName, sold_at: code.sold_at };
  }));

  return c.json(result);
});

// POST /api/reseller/generate
resellerRouter.post('/generate', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  if (user.role !== 'reseller' && user.role !== 'admin') {
    return c.json({ detail: 'هذه الواجهة مخصصة للمندوبين فقط' }, 403);
  }

  const body = await c.req.json<{ count?: number; subject_id?: string }>().catch(() => ({} as { count?: number; subject_id?: string }));
  const count = body.count ?? 5;
  const subjectId = body.subject_id ?? null;

  if (count < 1 || count > 100) return c.json({ detail: 'العدد يجب أن يكون بين 1 و100' }, 400);

  // Quota protection for resellers: max 200 idle/unactivated codes in stock
  if (user.role !== 'admin') {
    const idleCodes = await db
      .select({ id: schema.activationCodes.id })
      .from(schema.activationCodes)
      .where(and(
        eq(schema.activationCodes.reseller_id, user.id),
        eq(schema.activationCodes.status, 'idle')
      ));

    if (idleCodes.length + count > 200) {
      return c.json({ detail: 'تجاوزت الحد المسموح للأكواد غير المفعلة في المخزون (200 كود)' }, 429);
    }
  }

  if (subjectId) {
    const subject = await db.select().from(schema.subjects).where(eq(schema.subjects.id, subjectId)).get();
    if (!subject) return c.json({ detail: 'المادة غير موجودة' }, 404);
  }

  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    const codeStr = `NBD-${randomHex.slice(0, 4)}-${randomHex.slice(4, 8)}`;
    await db.insert(schema.activationCodes).values({
      id: schema.genId(),
      code: codeStr,
      subject_id: subjectId,
      status: 'idle',
      reseller_id: user.id,
    });
    codes.push(codeStr);
  }

  recordAuditEvent({
    event: 'RESELLER_CODES_GENERATED',
    status: 'SUCCESS',
    actorId: user.id,
    details: { count: codes.length, subject_id: subjectId },
  });

  return c.json({ generated_count: codes.length, codes });
});

// POST /api/reseller/codes
resellerRouter.post('/codes', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  if (user.role !== 'reseller' && user.role !== 'admin') {
    return c.json({ detail: 'هذه الواجهة مخصصة للمندوبين فقط' }, 403);
  }

  const count = parseInt(c.req.query('count') ?? '1');
  const subjectId = c.req.query('subject_id') ?? null;

  if (count < 1 || count > 100) return c.json({ detail: 'العدد يجب أن يكون بين 1 و100' }, 400);

  // Quota protection for resellers: max 200 idle/unactivated codes in stock
  if (user.role !== 'admin') {
    const idleCodes = await db
      .select({ id: schema.activationCodes.id })
      .from(schema.activationCodes)
      .where(and(
        eq(schema.activationCodes.reseller_id, user.id),
        eq(schema.activationCodes.status, 'idle')
      ));

    if (idleCodes.length + count > 200) {
      return c.json({ detail: 'تجاوزت الحد المسموح للأكواد غير المفعلة في المخزون (200 كود)' }, 429);
    }
  }

  if (subjectId) {
    const subject = await db.select().from(schema.subjects).where(eq(schema.subjects.id, subjectId)).get();
    if (!subject) return c.json({ detail: 'المادة غير موجودة' }, 404);
  }

  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    const codeStr = `NBD-${randomHex.slice(0, 4)}-${randomHex.slice(4, 8)}`;
    await db.insert(schema.activationCodes).values({
      id: schema.genId(),
      code: codeStr,
      subject_id: subjectId,
      status: 'idle',
      reseller_id: user.id,
    });
    codes.push(codeStr);
  }

  recordAuditEvent({
    event: 'RESELLER_CODES_GENERATED',
    status: 'SUCCESS',
    actorId: user.id,
    details: { count: codes.length, subject_id: subjectId },
  });

  return c.json({ codes });
});

// POST /api/reseller/codes/:id/sell
resellerRouter.post('/codes/:id/sell', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  if (user.role !== 'reseller' && user.role !== 'admin') {
    return c.json({ detail: 'هذه الواجهة مخصصة للمندوبين فقط' }, 403);
  }
  const id = c.req.param('id');

  const code = await db
    .select()
    .from(schema.activationCodes)
    .where(and(
      eq(schema.activationCodes.id, id),
      user.role === 'admin' ? sql`1=1` : eq(schema.activationCodes.reseller_id, user.id)
    ))
    .get();

  if (!code) return c.json({ detail: 'الكود غير موجود أو غير تابع لك' }, 404);

  const now = new Date().toISOString();
  await db
    .update(schema.activationCodes)
    .set({ sold_at: now })
    .where(and(
      eq(schema.activationCodes.id, id),
      user.role === 'admin' ? sql`1=1` : eq(schema.activationCodes.reseller_id, user.id)
    ));

  recordAuditEvent({
    event: 'RESELLER_CODE_SOLD',
    status: 'SUCCESS',
    actorId: user.id,
    targetId: id,
  });

  return c.json({ message: 'تم تعليم الكود كمباع' });
});
