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

// GET /api/me/notifications or /api/notifications
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
      is_read: readIds.has(n.id) ? 1 : 0,
    }))
  );
});

// GET /unread-count
notificationsRouter.get('/unread-count', async (c) => {
  const user = c.get('user')!;
  const total = await c.env.DB.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id IS NULL OR user_id = ?')
    .bind(user.id).first('c');
  const read = await c.env.DB.prepare('SELECT COUNT(*) as c FROM notification_reads WHERE user_id = ?')
    .bind(user.id).first('c');
  const unread = Math.max(0, Number(total ?? 0) - Number(read ?? 0));
  return c.json({ unread_count: unread, count: unread });
});

// POST & PATCH /:id/read or /:notification_id/read
const markAsRead = async (c: any) => {
  const user = c.get('user')!;
  const notificationId = c.req.param('notification_id') || c.req.param('id');
  const notif = await c.env.DB.prepare('SELECT id FROM notifications WHERE id = ?').bind(notificationId).first();
  if (!notif) return c.json({ detail: 'الإشعار غير موجود' }, 404);

  const nrId = 'nr_' + Math.random().toString(36).substring(2, 10);
  await c.env.DB.prepare('INSERT OR IGNORE INTO notification_reads (id, notification_id, user_id) VALUES (?, ?, ?)')
    .bind(nrId, notificationId, user.id).run();
  return c.json({ ok: true, message: 'تم تعليم الإشعار كمقروء' });
};

notificationsRouter.post('/:id/read', markAsRead);
notificationsRouter.patch('/:id/read', markAsRead);
notificationsRouter.post('/:notification_id/read', markAsRead);
notificationsRouter.patch('/:notification_id/read', markAsRead);

// POST /read-all
notificationsRouter.post('/read-all', async (c) => {
  const user = c.get('user')!;
  const notifs = await c.env.DB.prepare('SELECT id FROM notifications WHERE user_id IS NULL OR user_id = ?').bind(user.id).all();
  for (const n of (notifs.results ?? []) as any[]) {
    const nrId = 'nr_' + Math.random().toString(36).substring(2, 10);
    await c.env.DB.prepare('INSERT OR IGNORE INTO notification_reads (id, notification_id, user_id) VALUES (?, ?, ?)')
      .bind(nrId, n.id, user.id).run();
  }
  return c.json({ ok: true, message: 'تم تعليم جميع الإشعارات كمقروءة', marked_read: notifs.results?.length ?? 0 });
});
