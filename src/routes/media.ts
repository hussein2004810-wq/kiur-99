import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, or } from 'drizzle-orm';
import * as schema from '../db/schema';
import { createStorageService } from '../services/storage';
import { authenticateToken } from '../middleware/auth';
import { canAccessMedia } from '../services/content-access';
import type { AppEnv } from '../types';

export const mediaRouter = new Hono<AppEnv>();

const SAFE_MEDIA_CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

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

  // Stored filenames are server-generated from verified signatures.  Never
  // replay a legacy database/R2 MIME value that could make active content
  // render in a browser; unknown extensions are served as downloads.
  const extension = objectKey.split('.').pop()?.toLowerCase() ?? '';
  const contentType = SAFE_MEDIA_CONTENT_TYPES[extension] ?? 'application/octet-stream';

  responseHeaders.set('Content-Type', contentType);
  responseHeaders.set('Accept-Ranges', 'bytes');

  return new Response(result.object.body as ReadableStream, {
    status: result.status,
    headers: responseHeaders,
  });
});
