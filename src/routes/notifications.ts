/**
 * Notifications routes — mirrors Python app/routers/notifications.py
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, or, isNull, desc } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { requireAuth } from '../middleware/auth';

export const notificationsRouter = new Hono<AppEnv>();
notificationsRouter.use('*', requireAuth);

// GET /api/me/notifications
notificationsRouter.get('/', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '30'), 100);

  const notifs = await db
    .select()
    .from(schema.notifications)
    .where(or(eq(schema.notifications.user_id, user.id), isNull(schema.notifications.user_id)))
    .orderBy(desc(schema.notifications.created_at))
    .limit(limit);

  const reads = await db
    .select()
    .from(schema.notificationReads)
    .where(eq(schema.notificationReads.user_id, user.id));

  const readIds = new Set(reads.map((r) => r.notification_id));

  return c.json(
    notifs.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      created_at: n.created_at,
      read: readIds.has(n.id),
    }))
  );
});

// GET /api/me/notifications/unread-count
notificationsRouter.get('/unread-count', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;

  const allNotifs = await db
    .select({ id: schema.notifications.id })
    .from(schema.notifications)
    .where(or(eq(schema.notifications.user_id, user.id), isNull(schema.notifications.user_id)));

  const reads = await db
    .select()
    .from(schema.notificationReads)
    .where(eq(schema.notificationReads.user_id, user.id));

  const readIds = new Set(reads.map((r) => r.notification_id));
  const count = allNotifs.filter((n) => !readIds.has(n.id)).length;

  return c.json({ count });
});

// POST /api/me/notifications/:notification_id/read
notificationsRouter.post('/:notification_id/read', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const notificationId = c.req.param('notification_id');

  const existing = await db
    .select()
    .from(schema.notificationReads)
    .where(
      eq(schema.notificationReads.notification_id, notificationId) &&
      eq(schema.notificationReads.user_id, user.id)
    )
    .get();

  if (!existing) {
    await db.insert(schema.notificationReads).values({
      id: schema.genId(),
      notification_id: notificationId,
      user_id: user.id,
    });
  }
  return c.json({ ok: true });
});
