import { Hono } from 'hono';
import type { AppEnv } from './types';
import { corsMiddleware } from './middleware/cors';
import { securityHeadersMiddleware } from './middleware/security-headers';
import { csrfProtectionMiddleware } from './middleware/csrf';
import { bodySizeLimitMiddleware } from './middleware/body-limit';
import { errorHandler, notFoundHandler } from './middleware/error';
import { registerStaticRoutes } from './routes/static';

import { authRouter } from './routes/auth';
import { catalogRouter } from './routes/catalog';
import { questionsRouter } from './routes/questions';
import { professorsRouter } from './routes/professors';
import { coursesRouter } from './routes/courses';
import { storeRouter } from './routes/store';
import { adminRouter } from './routes/admin';
import { resellerRouter } from './routes/reseller';
import { activationRouter } from './routes/activation';
import { bansRouter } from './routes/bans';
import { examsRouter } from './routes/exams';
import { notificationsRouter } from './routes/notifications';
import { studentsRouter } from './routes/students';
import { pearlsRouter } from './routes/pearls';
import { publicRouter } from './routes/public';
import { mediaRouter } from './routes/media';

const app = new Hono<AppEnv>();

// 1. Global CORS Middleware (Preflight & request handling)
// 1. Centralized Security Headers (CSP, HSTS, nosniff, etc.)
app.use('*', securityHeadersMiddleware);

// 2. Request Body Size Limiter (100 KB JSON, 25 MB uploads)
app.use('*', bodySizeLimitMiddleware);

// 3. Global CORS Middleware (Preflight & request handling)
app.use('*', corsMiddleware);

// 2. Global Error & 404 Handlers
// 4. CSRF & Untrusted Cross-Site Mutation Protection
app.use('*', csrfProtectionMiddleware);

// 5. Global Error & 404 Handlers
app.onError(errorHandler);
app.notFound(notFoundHandler);

// 3. Static SPA and Health Probe Routes
// 6. Static SPA and Health Probe Routes
registerStaticRoutes(app);

// 4. API & Auth Routers
// 7. API & Auth Routers
app.route('/auth', authRouter);
app.route('/media-files', mediaRouter);

// Mount all /api routes under /api
const api = new Hono<AppEnv>();
api.route('/catalog', catalogRouter);
api.route('/questions', questionsRouter);
api.route('/professors', professorsRouter);
api.route('/courses', coursesRouter);
api.route('/store', storeRouter);
api.route('/admin', adminRouter);
api.route('/reseller', resellerRouter);
api.route('/activation', activationRouter);
api.route('/bans', bansRouter);
api.route('/exams', examsRouter);
api.route('/notifications', notificationsRouter);
api.route('/me/notifications', notificationsRouter);
api.route('/students', studentsRouter);
api.route('/pearls', pearlsRouter);
api.route('/public', publicRouter);

app.route('/api', api);

export default app;
export { app };
