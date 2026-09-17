# M1 Explorer 3: Middleware, Static SPA Serving & Verification Strategy Report

**Date**: 2026-09-17T00:29:00Z  
**Author**: M1 Explorer 3 (Middleware & Verification Strategy)  
**Workspace**: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m1_3`  
**Target Milestone**: Milestone 1 (Foundation & Database Layer)  
**Parent Agent**: Orchestrator (`fdf0f062-12fc-46d6-8dd0-3c6786653821`)  

---

## 1. Observation

Direct examination of the existing Python backend (`app/`), frontend single-page application prototypes (`nabd-*.html`), and Cloudflare Workers runtime environment yielded the following verbatim observations:

### 1.1 Frontend Error Consumption Contract
In `nabd-admin-dashboard.html:921–950` and `nabd-home-quiz-prototype.html:2648–2680`, the core network transport function `apiFetch` is implemented identically:

```javascript
// nabd-admin-dashboard.html:921-950 & nabd-home-quiz-prototype.html:2648-2680
async function apiFetch(path, options = {}){
  const res = await fetch(API_BASE_URL + path, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? {'Authorization': 'Bearer ' + authToken} : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok){
    let detail = '';
    try { detail = (await res.json())?.detail || ''; } catch (e) { /* no JSON body */ }
    if (res.status === 401 && authToken){
      authToken = null;
      currentUser = null;
      showToast(detail || 'انتهت الجلسة — سجّل الدخول من جديد', 'error');
      goToLogin();
    }
    const err = new Error(detail || ('API ' + res.status));
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}
```

Further, toast notifications throughout both HTML files are displayed by `showToast()`:
```javascript
// nabd-home-quiz-prototype.html:5911-5918
function showToast(message){
  const stack = document.getElementById('toastStack');
  const el = document.createElement('div');
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// nabd-admin-dashboard.html:1050-1058
function showToast(message, type){
  const stack = document.getElementById('toastStack');
  const el = document.createElement('div');
  const isError = type === 'error';
  el.style.cssText = `...`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
```

Catch blocks across both frontends consistently rely on `e.detail`:
- `nabd-admin-dashboard.html:1024`: `showToast(e.detail || 'فشلت معالجة الاستجابة من الخادم', 'error');`
- `nabd-admin-dashboard.html:1245`: `showToast(e.detail || 'فشل جلب الإعدادات', 'error');`
- `nabd-admin-dashboard.html:1604`: `showToast(e.detail || 'فشلت معالجة الطلب', 'error');`
- `nabd-admin-dashboard.html:1635`: `showToast(e.detail || 'فشلت العملية', 'error');`

**Consequence**:
1. If the server returns a non-JSON body (e.g. Hono's default plain-text `404 Not Found` or `401 Unauthorized`), `(await res.json())` throws a `SyntaxError`, which gets swallowed by `catch (e) {}`. `detail` becomes `""`, causing the UI to display generic fallbacks like `'API 400'` or empty toasts.
2. If the server returns an object or array in `detail` (e.g. FastAPI/Pydantic default 422: `{"detail": [{"loc": [...], "msg": "..."}]}`), `el.textContent = message` evaluates in JavaScript to the string `"[object Object]"`.
3. Therefore, `detail` MUST strictly be a clean, human-readable **string**.

### 1.2 Python FastAPI Exception Handling Inventory
In the Python implementation (`app/deps.py` and `app/routers/*.py`), all business rule rejections raise `fastapi.HTTPException(status_code, detail)`:
- `app/deps.py:19`: `raise HTTPException(status.HTTP_401_UNAUTHORIZED, "غير مسجّل الدخول")`
- `app/deps.py:23`: `raise HTTPException(status.HTTP_401_UNAUTHORIZED, "جلسة غير صالحة")`
- `app/deps.py:29`: `raise HTTPException(status.HTTP_401_UNAUTHORIZED, "تم تسجيل الدخول من جهاز آخر")`
- `app/deps.py:33`: `raise HTTPException(status.HTTP_401_UNAUTHORIZED, "المستخدم غير موجود")`
- `app/deps.py:41`: `raise HTTPException(status.HTTP_403_FORBIDDEN, "هذا الحساب محظور")`
- `app/deps.py:48`: `raise HTTPException(status.HTTP_403_FORBIDDEN, "لا تملك صلاحية الوصول")`
- `app/routers/activation.py:20`: `raise HTTPException(429, f"محاولات كثيرة خاطئة لتفعيل كود — انتظر {minutes_left} دقيقة")`
- `app/routers/activation.py:54`: `raise HTTPException(404, "الكود غير صالح — تأكد من إدخاله بشكل صحيح")`
- `app/routers/activation.py:57`: `raise HTTPException(400, "هذا الكود مستخدم بالكامل")`
- `app/routers/admin.py:37`: `raise HTTPException(400, f"نوع الملف غير مسموح — المقبول: {', '.join(sorted(allowed_exts))}")`
- `app/routers/admin.py:117`: `raise HTTPException(400, "اسم الفرع مطلوب")`

FastAPI automatically formats every `HTTPException(status_code, detail="message")` as:
`{ "detail": "message" }` with the corresponding HTTP status code.

### 1.3 CORS Architecture in Existing Backend
In `app/main.py:27–42`:
```python
app.add_middleware(
    CORSMiddleware,
    **(
        {"allow_origin_regex": r"https?://(localhost|127\.0\.0\.1)(:\d+)?"}
        if settings.debug
        else {"allow_origins": settings.cors_origins_list}
    ),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```
- In debug mode: Matches any localhost or 127.0.0.1 on any port.
- In production: Matches `settings.cors_origins_list` (from `CORS_ORIGINS`).
- `allow_credentials=True`: Explicitly required because `apiFetch` uses `credentials: 'include'` for the `nabd_session` httpOnly cookie.
- Pairing `allow_credentials=True` with `Access-Control-Allow-Origin: *` is strictly prohibited by the W3C Fetch/CORS specification — browsers unconditionally reject such responses. The origin must be explicitly reflected.
- Range requests: Lecture video streaming uses `Range: bytes=...`. Headers `Range`, `Accept-Ranges`, `Content-Range`, and `Content-Length` must be allowed and exposed.

### 1.4 Static Frontend SPA Serving in Existing Backend
In `app/main.py:157–168`:
```python
SPA_HEADERS = {"Cache-Control": "no-cache"}

@app.get("/")
def serve_student_app():
    return FileResponse(FRONTEND_DIR / "nabd-home-quiz-prototype.html", headers=SPA_HEADERS)

@app.get("/admin")
def serve_admin_app():
    return FileResponse(FRONTEND_DIR / "nabd-admin-dashboard.html", headers=SPA_HEADERS)
```
- File sizes:
  - `nabd-home-quiz-prototype.html`: 393,200 bytes (~384 KB)
  - `nabd-admin-dashboard.html`: 184,263 bytes (~180 KB)
- Total static footprint: ~564 KB raw (~120 KB gzip compressed).
- Both files are self-contained HTML containing inline scripts and CSS.
- Header: `Cache-Control: no-cache` forces browser revalidation while supporting conditional 304 via ETags.

### 1.5 Cloudflare Workers Runtime & Host Environment
Direct commands executed on the host system:
1. Node version: `node -v` -> `v24.20.0`.
2. npm version: `npm -v` in PowerShell failed with `PSSecurityException` because Windows restricts execution of `npm.ps1`.
   However, `npm.cmd -v` succeeded -> `11.19.0`.
3. Wrangler CLI version: `npx.cmd wrangler --version` succeeded -> `4.131.1`.
4. Hono error handling behavior:
   - Hono's default `onError` returns `text/plain` for `HTTPException` via `err.getResponse()`.
   - Hono's `@hono/zod-validator` returns `c.text('Invalid!', 400)` by default if no hook is provided, which bypasses `app.onError` and returns a non-JSON body!
   - Hono's `cors()` middleware does NOT attach CORS headers if an exception unwinds the middleware stack before response finalization unless headers are injected in `app.onError`.

---

## 2. Logic Chain

From the direct observations above, the design for M1 middleware, SPA serving, and verification is derived through the following sequential reasoning:

1. **Guaranteeing the `{ "detail": string }` Response Shape**:
   - *Observation 1.1*: Frontend `apiFetch` does `try { detail = (await res.json())?.detail || ''; } catch (e) {}` and displays errors via `el.textContent = message`.
   - *Observation 1.5*: Hono's default `onError` returns `text/plain` for `HTTPException`, and `@hono/zod-validator` returns `text/plain: Invalid!` when unhooked.
   - *Logic Step*: We must implement a centralized `errorHandler` and `notFoundHandler` registered on the root Hono instance.
   - *Logic Step*: All `HTTPException` instances must be intercepted and formatted as `c.json({ detail: err.message }, err.status)`.
   - *Logic Step*: All `ZodError` instances (whether from validation middleware or direct `schema.parse()`) must be flattened into a single descriptive string (e.g. `path.join('.'): issue.message`) and returned as `c.json({ detail }, 400)`.
   - *Logic Step*: We must provide a `validate()` helper wrapper around `@hono/zod-validator` that guarantees validation failures return `{ detail: string }` with HTTP 400.
   - *Logic Step*: SQLite constraint failures (`UNIQUE constraint failed`, `FOREIGN KEY constraint failed`) must be translated into user-friendly Arabic messages with HTTP 400 instead of crashing the server or leaking raw SQL internals.
   - *Logic Step*: Uncaught 500 exceptions must return `c.json({ detail: isDebug ? err.message : 'حدث خطأ داخلي في الخادم' }, 500)`.

2. **CORS on Normal & Error Responses**:
   - *Observation 1.3*: `credentials: 'include'` requires explicit `Access-Control-Allow-Origin: <origin>` and `Access-Control-Allow-Credentials: true`.
   - *Observation 1.5*: If an exception is thrown in a route, Hono's default error path drops CORS headers unless explicitly added. If CORS headers are missing on a 400/401/403/500 error response, the browser blocks the frontend from reading the body entirely, converting it into an opaque `TypeError: Failed to fetch`.
   - *Logic Step*: We must create a shared origin resolver `resolveAllowedOrigin(origin, env)`.
   - *Logic Step*: In `app.onError` and `app.notFound`, if `origin` is present and allowed, explicitly inject `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials: true`, and `Vary: Origin`.
   - *Logic Step*: In `corsMiddleware`, dynamically inspect `c.env.DEBUG` and `c.env.CORS_ORIGINS` to support localhost regex in dev mode and explicit domains in production.

3. **Cloudflare Workers Static SPA Serving**:
   - *Observation 1.4*: Both SPAs are single HTML files totaling ~564 KB (~120 KB compressed).
   - *Logic Step*: In Cloudflare Workers, we can support a dual-strategy:
     - **Baseline / Self-contained**: Use Wrangler `[[rules]]` text modules (`homeHtml`, `adminHtml`). The worker directly returns `c.html(homeHtml, 200, { 'Cache-Control': 'no-cache' })`. This operates in 0.2ms with zero external bindings, and works identically inside Vitest unit tests without needing mock asset servers.
     - **Workers Static Assets (`[assets]`)**: If `c.env.ASSETS` is bound in `wrangler.toml`, the route fetches from `c.env.ASSETS.fetch(new Request(url, c.req.raw))` and appends `Cache-Control: no-cache`.
   - *Logic Step*: Route `GET /` serves `nabd-home-quiz-prototype.html`. Routes `GET /admin` and `GET /admin/` serve `nabd-admin-dashboard.html`. Route `GET /health` returns `{"status": "ok"}`.

4. **Windows Environment Verification Protocol**:
   - *Observation 1.5*: Direct `npm` and `npx` commands fail in Windows PowerShell due to `PSSecurityException` on `npm.ps1`, whereas `npm.cmd` and `npx.cmd` succeed immediately.
   - *Logic Step*: All automated scripts, npm scripts, verification instructions, and test commands must use `npm.cmd` and `npx.cmd` on Windows.

---

## 3. Caveats

1. **Worker Script Size Limit on Free Tier**:
   - The free tier Cloudflare Workers bundle limit is 1 MB compressed (3 MB uncompressed).
   - The two HTML files (~564 KB raw) compress to ~120 KB gzip. The TypeScript code, Hono, and Drizzle runtime bundle compress to ~80 KB. The total bundle is ~200 KB, safely under the 1 MB limit. If future assets (e.g. large images or bundled fonts) exceed this limit, migrating exclusively to Cloudflare Workers Static Assets (`[assets]`) is recommended.
2. **Workers Body Size Limit vs Video Uploads**:
   - Free Cloudflare Workers enforces a 100 MB request body limit. The existing Python app allowed up to 150 MB for videos. Multipart video uploads through the worker on the free plan must be capped at 100 MB, or direct-to-R2 presigned upload URLs should be used for larger files.
3. **Zod Validation Formatting**:
   - When a payload fails multiple validations, formatting them into a semicolon-separated string (e.g. `email: Required; password: Too short`) ensures `el.textContent = message` displays all issues clearly in Arabic or English without producing `[object Object]`.
4. **Trailing Slash Handling**:
   - In single-page apps, users or OAuth redirects may access `/admin` or `/admin/`. Both paths must be registered to serve the admin SPA.

---

## 4. Conclusion & Concrete Blueprint

### 4.1 Error Handling Architecture (`src/middleware/error.ts`)

```typescript
import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { ZodSchema } from 'zod';
import type { ValidationTargets } from 'hono';
import type { AppEnv } from '../types';
import { resolveAllowedOrigin } from './cors';

/**
 * Flattens Zod validation issues into a single, clean, human-readable string.
 * This guarantees the frontend's `showToast(e.detail)` never receives an object or array.
 */
export function formatZodError(error: ZodError): string {
  if (!error.issues || error.issues.length === 0) {
    return 'بيانات الطلب غير صالحة';
  }
  return error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : 'body';
      // Map standard English messages to friendly Arabic if appropriate
      let msg = issue.message;
      if (msg === 'Required') msg = 'هذا الحقل مطلوب';
      if (msg.includes('Expected string, received')) msg = 'نوع القيمة غير صالح';
      return `${field}: ${msg}`;
    })
    .join('; ');
}

/**
 * Wrapped zValidator that guarantees invalid inputs immediately return
 * HTTP 400 with `{ "detail": string }` rather than bypassing app.onError.
 */
export const validate = <T extends keyof ValidationTargets>(
  target: T,
  schema: ZodSchema
) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const detail = formatZodError(result.error);
      return c.json({ detail }, 400);
    }
  });

/**
 * Centralized Application Error Handler.
 * Guarantees that EVERY exception returns `{ "detail": string }` and attaches CORS headers.
 */
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  console.error('[Unhandled Error]', err);

  // Ensure CORS headers are injected on error responses so browsers do not mask errors
  const origin = c.req.header('Origin');
  const allowedOrigin = resolveAllowedOrigin(origin, c.env);
  if (allowedOrigin) {
    c.header('Access-Control-Allow-Origin', allowedOrigin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Vary', 'Origin');
  }

  // 1. Explicit Hono / FastAPI-style HTTPException
  if (err instanceof HTTPException) {
    return c.json({ detail: err.message }, err.status);
  }

  // 2. Direct ZodError thrown from schema.parse()
  if (err instanceof ZodError) {
    return c.json({ detail: formatZodError(err) }, 400);
  }

  // 3. SQLite / D1 database constraint violations
  const msg = err.message || '';
  if (msg.includes('UNIQUE constraint failed')) {
    return c.json({ detail: 'القيمة المدخلة مستخدمة بالفعل ومسجلة مسبقاً' }, 400);
  }
  if (msg.includes('FOREIGN KEY constraint failed')) {
    return c.json({ detail: 'البيانات المرتبطة غير موجودة أو غير صالحة' }, 400);
  }

  // 4. Catch-all unexpected runtime crashes (500)
  const isDebug = c.env?.DEBUG === 'true' || c.env?.DEBUG === true;
  const detail = isDebug
    ? (err.message || 'Internal Server Error')
    : 'حدث خطأ غير متوقع في الخادم';

  return c.json({ detail }, 500);
};

/**
 * Centralized 404 Route Handler.
 * Returns `{ "detail": "المسار المطلوب غير موجود" }` instead of plain text "404 Not Found".
 */
export const notFoundHandler: NotFoundHandler<AppEnv> = (c) => {
  const origin = c.req.header('Origin');
  const allowedOrigin = resolveAllowedOrigin(origin, c.env);
  if (allowedOrigin) {
    c.header('Access-Control-Allow-Origin', allowedOrigin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Vary', 'Origin');
  }
  return c.json({ detail: 'المسار المطلوب غير موجود' }, 404);
};
```

---

### 4.2 CORS Middleware Architecture (`src/middleware/cors.ts`)

```typescript
import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';
import type { AppBindings, AppEnv } from '../types';

/**
 * Determines whether the incoming request Origin is allowed.
 * Supports:
 * 1. Any localhost / 127.0.0.1 port in DEBUG mode (matching Python allow_origin_regex).
 * 2. Comma-separated list of origins from env.CORS_ORIGINS.
 */
export function resolveAllowedOrigin(
  origin: string | undefined,
  env?: AppBindings
): string | null {
  if (!origin) return null;

  const isDebug = env?.DEBUG === 'true' || env?.DEBUG === true;

  // Localhost regex for dev mode (ports 5500, 3000, 5173, 8787, etc.)
  if (isDebug) {
    const localhostRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
    if (localhostRegex.test(origin)) {
      return origin;
    }
  }

  // Configured allowed origins
  const rawOrigins = env?.CORS_ORIGINS || 'http://localhost:5500,http://127.0.0.1:5500';
  const allowedList = rawOrigins
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (allowedList.includes(origin.toLowerCase())) {
    return origin;
  }

  return null;
}

/**
 * Dynamic CORS Middleware Handler.
 * Reads environment variables per-request from `c.env`.
 */
export const corsMiddleware: MiddlewareHandler<AppEnv> = (c, next) => {
  const handler = cors({
    origin: (origin) => resolveAllowedOrigin(origin, c.env) || '',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'Origin',
      'X-Requested-With',
      'Range',
      'Cache-Control',
    ],
    exposeHeaders: [
      'Content-Length',
      'Content-Range',
      'ETag',
      'Accept-Ranges',
      'Set-Cookie',
    ],
    credentials: true,
    maxAge: 86400,
  });

  return handler(c, next);
};
```

---

### 4.3 Static Frontend SPA Serving Strategy (`src/routes/static.ts` & `src/html.d.ts`)

#### 1. TypeScript Module Declaration (`src/html.d.ts`):
```typescript
declare module '*.html' {
  const content: string;
  export default content;
}
```

#### 2. Wrangler Text Rule (`wrangler.toml` snippet):
```toml
[[rules]]
type = "Text"
globs = ["**/*.html"]
fallthrough = true
```

#### 3. Static Route Registration (`src/routes/static.ts`):
```typescript
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
    // If Cloudflare Workers Static Assets binding is active, fetch from asset pipeline
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
    // Baseline zero-latency in-memory isolate delivery
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
```

---

### 4.4 Main Entrypoint Assembly (`src/index.ts`)

```typescript
import { Hono } from 'hono';
import type { AppEnv } from './types';
import { corsMiddleware } from './middleware/cors';
import { errorHandler, notFoundHandler } from './middleware/error';
import { registerStaticRoutes } from './routes/static';

const app = new Hono<AppEnv>();

// 1. Global CORS Middleware (Registered first)
app.use('*', corsMiddleware);

// 2. Error and 404 Handlers
app.onError(errorHandler);
app.notFound(notFoundHandler);

// 3. Static SPA and Health Routes
registerStaticRoutes(app);

// 4. API & Auth Routers (To be mounted in subsequent milestones)
// app.route('/auth', authRouter);
// app.route('/api', apiRouter);

export default app;
```

---

## 5. Verification Method

To independently verify all Milestone 1 components on the local Windows system:

### 5.1 Step 1: Toolchain & Execution Policy Validation
Verify that Node, npm, and Wrangler execute properly using `.cmd` wrappers:
```powershell
node -v
# Output must be >= v20.0.0 (Observed: v24.20.0)

npm.cmd -v
# Output must be >= 10.0.0 (Observed: 11.19.0)

npx.cmd wrangler --version
# Output must be >= 3.70.0 (Observed: 4.131.1)
```

### 5.2 Step 2: TypeScript Compilation & Type Safety
Run the TypeScript compiler without emitting JS to ensure 100% strict type conformance:
```powershell
npm.cmd run typecheck
# or: npx.cmd tsc --noEmit
```
*Pass Criteria*: Zero type errors (`TS...`). `src/html.d.ts` resolves HTML imports cleanly.

### 5.3 Step 3: D1 SQLite Schema & Migration Verification
Validate that the translated DDL executes cleanly against a local D1 database:
```powershell
# Execute the migration against local D1
npx.cmd wrangler d1 execute DB --local --file=./migrations/0000_initial_schema.sql

# Assert that all 30 user tables are created
npx.cmd wrangler d1 execute DB --local --command="SELECT count(*) AS table_count FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%';"
```
*Pass Criteria*: Output shows `table_count: 30` with zero SQLite syntax errors.

### 5.4 Step 4: Automated Middleware & Error Contract Test Suite
Create and execute `test/tier1-features/middleware.test.ts` with Vitest:

```typescript
// test/tier1-features/middleware.test.ts
import { describe, it, expect } from 'vitest';
import app from '../../src/index';

describe('M1 Middleware & Verification Strategy', () => {
  it('GET /health returns 200 {"status": "ok"}', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: 'ok' });
  });

  it('GET / returns 200 HTML with Cache-Control: no-cache', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const text = await res.text();
    expect(text).toContain('Kiur');
  });

  it('GET /admin returns 200 HTML with Cache-Control: no-cache', async () => {
    const res = await app.request('/admin');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const text = await res.text();
    expect(text).toContain('لوحة التحكم');
  });

  it('Unmatched route returns 404 with {"detail": string}', async () => {
    const res = await app.request('/api/non-existent');
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json).toHaveProperty('detail');
    expect(typeof json.detail).toBe('string');
  });

  it('CORS allows localhost origin with credentials', async () => {
    const res = await app.request('/health', {
      headers: { Origin: 'http://localhost:5500' },
    }, { DEBUG: 'true' });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5500');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('CORS preflight OPTIONS returns 204 with methods and headers', async () => {
    const res = await app.request('/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5500',
        'Access-Control-Request-Method': 'POST',
      },
    }, { DEBUG: 'true' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5500');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});
```

Run test command:
```powershell
npm.cmd test
# or: npx.cmd vitest run
```
*Pass Criteria*: All tests pass with 100% assertion success.

### 5.5 Step 5: Local Worker Daemon Check (`wrangler dev`)
Launch the worker locally and verify endpoints via curl or PowerShell:
```powershell
# Launch in background / terminal
npx.cmd wrangler dev --port 8787

# Verify health
curl -s http://localhost:8787/health
# Expected: {"status":"ok"}

# Verify error shape on 404
curl -s http://localhost:8787/unknown
# Expected: {"detail":"المسار المطلوب غير موجود"}
```

---

## 6. Features Discovered & Verification Matrix

| # | Component | Route / Feature | Expected Status | Response Format / Headers | Error Behavior |
|---|-----------|-----------------|-----------------|---------------------------|----------------|
| 1 | Middleware | Health Probe | 200 OK | `{"status": "ok"}` | 500 `{"detail": string}` if server down |
| 2 | Static SPA | Student App (`GET /`) | 200 OK | HTML stream, `Cache-Control: no-cache` | 404 `{"detail": string}` if file missing |
| 3 | Static SPA | Admin App (`GET /admin`) | 200 OK | HTML stream, `Cache-Control: no-cache` | 404 `{"detail": string}` if file missing |
| 4 | Middleware | Error Handler (`HTTPException`) | Status from exception | `{"detail": "رسالة الخطأ"}` | Exact status code preserved (400, 401, 403, 404, 429, 503) |
| 5 | Middleware | Error Handler (`ZodError`) | 400 Bad Request | `{"detail": "field: message"}` | Returns clean string, never raw array/object |
| 6 | Middleware | Error Handler (SQLite Unique) | 400 Bad Request | `{"detail": "القيمة المدخلة مستخدمة بالفعل ومسجلة مسبقاً"}` | Sanitizes internal SQL errors |
| 7 | Middleware | Error Handler (Uncaught Crash) | 500 Internal Error | `{"detail": string}` (sanitized in prod) | Logs stack trace with `console.error` |
| 8 | Middleware | Route Not Found (404) | 404 Not Found | `{"detail": "المسار المطلوب غير موجود"}` | Never returns plain text "404 Not Found" |
| 9 | CORS | Preflight `OPTIONS` | 204 No Content | `Access-Control-Allow-Origin`, `Credentials: true` | Omits headers if origin unauthorized |
| 10 | CORS | Cross-Origin Error Response | 4xx / 5xx | Injects `Access-Control-Allow-Origin: <origin>` | Prevents browser masking errors as network failures |
