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

// Code stock is allocated by an administrator.  A reseller can sell only the
// codes already assigned to their account; they must never mint new value.
function allocationRequired(c: any) {
  const user = c.get('user')!;
  recordAuditEvent({
    event: 'RESELLER_CODE_MINT_DENIED',
    status: 'DENIED',
    actorId: user.id,
  });
  return c.json({ detail: 'الأكواد تُخصّص حصراً من إدارة المنصة لحساب المندوب' }, 403);
}

resellerRouter.post('/generate', allocationRequired);
resellerRouter.post('/codes', allocationRequired);

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
