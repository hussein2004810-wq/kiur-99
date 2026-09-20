import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { MAX_DIRECT_UPLOAD_BYTES } from '../services/storage';

/**
 * Global Body Size Limit Middleware (Stage 7).
 * Caps standard JSON requests to 100 KB and upload routes to 25 MB.
 */
export const bodySizeLimitMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = c.req.path;
  const isUpload = path.includes('/upload') || path.includes('/photo') || path.includes('/booklets') ||
    /^\/api\/professors\/me\/lectures\/[^/]+\/file$/.test(path);
  const maxSize = isUpload ? MAX_DIRECT_UPLOAD_BYTES : 100 * 1024;

  // Check Content-Length header if present before buffering
  const contentLength = c.req.header('Content-Length');
  if (contentLength) {
    const bytes = parseInt(contentLength, 10);
    if (!isNaN(bytes) && bytes > maxSize) {
      return c.json(
        { detail: 'حجم البيانات المرسلة كبير جداً ويتجاوز الحد المسموح به (413 Payload Too Large)' },
        413
      );
    }
  }

  // Wrap body limit
  const limiter = bodyLimit({
    maxSize,
    onError: (ctx) => {
      return ctx.json(
        { detail: 'حجم البيانات المرسلة كبير جداً ويتجاوز الحد المسموح به (413 Payload Too Large)' },
        413
      );
    },
  });

  return limiter(c, next);
};
