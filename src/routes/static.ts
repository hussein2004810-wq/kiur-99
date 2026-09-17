import type { Hono } from 'hono';
import type { AppEnv } from '../types';
import homeHtml from '../../public/nabd-home-quiz-prototype.html';
import adminHtml from '../../public/nabd-admin-dashboard.html';

const SPA_HEADERS = {
  'Cache-Control': 'no-cache',
  'Content-Type': 'text/html; charset=utf-8',
};

export function registerStaticRoutes(app: Hono<AppEnv>) {
  // 1. Health Probe
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // 2. Student SPA Root (GET /)
  app.get('/', async (c) => {
    if (c.env?.ASSETS) {
      const url = new URL(c.req.url);
      url.pathname = '/nabd-home-quiz-prototype.html';
      const res = await c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
      if (res.ok) {
        const headers = new Headers(res.headers);
        headers.set('Cache-Control', 'no-cache');
        headers.set('Content-Type', 'text/html; charset=utf-8');
        return new Response(res.body, { status: res.status, headers });
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
        const headers = new Headers(res.headers);
        headers.set('Cache-Control', 'no-cache');
        headers.set('Content-Type', 'text/html; charset=utf-8');
        return new Response(res.body, { status: res.status, headers });
      }
    }
    return c.html(adminHtml, 200, SPA_HEADERS);
  };

  app.get('/admin', serveAdmin);
  app.get('/admin/', serveAdmin);
}
