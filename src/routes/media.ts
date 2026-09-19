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

  // Fail-closed: Deny access if no valid database record exists or if deleted
  if (!mediaRecord || mediaRecord.is_deleted) {
    return c.json({ detail: 'الملف غير موجود أو غير مصرح بالوصول إليه' }, 404);
  }

  const objectKey = mediaRecord.filename;

  // 2. Governance check: If media is linked to an unreleased or future clinical glimpse
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

  const storage = createStorageService(c.env.R2_BUCKET);
  const rangeHeader = c.req.header('range') ?? null;

  const result = await storage.getWithRange(objectKey, rangeHeader);

  if (!result) {
    return c.notFound();
  }

  const responseHeaders = new Headers(result.headers);
  // Security hardening: Prevent browser execution/MIME sniffing
  responseHeaders.set('X-Content-Type-Options', 'nosniff');
  responseHeaders.set('Content-Security-Policy', "default-src 'none'; sandbox");

  // If content is not a standard web image, enforce attachment to prevent active content execution
  const contentType = (mediaRecord.content_type || responseHeaders.get('Content-Type') || '').toLowerCase();
  const safeInlineImages = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!safeInlineImages.some(t => contentType.startsWith(t))) {
    responseHeaders.set('Content-Disposition', `attachment; filename="${mediaRecord.filename}"`);
  }

  return new Response(result.object.body as ReadableStream, {
    status: result.status,
    headers: responseHeaders,
  });
});
