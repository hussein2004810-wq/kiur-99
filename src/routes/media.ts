import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, or } from 'drizzle-orm';
import * as schema from '../db/schema';
import { createStorageService } from '../services/storage';
import { decodeAccessToken } from '../services/jwt';
import type { AppEnv } from '../types';

export const mediaRouter = new Hono<AppEnv>();

mediaRouter.get('/:name', async (c) => {
  const name = c.req.param('name');

  // Prevent path traversal
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
    return c.json({ detail: 'اسم الملف غير صالح (Path Traversal Detected)' }, 400);
  }

  const db = drizzle(c.env.DB, { schema });

  // 1. Check if name matches a mediaFile record by ID or filename
  const mediaRecord = await db
    .select()
    .from(schema.mediaFiles)
    .where(or(eq(schema.mediaFiles.id, name), eq(schema.mediaFiles.filename, name)))
    .get();

  const objectKey = mediaRecord ? mediaRecord.filename : name;

  // 2. Governance check: If media is linked to an unreleased or future clinical glimpse
  if (mediaRecord) {
    const linkedGlimpse = await db
      .select()
      .from(schema.clinicalGlimpses)
      .where(eq(schema.clinicalGlimpses.image_id, mediaRecord.id))
      .get();

    if (linkedGlimpse) {
      const now = new Date().toISOString();
      const isFuture = linkedGlimpse.publish_at && linkedGlimpse.publish_at > now;
      const isUnpublished = linkedGlimpse.status !== 'published';

      if (isFuture || isUnpublished) {
        // Check if requester is admin/staff
        let isStaff = false;
        const authHeader = c.req.header('Authorization') ?? '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (token) {
          const payload = await decodeAccessToken(token, c.env.JWT_SECRET);
          if (payload?.sub) {
            const user = await db.select().from(schema.users).where(eq(schema.users.id, payload.sub)).get();
            if (user && (user.role === 'admin' || user.role === 'professor')) {
              isStaff = true;
            }
          }
        }

        if (!isStaff) {
          return c.json({ detail: 'غير مصرح بالوصول إلى وسائط لم تنشر بعد' }, 403);
        }
      }
    }
  }

  const storage = createStorageService(c.env.R2_BUCKET);
  const rangeHeader = c.req.header('range') ?? null;

  const result = await storage.getWithRange(objectKey, rangeHeader);

  if (!result) {
    return c.notFound();
  }

  return new Response(result.object.body as ReadableStream, {
    status: result.status,
    headers: result.headers,
  });
});
