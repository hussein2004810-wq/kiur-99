/**
 * Reseller routes — mirrors Python app/routers/reseller.py
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { requireAuth } from '../middleware/auth';

export const resellerRouter = new Hono<AppEnv>();
resellerRouter.use('*', requireAuth);

function requireReseller(user: { role: string }) {
  if (user.role !== 'reseller') throw new Error('403');
}

// GET /api/reseller/summary
resellerRouter.get('/summary', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  if (user.role !== 'reseller') return c.json({ detail: 'هذه الواجهة مخصصة للمندوبين فقط' }, 403);

  const codes = await db.select().from(schema.activationCodes).where(eq(schema.activationCodes.reseller_id, user.id));
  const sold = codes.filter((c) => c.sold_at !== null);
  const activated = codes.filter((c) => c.status === 'active');

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

// GET /api/reseller/codes
resellerRouter.get('/codes', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  if (user.role !== 'reseller') return c.json({ detail: 'هذه الواجهة مخصصة للمندوبين فقط' }, 403);

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

// POST /api/reseller/codes
resellerRouter.post('/codes', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  if (user.role !== 'reseller') return c.json({ detail: 'هذه الواجهة مخصصة للمندوبين فقط' }, 403);

  const count = parseInt(c.req.query('count') ?? '1');
  const subjectId = c.req.query('subject_id') ?? null;

  if (count < 1 || count > 100) return c.json({ detail: 'العدد يجب أن يكون بين 1 و100' }, 400);
  if (subjectId) {
    const subject = await db.select().from(schema.subjects).where(eq(schema.subjects.id, subjectId)).get();
    if (!subject) return c.json({ detail: 'المادة غير موجودة' }, 404);
  }

  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(3))).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const codeStr = `NBD-${randomHex}`;
    await db.insert(schema.activationCodes).values({
      id: schema.genId(),
      code: codeStr,
      subject_id: subjectId,
      status: 'idle',
      reseller_id: user.id,
    });
    codes.push(codeStr);
  }

  return c.json({ codes });
});
