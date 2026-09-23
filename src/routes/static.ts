import type { Hono } from 'hono';
import type { AppEnv } from '../types';
import homeHtml from '../../public/nabd-home-quiz-prototype.html';
import adminHtml from '../../public/nabd-admin-dashboard.html';

const SPA_HEADERS = {
  'Cache-Control': 'no-cache',
  'Content-Type': 'text/html; charset=utf-8',
};

function copySpaResponse(response: Response): Response {
  // Cloudflare Assets returns HTML with its own default CSP. That policy
  // overrides the Worker middleware's nonce/hash policy and blocks the app's
  // inline JavaScript, leaving the whole SPA visibly rendered but inert.
  // Keep the security headers from the Worker and only transfer asset headers
  // needed for the document body and cache behavior.
  const headers = new Headers(SPA_HEADERS);
  const contentLanguage = response.headers.get('Content-Language');
  if (contentLanguage) headers.set('Content-Language', contentLanguage);
  return new Response(response.body, { status: response.status, headers });
}

export function registerStaticRoutes(app: Hono<AppEnv>) {
  // 1. Health Probe
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Readiness is intentionally separate from the cheap liveness probe.  An
  // uptime monitor can use this route to detect a Worker that is reachable
  // but cannot serve students because D1 is unavailable.
  app.get('/health/ready', async (c) => {
    try {
      const probe = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
      if (!probe?.ok) throw new Error('D1 readiness probe returned no result');
      return c.json({ status: 'ok', database: 'ok' });
    } catch {
      return c.json({ status: 'unavailable', database: 'unavailable' }, 503);
    }
  });

  // 2. Student SPA Root (GET /)
  app.get('/', async (c) => {
    if (c.env?.ASSETS) {
      const url = new URL(c.req.url);
      url.pathname = '/nabd-home-quiz-prototype.html';
      const res = await c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
      if (res.ok) {
        return copySpaResponse(res);
      }
    }
    return c.html(homeHtml, 200, SPA_HEADERS);
  });

  // 3. Admin SPA Root (GET /admin and GET /admin/)
  const serveAdmin = async (c: any) => {
    if (c.env?.ASSETS) {
      const url = new URL(c.req.url);
      url.pathname = '/nabd-admin-dashboard.html';
      const res = await c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
      if (res.ok) {
        return copySpaResponse(res);
      }
    }
    return c.html(adminHtml, 200, SPA_HEADERS);
  };

  app.get('/admin', serveAdmin);
  app.get('/admin/', serveAdmin);
}
