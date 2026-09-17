/**
 * Clinical Pearls routes — mirrors Python app/routers/pearls.py
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { requireAuth } from '../middleware/auth';

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

// All remaining routes require auth
pearlsRouter.use('*', requireAuth);

// GET /api/pearls
pearlsRouter.get('/', async (c) => {
  const db = drizzle(c.env.DB, { schema });

  const pearls = await db
    .select()
    .from(schema.clinicalPearls)
    .orderBy(desc(schema.clinicalPearls.created_at));

  return c.json(pearls);
});

// GET /api/pearls/:pearl_id
pearlsRouter.get('/:pearl_id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const pearlId = c.req.param('pearl_id');

  const pearl = await db
    .select()
    .from(schema.clinicalPearls)
    .where(eq(schema.clinicalPearls.id, pearlId))
    .get();

  if (!pearl) return c.json({ detail: 'اللمحة غير موجودة' }, 404);
  return c.json(pearl);
});
