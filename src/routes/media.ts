/**
 * Media routes — serves uploaded files (videos, images, pdfs) from R2
 */
import { Hono } from 'hono';
import { createStorageService } from '../services/storage';
import type { AppEnv } from '../types';

export const mediaRouter = new Hono<AppEnv>();

mediaRouter.get('/:name', async (c) => {
  const name = c.req.param('name');
  const storage = createStorageService(c.env.R2_BUCKET);
  const rangeHeader = c.req.header('range') ?? null;

  const result = await storage.getWithRange(name, rangeHeader);
  
  if (!result) {
    return c.notFound();
  }

  return new Response(result.object.body as ReadableStream, {
    status: result.status,
    headers: result.headers,
  });
});
