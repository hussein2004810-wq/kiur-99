/**
 * Public stats routes — mirrors Python app/routers/public.py
 * No authentication required.
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, count } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';

export const publicRouter = new Hono<AppEnv>();

// GET /api/public/stats
publicRouter.get('/stats', async (c) => {
  const db = drizzle(c.env.DB, { schema });

  const [questionsCount] = await db.select({ count: count() }).from(schema.questions);
  const [lecturesCount] = await db.select({ count: count() }).from(schema.lectures);
  const [pearlsCount] = await db.select({ count: count() }).from(schema.clinicalPearls);

  // Count professors (via professor profiles joined to non-banned users)
  const profProfiles = await db
    .select({ user_id: schema.professorProfiles.user_id })
    .from(schema.professorProfiles);

  let professorsCount = 0;
  if (profProfiles.length > 0) {
    const userIds = profProfiles.map((p) => p.user_id);
    let unbanned = 0;
    for (const userId of userIds) {
      const u = await db.select({ is_banned: schema.users.is_banned }).from(schema.users).where(eq(schema.users.id, userId)).get();
      if (u && !u.is_banned) unbanned++;
    }
    professorsCount = unbanned;
  }

  return c.json({
    questions: questionsCount.count,
    professors: professorsCount,
    lectures: lecturesCount.count,
    pearls: pearlsCount.count,
  });
});
