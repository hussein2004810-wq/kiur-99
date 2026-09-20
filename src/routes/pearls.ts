/**
 * Clinical Pearls routes — mirrors Python app/routers/pearls.py
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { requireAuth, optionalAuth } from '../middleware/auth';

export const pearlsRouter = new Hono<AppEnv>();

// GET /api/pearls/preview — no auth required
pearlsRouter.get('/preview', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const limit = Math.min(parseInt(c.req.query('limit') ?? '3'), 12);

  const pearls = await db
    .select({ id: schema.clinicalPearls.id, title: schema.clinicalPearls.title, created_at: schema.clinicalPearls.created_at })
    .from(schema.clinicalPearls)
    .orderBy(desc(schema.clinicalPearls.created_at))
    .limit(limit);

  return c.json(pearls);
});

// GET /api/pearls/daily — public
pearlsRouter.get('/daily', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const p = await db.select().from(schema.clinicalPearls).limit(1).get();
  return c.json(p);
});

// GET /api/pearls — optional auth: without auth, mask `body`
pearlsRouter.get('/', optionalAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user');

  const pearls = await db
    .select()
    .from(schema.clinicalPearls)
    .orderBy(desc(schema.clinicalPearls.created_at));

  if (!user) {
    const masked = pearls.map(({ body, ...rest }) => rest);
    return c.json(masked);
  }

  return c.json(pearls);
});

// GET /api/pearls/:pearl_id — optional auth: without auth, mask `body`
pearlsRouter.get('/:pearl_id', optionalAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const pearlId = c.req.param('pearl_id') as string;
  if (!pearlId) return c.json({ detail: 'اللمحة غير موجودة' }, 404);
  const user = c.get('user');

  const pearl = await db
    .select()
    .from(schema.clinicalPearls)
    .where(eq(schema.clinicalPearls.id, pearlId))
    .get();

  if (!pearl) return c.json({ detail: 'اللمحة غير موجودة' }, 404);

  if (!user) {
    const { body, ...rest } = pearl;
    return c.json(rest);
  }

  return c.json(pearl);
});

// POST /api/pearls/:pearl_id/bookmark — requires auth
pearlsRouter.post('/:pearl_id/bookmark', requireAuth, async (c) => {
  return c.json({ message: 'تم حفظ اللمحة السريرية' });
});

// POST /api/pearls/:pearl_id/reaction — requires auth
pearlsRouter.post('/:pearl_id/reaction', requireAuth, async (c) => {
  return c.json({ message: 'تم تسجيل التفاعل' });
});
