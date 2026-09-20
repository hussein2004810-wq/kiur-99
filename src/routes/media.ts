import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, or } from 'drizzle-orm';
import * as schema from '../db/schema';
import { createStorageService } from '../services/storage';
import { authenticateToken } from '../middleware/auth';
import { canAccessMedia } from '../services/content-access';
import type { AppEnv } from '../types';

export const mediaRouter = new Hono<AppEnv>();

mediaRouter.get('/:name', async (c) => {
  const name = c.req.param('name');

  // Prevent path traversal
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
    return c.json({ detail: 'اسم الملف غير صالح (Path Traversal Detected)' }, 400);
  }

  const db = drizzle(c.env.DB, { schema });

  // Security defense: Block internal/secret files even if present in R2 (P0-7 invariant)
  if (name.startsWith('internal_') || name.includes('secret') || name.endsWith('.env')) {
    return c.json({ detail: 'الملف غير موجود أو غير مصرح بالوصول إليه' }, 404);
  }

  // 1. Check if name matches a mediaFile record by ID or filename
  const mediaRecord = await db
    .select()
    .from(schema.mediaFiles)
    .where(or(eq(schema.mediaFiles.id, name), eq(schema.mediaFiles.filename, name)))
    .get();

  // Never treat an R2 object key as an authorization record.  Orphaned data
  // remains unreachable even when the object still exists in storage.
  if (!mediaRecord || mediaRecord.is_deleted) {
    return c.json({ detail: 'الملف غير موجود أو غير مصرح بالوصول إليه' }, 404);
  }

  const objectKey = mediaRecord.filename;

  // 2. Governance check: If media is linked to an unreleased or future clinical glimpse
  const linkedGlimpse = await db.select().from(schema.clinicalGlimpses)
    .where(eq(schema.clinicalGlimpses.image_id, mediaRecord.id)).get();
  const isPublicProfilePhoto = Boolean(await db.select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.photo_url, mediaRecord.url)).get());
  const now = new Date().toISOString();
  const isPublishedPublicImage = Boolean(
    linkedGlimpse && linkedGlimpse.status === 'published' &&
    (!linkedGlimpse.publish_at || linkedGlimpse.publish_at <= now)
  );

  if (!isPublishedPublicImage && !isPublicProfilePhoto) {
    const authHeader = c.req.header('Authorization') ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const auth = token ? await authenticateToken(db, token, c.env.JWT_SECRET) : null;
    if (!auth?.success || !(await canAccessMedia(db, auth.user, mediaRecord))) {
      return c.json({ detail: 'غير مصرح بالوصول إلى هذا الوسيط' }, 403);
    }
  }

  const storage = createStorageService(c.env.R2_BUCKET);
  const rangeHeader = c.req.header('range') ?? null;

  const result = await storage.getWithRange(objectKey, rangeHeader);

  if (!result) {
    return c.json({ detail: 'الملف غير موجود' }, 404);
  }

  const responseHeaders = new Headers(result.headers);
  // Security hardening: Prevent browser execution/MIME sniffing
  responseHeaders.set('X-Content-Type-Options', 'nosniff');
  responseHeaders.set('Content-Security-Policy', "default-src 'none'; sandbox");

  // Determine correct content-type
  let contentType = mediaRecord?.content_type || responseHeaders.get('Content-Type') || 'application/octet-stream';
  if (name.endsWith('.mp4')) contentType = 'video/mp4';
  else if (name.endsWith('.pdf')) contentType = 'application/pdf';
  else if (name.endsWith('.png')) contentType = 'image/png';
  else if (name.endsWith('.jpg') || name.endsWith('.jpeg')) contentType = 'image/jpeg';
  else if (name.endsWith('.webp')) contentType = 'image/webp';

  responseHeaders.set('Content-Type', contentType);
  responseHeaders.set('Accept-Ranges', 'bytes');

  return new Response(result.object.body as ReadableStream, {
    status: result.status,
    headers: responseHeaders,
  });
});
