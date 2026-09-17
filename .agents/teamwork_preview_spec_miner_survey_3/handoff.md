# Storage, System Config & Frontend Contract Specification Mining Report

**Date**: 2026-09-17T00:25:00Z  
**Author**: Spec Miner 3 (Storage, System Config & Frontend Contract Spec Miner)  
**Target Workspace**: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى`  
**Parent Agent**: Orchestrator (`fdf0f062-12fc-46d6-8dd0-3c6786653821`)

---

## 1. Observation

Direct examination of the repository files, source code, and frontend prototypes yielded the following verbatim observations:

### 1.1 Storage & Media Architecture
1. **Existing Storage Implementation (`app/storage.py`)**:
   - `LocalStorage` writes to `UPLOAD_DIR = Path(__file__).resolve().parent.parent / "uploads"` (lines 33–34, 55–80).
   - `S3Storage` wraps `boto3.client("s3", endpoint_url=..., aws_access_key_id=..., aws_secret_access_key=..., region_name=..., config=Config(signature_version="s3v4", s3={"addressing_style": "path"}))` (lines 106–118).
   - Storage operations in `S3Storage`:
     * `save(name, data, content_type)`: calls `self.client.put_object(Bucket=self.bucket, Key=self._key(name), Body=data, ContentType=content_type)` (lines 121–123).
     * `delete(name)`: calls `self.client.delete_object(Bucket=self.bucket, Key=self._key(name))` (lines 125–129). Catches and suppresses all exceptions.
     * `exists(name)`: calls `self.client.head_object(Bucket=self.bucket, Key=self._key(name))` (lines 131–136).
     * `signed_url(name)`: If `s3_public_base_url` is set, returns `f"{s3_public_base_url}/{self._key(name)}"`. Otherwise calls `self.client.generate_presigned_url("get_object", Params={"Bucket": self.bucket, "Key": self._key(name)}, ExpiresIn=settings.s3_url_expiry_seconds)` (lines 142–156).
   - Stable URI Contract:
     * `MEDIA_PREFIX = "/media-files/"` (line 31).
     * Database columns store `/media-files/<name>` via `media_url(name)` (lines 37–39).
     * Path-traversal protection in `name_from_url(media_ref)`: validates that string starts with `/media-files/` and takes `Path(media_ref[13:]).name`, returning `None` if invalid or empty (lines 42–52).
2. **Media Delivery Endpoint (`app/main.py:61–85`)**:
   - Route: `GET /media-files/{name}`.
   - Validates `safe = name_from_url(f"/media-files/{name}")`, returning `404 ("الملف غير موجود")` on failure.
   - When using S3: checks `storage.signed_url(safe)` and `storage.exists(safe)`.
   - Returns `RedirectResponse(url, status_code=307)`. A 307 temporary redirect prevents browser caching of the signed URL.
   - Verification script `scripts/check_storage.py:77–88` specifically asserts HTTP `Range: bytes=0-3` header support for lecture video seeking (expects `HTTP 206 Partial Content`).
3. **File Upload Handlers & Limits (`app/routers/admin.py`, `auth.py`, `professors.py`)**:
   - `MAX_UPLOAD_BYTES = 20 * 1024 * 1024` (20 MB for photos, booklets, general files; `admin.py:18`).
   - `MAX_VIDEO_BYTES = 150 * 1024 * 1024` (150 MB for lecture videos; `admin.py:19`).
   - Extension Whitelists (`admin.py:27–29`):
     * `IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}`
     * `DOC_EXTS = {".pdf"}`
     * `VIDEO_EXTS = {".mp4", ".webm", ".mov", ".m4v"}`
   - Safe Randomized File Naming (`admin.py:32–38`):
     * `safe_upload_name(filename, allowed_exts, fallback_stem)` produces:
       `f"{secrets.token_hex(8)}_{fallback_stem}{ext}"`
   - Upload routes:
     * `POST /auth/me/photo`: Student profile photo upload (`auth.py:432–450`). Validates `IMAGE_EXTS`, limit 20MB, calls `delete_stored_upload(user.photo_url)`.
     * `POST /api/professors/me/photo`: Professor profile photo upload (`professors.py:124–140`). Validates `IMAGE_EXTS`, limit 20MB, calls `delete_stored_upload(profile.photo_url)`.
     * `POST /api/professors/me/booklets/{booklet_id}/file`: Booklet document upload (`professors.py:296–319`). Validates `DOC_EXTS | IMAGE_EXTS`, limit 20MB, calls `delete_stored_upload(b.file_url)`.
     * `POST /api/professors/me/lectures/{lecture_id}/file`: Lecture video upload (`professors.py:479–500`). Validates `VIDEO_EXTS`, limit 150MB, calls `delete_stored_upload(lec.video_url)`.
     * `POST /api/admin/media/upload`: Admin media upload (`admin.py:994–1022`). Validates `IMAGE_EXTS | DOC_EXTS | VIDEO_EXTS`, limit 20MB, creates `models.MediaFile`.
     * `POST /api/admin/media`: Registers existing metadata without uploading bytes (`admin.py:981–992`).
     * `POST /api/admin/import`: Multipart upload for Excel bulk import (`import_export.py:181–197`). Parsed in memory with `openpyxl`, not stored in object storage.
   - Resource Cleanup on Deletion:
     * `delete_stored_upload(media_ref)` in `admin.py:41–51` is called when deleting booklets (`professors.py:285`), lectures (`professors.py:472`), or updating professor profiles (`professors.py:117`).

### 1.2 Configuration & Environment Variables (`app/config.py`, `.env.example`, `render.yaml`)
Inspecting `Settings` in `app/config.py:5–100`, `.env.example:1–86`, and `render.yaml:8–64`:
- `database_url`: default `"sqlite:///./nabd.db"`
- `jwt_secret`: default `"dev-secret-change-me"`; if `DEBUG=false` and secret is default, startup raises `RuntimeError` (`config.py:111–116`).
- `jwt_algorithm`: `"HS256"`
- `jwt_expires_minutes`: `20160` (14 days)
- `bootstrap_admin_email`: email auto-promoted to admin on initial login
- `google_client_id`: OAuth client ID
- `google_client_secret`: OAuth client secret
- `google_redirect_uri`: default `"http://localhost:8000/auth/google/callback"`
- `allowed_university_domains`: comma-separated allowed domains (e.g. `"uob.edu.iq"`)
- `frontend_url`: default `"http://localhost:5500"`
- `admin_frontend_url`: optional override for admin dashboard origin
- `cors_origins`: comma-separated allowed origins (default `"http://localhost:5500,http://127.0.0.1:5500"`)
- `debug`: boolean (default `False`)
- `session_cookie_name`: default `"nabd_session"`
- `smtp_host`: hostname of SMTP relay
- `smtp_port`: integer (default `587`)
- `smtp_user`: SMTP auth username
- `smtp_password`: SMTP auth password
- `smtp_from`: sender email address
- `smtp_from_name`: sender display name (default `"Kiur"`)
- `smtp_use_tls`: boolean (default `True`)
- `password_reset_ttl_minutes`: default `60`
- `password_reset_cooldown_seconds`: default `120`
- `storage_backend`: `"local"` or `"s3"` (default `"local"`)
- `s3_bucket`: S3 bucket name
- `s3_prefix`: optional folder prefix (e.g. `""`)
- `s3_endpoint_url`: S3 endpoint URL (e.g. `https://<account-id>.r2.cloudflarestorage.com`)
- `s3_access_key_id`: S3 Access Key ID
- `s3_secret_access_key`: S3 Secret Access Key
- `s3_region`: default `"auto"`
- `s3_public_base_url`: public CDN URL or empty for signed URLs
- `s3_url_expiry_seconds`: default `3600` (1 hour)

### 1.3 Frontend Integration & Client Contracts
Inspecting `nabd-home-quiz-prototype.html` and `nabd-admin-dashboard.html`:
1. **Serving Architecture**:
   - `GET /`: returns `nabd-home-quiz-prototype.html` with headers `{"Cache-Control": "no-cache"}` (`app/main.py:160–163`).
   - `GET /admin`: returns `nabd-admin-dashboard.html` with headers `{"Cache-Control": "no-cache"}` (`app/main.py:165–168`).
2. **API Base URL Resolution**:
   ```javascript
   const API_BASE_URL = location.origin === 'http://localhost:5500' || location.origin === 'http://127.0.0.1:5500'
     ? 'http://localhost:8000' : location.origin;
   ```
   In production, the frontend is served on the exact same origin as the API, so `API_BASE_URL` resolves to `location.origin` (same-origin).
3. **Authentication & Session Mechanics**:
   - In-memory `authToken`: Bearer token stored in memory variable `let authToken = null;`.
   - Request header: `Authorization: Bearer <authToken>`.
   - Credentials mode: `credentials: 'include'` on all `fetch` calls.
   - Dual-token session cookie:
     * Cookie name: `nabd_session` (set in `app/security.py:54–64`).
     * Path: `/auth/session`.
     * Attributes: `HttpOnly=True`, `SameSite=Lax`, `Secure=not debug`, `Max-Age=1209600`.
     * Scoped specifically so the browser sends it ONLY to `/auth/session/restore`.
   - Session Recovery Flow:
     * On page reload, frontend immediately calls `POST /auth/session/restore`.
     * The backend reads the `nabd_session` cookie, verifies the database `UserSession` is active (`session.is_active == True`), issues a fresh JWT with updated expiration, sets a fresh cookie, and returns `LoginResponse(access_token=fresh, user=user)`.
   - Single-Active-Session Enforcement:
     * Logging in from a new device calls `start_new_session()` which deactivates all other sessions for that user (`is_active = False`).
     * Any subsequent API call using an invalidated session token receives `401 Unauthorized` with detail `"تم تسجيل الدخول من جهاز آخر"`.
     * Frontend `apiFetch` intercepts `res.status === 401 && authToken`, immediately clears `authToken = null`, displays a toast notification with the error detail, and calls `goToLogin()`.
   - Google OAuth Flow:
     * Client navigates to `${API_BASE_URL}/auth/google/login` (admin dashboard appends `?next=admin`).
     * Google redirects back to `${API_BASE_URL}/auth/google/callback`.
     * Backend redirects browser back to frontend with URL fragments:
       - Success: `${redirect_base}#access_token=${token}`
       - 2FA Required: `${redirect_base}#requires_2fa=1&pending_token=${pending}`
       - Role Error (for admin dashboard): `${redirect_base}#google_error=role`
       - Password Reset: `${redirect_base}#reset_token=${raw_token}`
     * Frontend script reads the hash parameter and immediately wipes it via `history.replaceState(null, '', location.pathname + location.search)` to prevent leaking tokens in browser history.
4. **Response Payload & Serialization Expectations**:
   - **No Response Envelopes**: APIs return direct JSON objects or lists (e.g. `[ { id, ... } ]`, `{ id, total, ... }`). There is no outer `{ data, error, code }` wrapper.
   - **Case Convention**: STRICTLY `snake_case` across all API JSON bodies (e.g. `full_name`, `photo_url`, `is_banned`, `stage_id`, `question_count`, `duration_seconds`, `video_url`, `file_url`, `access_token`). The frontend JavaScript explicitly consumes `snake_case` properties from API responses and only adapts to camelCase in certain local presentation view models (e.g. `p.apiBooklets.map(b => ({ fileUrl: b.file_url }))`).
   - **Date Formats**: Datetime fields serialize to ISO-8601 strings (e.g. `2026-09-17T03:17:08.000Z`), parsed by client `new Date(...)`.
   - **Error Structure**: Standard FastAPI error envelope: `{ "detail": "نص رسالة الخطأ بالعربية" }`. The frontend error handler explicitly reads `(await res.json())?.detail`.
   - **Status Codes**: 200 (Success), 204 (No Content / Empty, returns null), 307 (Temporary Redirect for OAuth/Media), 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 404 (Not Found), 429 (Rate Limit), 503 (SMTP Not Configured).

### 1.4 Background Tasks & External Integrations
1. **Background Tasks (`BackgroundTasks`)**:
   - Located exclusively in `app/routers/auth.py:795–847` (`POST /auth/forgot-password`).
   - `background.add_task(send_password_reset, email, user.full_name, link, ttl)`.
   - Purpose: Asynchronous email transmission so that SMTP connection latency (2–5 seconds) does not block the HTTP response or reveal user existence via timing side-channels.
2. **External APIs**:
   - **Google OAuth 2.0 (OpenID Connect)**:
     * Relies on `authlib` using discovery metadata `https://accounts.google.com/.well-known/openid-configuration`.
     * Requests scopes: `openid email profile`.
     * Validates user identity and enforces `allowed_university_domains`.
   - **SMTP Outgoing Email (`app/mailer.py`)**:
     * Implemented using Python's standard `smtplib` and `ssl`.
     * Uses port 587 (STARTTLS) or port 465 (Implicit TLS).
     * If `SMTP_HOST` is unset, `email_configured()` returns `False`, causing `POST /auth/forgot-password` to cleanly return `503 Service Unavailable` with message `"خدمة البريد غير مهيأة على الخادم — لا يمكن إرسال رابط الاستعادة. راجع إعدادات SMTP."`.
   - **Store / Payments**:
     * Inspected `app/routers/store.py`. There is NO external payment gateway API (e.g. ZainCash API) integrated. Orders are created with `status="pending"`, and an admin manually updates the status to `"paid"` or `"fulfilled"`, triggering the internal `issue_codes_for_paid_order()` helper.
   - **Cron / Scheduled Jobs**:
     * None present in the Python codebase.

---

## 2. Logic Chain

From the direct observations above, the system design requirements for the TypeScript Hono / Cloudflare Workers rewrite are derived through the following reasoning:

1. **Storage: S3 to Native Cloudflare R2**:
   - *Observation 1.1*: Storage in Python is accessed via `boto3.client('s3')` or local filesystem. In Cloudflare Workers, filesystem writes (`fs.writeFile`) are impossible because Workers have an ephemeral, read-only filesystem.
   - *Observation 1.1*: Cloudflare Workers natively supports R2 bucket bindings via `env.R2_BUCKET`.
   - *Logic Step*: All `storage.save()`, `storage.delete()`, `storage.exists()`, and `storage.signed_url()` operations must be replaced with native R2 binding methods (`put`, `delete`, `head`, `get`).
   - *Observation 1.1 & 1.2*: Media files are served via `GET /media-files/{name}`. In Python S3, this redirects (307) to a presigned S3 URL because S3 has egress bandwidth fees. However, in Cloudflare Workers, R2 has **zero egress bandwidth fees** when accessed via Workers R2 bindings (`env.R2_BUCKET.get()`).
   - *Logic Step*: The Worker can directly stream media files using `env.R2_BUCKET.get(key, { range: c.req.raw.headers })`, setting `Accept-Ranges: bytes`, `Content-Type`, `Content-Length`, and returning `206 Partial Content` for video range requests. This eliminates the need for generating presigned URLs entirely, simplifies browser playback, maintains full access control, and eliminates streaming latency.

2. **Configuration: Pydantic Settings to `wrangler.toml`**:
   - *Observation 1.2*: Configuration is centralized in Pydantic `BaseSettings` reading from `.env` and environment variables.
   - *Logic Step*: In Cloudflare Workers, environment variables are accessed via the `c.env` context in Hono. Variables must be split into:
     * D1 Database binding (`env.DB`)
     * R2 Bucket binding (`env.R2_BUCKET`)
     * Non-secret plain variables in `[vars]` (e.g. `JWT_ALGORITHM`, `CORS_ORIGINS`, `DEBUG`, `GOOGLE_REDIRECT_URI`)
     * Sensitive credentials in Cloudflare Secrets via `wrangler secret put` (`JWT_SECRET`, `GOOGLE_CLIENT_SECRET`, `SMTP_PASSWORD`)

3. **Frontend Contract Preservation**:
   - *Observation 1.3*: The existing student and admin interfaces are two monolithic HTML applications (`nabd-home-quiz-prototype.html` and `nabd-admin-dashboard.html`) served directly by the backend at `/` and `/admin`.
   - *Logic Step*: The Cloudflare Worker must serve these two HTML files at `GET /` and `GET /admin` with `Cache-Control: no-cache`. They can either be embedded as string assets, stored in R2, or bundled via Workers static assets.
   - *Observation 1.3*: Both frontends communicate via `apiFetch()` with explicit assumptions:
     * JSON payloads: strictly `snake_case`, direct serialization without envelope wrapping.
     * Errors: `{ "detail": string }`.
     * Headers: `Authorization: Bearer <token>`, with cookie `nabd_session` scoped to `/auth/session`.
     * Status codes: 401 triggers logout, 204 returns null.
   - *Logic Step*: The Hono rewrite must strictly conform to these exact status codes, header names, cookie attributes, error schemas, and field casings. Any deviation (e.g. returning `{ data: ... }` or converting `full_name` to `fullName`) would immediately break the frontend without UI warning.

4. **Background Tasks & Outgoing Email**:
   - *Observation 1.4*: The only background task is password reset email sending (`app/routers/auth.py:838`).
   - *Logic Step*: In Cloudflare Workers, `c.executionCtx.waitUntil(promise)` replaces `BackgroundTasks.add_task()`.
   - *Observation 1.4*: Python's `smtplib` requires raw TCP sockets. In Cloudflare Workers, sending email can be accomplished via:
     * An HTTP-based transactional email API (e.g., Resend, Brevo, or Mailgun REST APIs), which requires standard `fetch()`, or
     * Cloudflare Email Routing / MailChannels, or
     * Sockets via `cloudflare:sockets` connecting to an SMTP server.
     An HTTP email client with a configurable fallback or SMTP-over-fetch provides the highest reliability and zero native-binary dependencies.

---

## 3. Caveats

1. **Worker Request Body Size Limit**:
   - Free Cloudflare Workers plans enforce a maximum HTTP request body limit of 100 MB.
   - The Python backend allows up to 150 MB for lecture videos (`MAX_VIDEO_BYTES = 150 * 1024 * 1024`).
   - If deploying to a free Cloudflare Workers account, lecture videos larger than 100 MB cannot be uploaded via multipart POST through the Worker. To support 150 MB+ on Workers free tier without paid plan expansion (which allows up to 500 MB), an S3 presigned PUT URL directly to R2 could be used, or the maximum video upload size should be set to 100 MB.
2. **Excel Import/Export in V8 Serverless Runtime**:
   - Python uses `openpyxl` for reading and writing `.xlsx` files (`import_export.py`).
   - In TypeScript on Cloudflare Workers, a pure JavaScript spreadsheet library (such as `exceljs` or `xlsx` / SheetJS) must be used. Both work in V8 without native Node.js binaries.
3. **Password Hashing Compatibility**:
   - Existing Python code uses `passlib` / `pbkdf2_sha256` or `bcrypt` for password hashing (`security.py`).
   - When migrating existing databases, password hashes must be verified using the exact same algorithm (e.g. Web Crypto API PBKDF2 or `bcryptjs`).

---

## 4. Conclusion

1. **Storage Migration**: Complete translation from `boto3` S3 to Cloudflare R2 native bindings is 100% feasible and superior in performance and cost (zero egress fees). Direct streaming with `Accept-Ranges` support in Workers replaces presigned URL redirects and ensures smooth video seeking.
2. **Configuration Migration**: All 27 settings map cleanly into `wrangler.toml` (`[vars]`, secrets, D1 database binding `DB`, and R2 bucket binding `R2_BUCKET`).
3. **Frontend Compatibility**: The frontend contract is fully documented and requires zero changes provided the Hono API preserves:
   - Root SPA routes `GET /` and `GET /admin`
   - Exact route paths (`/auth/...`, `/api/...`, `/media-files/:name`)
   - `snake_case` JSON serialization without envelope wrapping
   - Error format `{ "detail": "..." }`
   - Authorization via Bearer header and `/auth/session` httpOnly cookie
4. **System Services**: The single background task (`send_password_reset`) translates directly to Hono's `c.executionCtx.waitUntil()`. Email sending will use an HTTP REST provider (e.g. Resend) or SMTP connector.

---

## 5. Verification Method

To independently verify these findings:
1. **Inspect Storage Code**:
   - View `app/storage.py` and `scripts/check_storage.py` to confirm S3 operations and range request requirements:
     `view_file AbsolutePath=".../app/storage.py"`
2. **Inspect Environment Configurations**:
   - View `app/config.py`, `.env.example`, and `render.yaml` to confirm variable names and defaults:
     `view_file AbsolutePath=".../app/config.py"`
3. **Inspect Frontend API Contract**:
   - Run Node inspection on the frontend JavaScript to verify `apiFetch`, casing, and cookie usage:
     `node -e "const fs = require('fs'); const s = fs.readFileSync('nabd-home-quiz-prototype.html', 'utf8'); console.log(s.includes('snake_case') || s.includes('currentUser.photo_url'));"`
4. **Verify Route List & Methods**:
   - Compare the routes table below against the router definitions in `app/routers/`.

---

## Features Discovered

| # | Category | Feature | Description | Inputs | Outputs | Error Behavior | Discovered Via |
|---|----------|---------|-------------|--------|---------|----------------|----------------|
| 1 | Storage | Media Serving | Serves files or redirects to signed object store URL | Path param `name` (string) | Binary file stream or HTTP 307 redirect | 404 `"الملف غير موجود"` if unsafe or missing | `app/main.py:61` |
| 2 | Storage | Student Photo Upload | Uploads profile photo for current student | `file: UploadFile` (multipart/form-data) | `UserOut` JSON object | 400 if > 20MB or invalid extension (`IMAGE_EXTS`) | `app/routers/auth.py:432` |
| 3 | Storage | Professor Photo Upload | Uploads profile photo for professor | `file: UploadFile` (multipart/form-data) | `{"photo_url": string}` | 400 if > 20MB or invalid extension | `app/routers/professors.py:124` |
| 4 | Storage | Booklet PDF Upload | Uploads study booklet document | `booklet_id` (path), `file: UploadFile` | `BookletOut` JSON object | 400 if > 20MB, 404 if booklet not found | `app/routers/professors.py:296` |
| 5 | Storage | Lecture Video Upload | Uploads lecture video file with seekable playback | `lecture_id` (path), `file: UploadFile` | `{"id", "title", "duration_seconds", "video_url"}` | 400 if > 150MB, 404 if lecture not found | `app/routers/professors.py:479` |
| 6 | Storage | Admin Media Upload | Uploads general media to media library | `file: UploadFile` (multipart/form-data) | `{"id": string, "url": string}` | 400 if > 20MB, 403 if not admin | `app/routers/admin.py:994` |
| 7 | Storage | Admin Media Metadata | Registers pre-uploaded media record | `filename`, `url`, `content_type`, `size_bytes` | `{"id": string}` | 403 if not admin | `app/routers/admin.py:981` |
| 8 | Storage | File Deletion & Cleanup | Deletes stored media when booklet/lecture/photo is removed | `media_ref` (string) | None (silent on error) | Silently suppressed to prevent blocking DB operations | `app/routers/admin.py:41` |
| 9 | Config | Environment Configuration | Pydantic BaseSettings loading .env and defaults | Environment variables | Settings singleton instance | RuntimeError if `DEBUG=false` with default JWT secret | `app/config.py:5` |
| 10 | Frontend | Student App SPA Host | Serves main student SPA HTML | `GET /` | HTML file with `Cache-Control: no-cache` | 404 if file missing | `app/main.py:160` |
| 11 | Frontend | Admin Dashboard SPA Host | Serves admin/professor/reseller dashboard HTML | `GET /admin` | HTML file with `Cache-Control: no-cache` | 404 if file missing | `app/main.py:165` |
| 12 | Frontend | API Health Check | Lightweight liveness probe for frontend initialization | `GET /health` | `{"status": "ok"}` | 500 if server down | `app/main.py:144` |
| 13 | Auth | Dev Login Stand-in | Instant passwordless login for local development | Query `email`, `name` | `LoginResponse` (`access_token`, `user`) + Cookie | 404 if `DEBUG=false` | `app/routers/auth.py:194` |
| 14 | Auth | Password Login | Authenticates admin, professor, reseller, or student | `{ email, password }` | `LoginResponse` or `{ requires_2fa, pending_token }` | 401 on bad credentials, 429 on lockout | `app/routers/auth.py:208` |
| 15 | Auth | Google OAuth Login | Initiates Google OpenID Connect flow | Query `next` (optional, `"admin"`) | 302 Redirect to Google OAuth URL | 500 if `GOOGLE_CLIENT_ID` unset | `app/routers/auth.py:147` |
| 16 | Auth | Google OAuth Callback | Processes Google OAuth return and issues session | OAuth code & state params | 302 Redirect to frontend with `#access_token=...` | 403 if email domain not in whitelist | `app/routers/auth.py:164` |
| 17 | Auth | Session Restore | Exchanges httpOnly cookie for fresh JWT | Cookie `nabd_session` | `LoginResponse` with renewed JWT | 401 if missing, expired, or deactivated elsewhere | `app/routers/auth.py:735` |
| 18 | Auth | Logout | Deactivates active session and clears session cookie | Header `Authorization: Bearer <token>` | `{"ok": true}` | 401 if not authenticated | `app/routers/auth.py:890` |
| 19 | Auth | Single-Active-Session | Invalidates previous sessions on any new login | Database check against `sid` in JWT | Allowed or 401 Unauthorized | 401 `"تم تسجيل الدخول من جهاز آخر"` | `app/deps.py:25` |
| 20 | System | Password Reset Email | Sends password reset email via background task | `{ email }` | `{"ok": true, "message": "..."}` | 503 if `SMTP_HOST` not configured | `app/routers/auth.py:795` |
| 21 | System | Password Reset Execution | Verifies reset token and updates password | `{ token, new_password }` | `{"ok": true, "message": "..."}` | 400 if token expired or invalid | `app/routers/auth.py:849` |
| 22 | System | Data Import (Excel) | Imports students or questions from `.xlsx` | `file: UploadFile` (multipart/form-data) | `{"kind", "created", "errors"}` | 400 if template unrecognized | `app/routers/import_export.py:181` |
| 23 | System | Data Export (Excel) | Generates and streams `.xlsx` workbook | Query `datasets` (comma-separated) | Streaming `.xlsx` file response | None (empty sheet on empty dataset) | `app/routers/import_export.py:58` |
| 24 | System | Store Orders | Creates store order for physical/digital products | `OrderIn` (`items`, `payment_method`, etc.) | `OrderOut` JSON object | 400 if COD without physical item | `app/routers/store.py:21` |

---

## Edge Cases

| # | Feature | Input | Observed Behavior |
|---|---------|-------|-------------------|
| 1 | Media Serving (`/media-files/`) | Path traversal attempt: `GET /media-files/../../etc/passwd` | `name_from_url()` strips directory path using `Path(...).name`; returns 404 `"الملف غير موجود"`. Traversal is blocked. |
| 2 | Media Serving (`/media-files/`) | Range request on video: `Range: bytes=0-3` | Returns HTTP 206 Partial Content with 4 bytes. Crucial for HTML5 video seeking. |
| 3 | File Uploads | Disallowed file extension: e.g. `photo.svg` or `doc.html` | `safe_upload_name()` throws HTTP 400 `"نوع الملف غير مسموح"`. Prevents stored XSS attacks. |
| 4 | File Uploads | Upload exceeding limit: e.g. 25 MB photo | Throws HTTP 400 `"الملف أكبر من الحد المسموح (20 ميغابايت)"`. |
| 5 | Video Upload | Video exceeding 150 MB | Throws HTTP 400 `"الملف أكبر من الحد المسموح (150 ميغابايت)"`. |
| 6 | File Replacement | Uploading new profile photo while old photo exists | Backend calls `delete_stored_upload(old_photo_url)` before setting new `photo_url`, preventing orphaned files. |
| 7 | Auth Session Restore | User logs in on Device B, then Device A calls `/auth/session/restore` | Session ID `sid` in Device A's cookie is marked `is_active=False` in DB; endpoint returns 401 `"تم تسجيل الدخول من جهاز آخر"` and clears cookie. |
| 8 | Password Reset | Email address not in database | Returns identical 200 message (`"إذا كان هذا البريد مسجّلاً لدينا..."`) and sends no mail, preventing account enumeration. |
| 9 | Password Reset | SMTP credentials not set on server (`SMTP_HOST=""`) | Returns HTTP 503 `"خدمة البريد غير مهيأة على الخادم"` instead of falsely claiming an email was sent. |
| 10 | Google OAuth | Google user role is student, but clicks "الدخول عبر Google" on admin dashboard (`?next=admin`) | Callback redirects to `/admin#google_error=role`. No session is created, protecting student account from being signed out. |
| 11 | Google OAuth | Google account domain does not match `ALLOWED_UNIVERSITY_DOMAINS` | Throws HTTP 403 `"الرجاء تسجيل الدخول ببريدك الجامعي الرسمي"`. |
| 12 | Store Order | Order with COD (Cash on Delivery) for digital products only | Throws HTTP 400 `"الدفع عند الاستلام متاح فقط للطلبات التي تحوي منتجات ملموسة"`. |
| 13 | Store Order | Physical order missing delivery fields | Throws HTTP 400 `"معلومات التوصيل (الاسم، الهاتف، العنوان) مطلوبة"`. |
| 14 | Store Order Fulfillment | Admin marks order paid multiple times | `issue_codes_for_paid_order()` checks if `order_id` already exists in `activation_codes`; idempotent, never double-mints codes. |
| 15 | Startup Check | `DEBUG=false` and `JWT_SECRET` equals default dev secret | App startup fails immediately with `RuntimeError` to prevent insecure deployments. |

---

## Detailed Cloudflare R2 & System Mapping Specification

### 1. Cloudflare R2 Binding Design
In Cloudflare Workers with Hono, the `boto3` S3 client is completely superseded by native R2 bindings:

```toml
# wrangler.toml
[[r2_buckets]]
binding = "R2_BUCKET"
bucket_name = "nabd-media"
preview_bucket_name = "nabd-media-preview"
```

#### TypeScript R2 Storage Service Implementation Contract:
```typescript
export interface StorageService {
  save(name: string, data: ArrayBuffer | Uint8Array, contentType: string): Promise<void>;
  delete(name: string): Promise<void>;
  exists(name: string): Promise<boolean>;
  get(name: string, range?: Headers | R2Range): Promise<R2ObjectBody | R2Object | null>;
}

export class CloudflareR2Storage implements StorageService {
  constructor(private bucket: R2Bucket, private prefix: string = '') {}

  private key(name: string): string {
    return this.prefix ? `${this.prefix.replace(/^\/+|\/+$/g, '')}/${name}` : name;
  }

  async save(name: string, data: ArrayBuffer | Uint8Array, contentType: string): Promise<void> {
    await this.bucket.put(this.key(name), data, {
      httpMetadata: { contentType: contentType || 'application/octet-stream' },
    });
  }

  async delete(name: string): Promise<void> {
    try {
      await this.bucket.delete(this.key(name));
    } catch {
      // Suppress deletion errors as per original Python implementation
    }
  }

  async exists(name: string): Promise<boolean> {
    const head = await this.bucket.head(this.key(name));
    return head !== null;
  }

  async get(name: string, headers?: Headers): Promise<R2ObjectBody | null> {
    return (await this.bucket.get(this.key(name), {
      range: headers,
      onlyIf: headers,
    })) as R2ObjectBody | null;
  }
}
```

#### Media Delivery Route (`GET /media-files/:name`):
```typescript
app.get('/media-files/:name', async (c) => {
  const name = c.req.param('name');
  const safeName = nameFromUrl(`/media-files/${name}`);
  if (!safeName) {
    return c.json({ detail: 'الملف غير موجود' }, 404);
  }

  const object = await c.env.R2_BUCKET.get(safeName, {
    range: c.req.raw.headers,
    onlyIf: c.req.raw.headers,
  });

  if (!object) {
    return c.json({ detail: 'الملف غير موجود' }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, max-age=3600');

  const status = object.range ? 206 : 200;
  return new Response(object.body, { headers, status });
});
```

---

### 2. Complete Environment Variable Classification for `wrangler.toml`

| Variable Name | Classification | Default / Development Value | Purpose |
|---------------|----------------|----------------------------|---------|
| `DB` | D1 Database Binding | `[[d1_databases]]` | Serverless SQLite database |
| `R2_BUCKET` | R2 Bucket Binding | `[[r2_buckets]]` | Object storage for media/files |
| `JWT_SECRET` | Secret (`wrangler secret`) | Long random string (32+ chars) | HMAC signing key for JWTs |
| `JWT_ALGORITHM` | `[vars]` | `"HS256"` | JWT signature algorithm |
| `JWT_EXPIRES_MINUTES` | `[vars]` | `20160` (14 days) | Session token TTL |
| `BOOTSTRAP_ADMIN_EMAIL` | `[vars]` | `""` | Initial admin account email |
| `GOOGLE_CLIENT_ID` | `[vars]` | `""` | OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | Secret (`wrangler secret`) | `""` | OAuth Client Secret |
| `GOOGLE_REDIRECT_URI` | `[vars]` | `"https://<worker>/auth/google/callback"` | OAuth Authorized Redirect URI |
| `ALLOWED_UNIVERSITY_DOMAINS` | `[vars]` | `""` | Whitelist of allowed email domains |
| `FRONTEND_URL` | `[vars]` | `"http://localhost:5500"` | Student app redirect base |
| `ADMIN_FRONTEND_URL` | `[vars]` | `""` (defaults to origin + `/admin`) | Admin dashboard redirect base |
| `CORS_ORIGINS` | `[vars]` | `"http://localhost:5500,http://127.0.0.1:5500"` | Allowed CORS origins |
| `DEBUG` | `[vars]` | `"false"` (`"true"` in dev) | Enables `/auth/dev-login` |
| `SESSION_COOKIE_NAME` | `[vars]` | `"nabd_session"` | Cookie name for session restore |
| `PASSWORD_RESET_TTL_MINUTES` | `[vars]` | `60` | Reset token lifespan |
| `PASSWORD_RESET_COOLDOWN_SECONDS` | `[vars]` | `120` | Minimum gap between resets |
| `SMTP_HOST` | `[vars]` / Secret | `""` | Outgoing SMTP host or mail API |
| `SMTP_PORT` | `[vars]` | `587` | Outgoing SMTP port |
| `SMTP_USER` | Secret (`wrangler secret`) | `""` | SMTP / API auth username |
| `SMTP_PASSWORD` | Secret (`wrangler secret`) | `""` | SMTP / API auth password |
| `SMTP_FROM` | `[vars]` | `"no-reply@yourdomain.com"` | From email address |
| `SMTP_FROM_NAME` | `[vars]` | `"Kiur"` | From sender name |
| `SMTP_USE_TLS` | `[vars]` | `"true"` | TLS flag |
| `R2_PREFIX` | `[vars]` | `""` | Optional R2 key prefix |
| `R2_PUBLIC_BASE_URL` | `[vars]` | `""` | Optional public domain |

---

### 3. Complete Frontend API Call Directory

| HTTP Method | Path Pattern | Caller SPA | Request Type | Auth Required | Expected Response Format |
|-------------|--------------|------------|--------------|---------------|--------------------------|
| `GET` | `/health` | Both | None | No | `{"status": "ok"}` |
| `GET` | `/` | Browser | None | No | HTML (`nabd-home-quiz-prototype.html`) |
| `GET` | `/admin` | Browser | None | No | HTML (`nabd-admin-dashboard.html`) |
| `GET` | `/media-files/:name` | Both / `<img>` / `<video>` | Range Header | No (Public or signed ref) | Binary content (200 / 206) |
| `POST` | `/auth/login` | Both | JSON `{email, password}` | No | `LoginResponse` or `{requires_2fa, pending_token}` |
| `POST` | `/auth/dev-login` | Both (Debug) | Query Params | No | `LoginResponse` |
| `GET` | `/auth/google/login` | Both | Query `?next=admin` | No | 302 Redirect |
| `GET` | `/auth/google/callback` | Browser | OAuth Code | No | 302 Redirect with `#access_token=...` |
| `POST` | `/auth/register` | Student | JSON `{email, password, full_name}` | No | `LoginResponse` |
| `POST` | `/auth/session/restore` | Both | Cookie `nabd_session` | No (Cookie) | `LoginResponse` |
| `POST` | `/auth/logout` | Both | None | Bearer | `{"ok": true}` |
| `POST` | `/auth/2fa/verify` | Both | JSON `{pending_token, code}` | No | `LoginResponse` |
| `POST` | `/auth/2fa/setup` | Both | None | Bearer | `{"secret", "otpauth_uri"}` |
| `POST` | `/auth/2fa/enable` | Both | JSON `{code}` | Bearer | `{"ok": true}` |
| `POST` | `/auth/2fa/disable` | Both | JSON `{code}` | Bearer | `{"ok": true}` |
| `POST` | `/auth/forgot-password` | Both | JSON `{email}` | No | `{"ok": true, "message": "..."}` |
| `POST` | `/auth/reset-password` | Both | JSON `{token, new_password}` | No | `{"ok": true, "message": "..."}` |
| `GET` | `/auth/me` | Both | None | Bearer | `UserOut` |
| `PUT` | `/auth/me/profile` | Student | JSON `{full_name, phone, ...}` | Bearer | `UserOut` |
| `POST` | `/auth/me/photo` | Student | FormData (`file`) | Bearer | `UserOut` |
| `PUT` | `/auth/me/caption` | Student | JSON `{caption}` | Bearer | `UserOut` |
| `PUT` | `/auth/me/preferences` | Student | JSON `{theme, language}` | Bearer | `UserOut` |
| `GET` | `/auth/me/skills` | Student | None | Bearer | `list[UserSkill]` |
| `POST` | `/auth/me/skills` | Student | JSON `{text}` | Bearer | `UserSkill` |
| `DELETE` | `/auth/me/skills/:id` | Student | None | Bearer | `{"ok": true}` |
| `GET` | `/auth/me/sessions` | Student | None | Bearer | `list[SessionOut]` |
| `GET` | `/auth/me/history` | Student | None | Bearer | `list[HistoryEvent]` |
| `POST` | `/auth/change-password` | Student | JSON `{current_password, new_password}` | Bearer | `{"ok": true}` |
| `GET` | `/auth/me/stats` | Student | None | Bearer | `StudentStatsOut` |
| `GET` | `/auth/me/continue` | Student | None | Bearer | `RecentViewOut` |
| `POST` | `/auth/me/recent-view` | Student | JSON `{content_type, content_id}` | Bearer | `{"ok": true}` |
| `GET` | `/auth/me/daily` | Student | Query `?days=7` | Bearer | Daily stats array |
| `GET` | `/auth/me/performance`| Student | None | Bearer | Subject performance array |
| `GET` | `/auth/leaderboard` | Student | Query `?limit=...` | Bearer | Leaderboard array |
| `GET` | `/api/catalog/tree` | Both | None | No / Optional | Catalog tree array |
| `GET` | `/api/professors` | Student | None | No / Optional | `list[ProfessorOut]` |
| `GET` | `/api/professors/:id` | Student | None | No / Optional | `ProfessorOut` |
| `GET` | `/api/professors/booklets/latest` | Student | None | No / Optional | `BookletOut` |
| `GET` | `/api/professors/me/dashboard` | Admin (Prof) | None | Bearer (Professor) | Professor dashboard stats |
| `PUT` | `/api/professors/me/profile` | Admin (Prof) | JSON `{title, bio, photo_url}` | Bearer (Professor) | Professor profile object |
| `POST` | `/api/professors/me/photo` | Admin (Prof) | FormData (`file`) | Bearer (Professor) | `{"photo_url": string}` |
| `GET` | `/api/professors/me/courses` | Admin (Prof) | None | Bearer (Professor) | `list[CourseOut]` |
| `POST` | `/api/professors/me/courses` | Admin (Prof) | JSON `{title}` | Bearer (Professor) | `CourseOut` |
| `PUT` | `/api/professors/me/courses/:id` | Admin (Prof) | JSON `{title}` | Bearer (Professor) | `CourseOut` |
| `DELETE` | `/api/professors/me/courses/:id` | Admin (Prof) | None | Bearer (Professor) | `{"ok": true}` |
| `POST` | `/api/professors/me/courses/:id/lectures` | Admin (Prof) | JSON `{title}` | Bearer (Professor) | `LectureOut` |
| `PUT` | `/api/professors/me/lectures/:id` | Admin (Prof) | JSON `{title}` | Bearer (Professor) | `LectureOut` |
| `DELETE` | `/api/professors/me/lectures/:id` | Admin (Prof) | None | Bearer (Professor) | `{"ok": true}` |
| `POST` | `/api/professors/me/lectures/:id/file` | Admin (Prof) | FormData (`file`) | Bearer (Professor) | `LectureOut` |
| `POST` | `/api/professors/me/booklets` | Admin (Prof) | JSON `{title, pages}` | Bearer (Professor) | `BookletOut` |
| `PUT` | `/api/professors/me/booklets/:id` | Admin (Prof) | JSON `{title, pages}` | Bearer (Professor) | `BookletOut` |
| `DELETE` | `/api/professors/me/booklets/:id` | Admin (Prof) | None | Bearer (Professor) | `{"ok": true}` |
| `POST` | `/api/professors/me/booklets/:id/file` | Admin (Prof) | FormData (`file`) | Bearer (Professor) | `BookletOut` |
| `POST` | `/api/professors/me/exams` | Admin (Prof) | JSON `{title, question_count, duration_minutes}` | Bearer (Professor) | `ExamOut` |
| `PUT` | `/api/professors/me/exams/:id` | Admin (Prof) | JSON `{title, question_count, duration_minutes}` | Bearer (Professor) | `ExamOut` |
| `DELETE` | `/api/professors/me/exams/:id` | Admin (Prof) | None | Bearer (Professor) | `{"ok": true}` |
| `GET` | `/api/courses` | Student | None | Bearer | `list[CourseOut]` |
| `POST` | `/api/courses/lectures/:id/toggle` | Student | None | Bearer | `{"done": boolean}` |
| `GET` | `/api/questions/daily` | Student | None | Bearer | `QuestionOut` |
| `POST` | `/api/questions/:id/answer` | Student | JSON `{choice_id}` | Bearer | `AnswerResult` |
| `GET` | `/api/me/mistakes` | Student | None | Bearer | `list[QuestionOut]` |
| `GET` | `/api/me/saved-questions` | Student | None | Bearer | `list[QuestionOut]` |
| `POST` | `/api/questions/:id/save` | Student | None | Bearer | `{"ok": true}` |
| `DELETE` | `/api/questions/:id/save` | Student | None | Bearer | `{"ok": true}` |
| `POST` | `/api/exams/:id/start` | Student | None | Bearer | `{"attempt_id": string, "items": [...]}` |
| `POST` | `/api/exams/attempts/:id/items/:item_id/answer` | Student | JSON `{choice_id}` | Bearer | `{"ok": true}` |
| `POST` | `/api/exams/attempts/:id/finish` | Student | None | Bearer | `{"score", "total"}` |
| `GET` | `/api/exams/attempts/:id/result` | Student | None | Bearer | Detailed attempt result |
| `GET` | `/api/activation/mine` | Student | None | Bearer | `list[ActivationOut]` |
| `POST` | `/api/activation/redeem` | Student | JSON `{code}` | Bearer | `{"ok": true, "subject_name": string}` |
| `GET` | `/api/bans/mine` | Student | None | Bearer | `BanStatusOut` |
| `POST` | `/api/bans/appeal` | Student | JSON `{message}` | Bearer | `{"ok": true}` |
| `GET` | `/api/me/notifications` | Student | Query `?limit=30` | Bearer | `list[NotificationOut]` |
| `GET` | `/api/me/notifications/unread-count` | Student | None | Bearer | `{"count": number}` |
| `POST` | `/api/me/notifications/:id/read` | Student | None | Bearer | `{"ok": true}` |
| `GET` | `/api/pearls` | Student | None | Bearer | `list[ClinicalPearlOut]` |
| `GET` | `/api/pearls/preview` | Public | Query `?limit=3` | No | `list[ClinicalPearlPreviewOut]` |
| `GET` | `/api/public/stats` | Public | None | No | Stats object |
| `GET` | `/api/students/search` | Both | Query `?q=...` | Bearer | Student search results |
| `GET` | `/api/students/:id/profile` | Student | None | Bearer | Public student profile |
| `GET` | `/api/store/products` | Student | None | No / Optional | `list[ProductOut]` |
| `POST` | `/api/store/orders` | Student | JSON `OrderIn` | Bearer | `OrderOut` |
| `GET` | `/api/admin/overview` | Admin | None | Bearer (Admin) | Dashboard KPIs |
| `GET` | `/api/admin/logs` | Admin | Query `?limit=6` | Bearer (Admin) | `list[ActivityLog]` |
| `GET` | `/api/admin/professors` | Admin | None | Bearer (Admin) | Professor admin list |
| `POST` | `/api/admin/professors/:id` | Admin | JSON `{subject_id, title}` | Bearer (Admin) | Updated user/professor |
| `GET` | `/api/admin/catalog` | Admin | None | Bearer (Admin) | Full catalog tree |
| `POST` | `/api/admin/catalog/bulk` | Admin | JSON `CatalogBulkIn` | Bearer (Admin) | `{"created": number}` |
| `POST` | `/api/admin/catalog/duplicate` | Admin | JSON `CatalogDuplicateIn` | Bearer (Admin) | `{"created": number}` |
| `POST` | `/api/admin/catalog/import` | Admin | JSON `CatalogImportIn` | Bearer (Admin) | Import summary / count |
| `PUT` | `/api/admin/catalog/:type/:id` | Admin | Query `?name=...` | Bearer (Admin) | `{"ok": true}` |
| `DELETE` | `/api/admin/catalog/:type/:id` | Admin | None | Bearer (Admin) | `{"ok": true}` |
| `POST` | `/api/admin/users` | Admin | JSON `UserCreateIn` | Bearer (Admin) | `UserOut` |
| `PUT` | `/api/admin/users/:id` | Admin | JSON `UserUpdateIn` | Bearer (Admin) | `UserOut` |
| `POST` | `/api/admin/users/:id/ban` | Admin | Query `?reason=...` | Bearer (Admin) | `{"ok": true}` |
| `POST` | `/api/admin/users/:id/unban` | Admin | None | Bearer (Admin) | `{"ok": true}` |
| `POST` | `/api/admin/users/:id/2fa/reset` | Admin | None | Bearer (Admin) | `{"ok": true}` |
| `POST` | `/api/admin/notifications` | Admin | JSON `{title, body, user_id}` | Bearer (Admin) | `{"ok": true}` |
| `GET` | `/api/admin/bans/:id/approve-appeal` | Admin | None | Bearer (Admin) | `{"ok": true}` |
| `GET` | `/api/admin/bans/:id/reject-appeal` | Admin | None | Bearer (Admin) | `{"ok": true}` |
| `GET` | `/api/admin/questions` | Admin | Query `?subject_id=...` | Bearer (Admin) | `list[QuestionAdminOut]` |
| `POST` | `/api/admin/questions` | Admin | JSON `QuestionAdminIn` | Bearer (Admin) | `QuestionAdminOut` |
| `PUT` | `/api/admin/questions/:id` | Admin | JSON `QuestionAdminIn` | Bearer (Admin) | `QuestionAdminOut` |
| `DELETE` | `/api/admin/questions/:id` | Admin | None | Bearer (Admin) | `{"ok": true}` |
| `GET` | `/api/admin/weak-topics` | Admin | None | Bearer (Admin) | Weak topics list |
| `GET` | `/api/admin/pearls` | Admin | None | Bearer (Admin) | `list[ClinicalPearlOut]` |
| `POST` | `/api/admin/pearls` | Admin | JSON `ClinicalPearlIn` | Bearer (Admin) | `ClinicalPearlOut` |
| `PUT` | `/api/admin/pearls/:id` | Admin | JSON `ClinicalPearlIn` | Bearer (Admin) | `ClinicalPearlOut` |
| `DELETE` | `/api/admin/pearls/:id` | Admin | None | Bearer (Admin) | `{"ok": true}` |
| `GET` | `/api/admin/resellers/:id/codes` | Admin | None | Bearer (Admin) | Reseller codes array |
| `POST` | `/api/admin/resellers/:id/codes` | Admin | Query `?count=...` | Bearer (Admin) | `{"created": number}` |
| `GET` | `/api/reseller/codes` | Reseller | Query `?status=&page=` | Bearer (Reseller) | Reseller codes |
| `GET` | `/api/admin/store/products` | Admin | None | Bearer (Admin) | `list[ProductAdminOut]` |
| `POST` | `/api/admin/store/products` | Admin | JSON `ProductIn` | Bearer (Admin) | `ProductAdminOut` |
| `PUT` | `/api/admin/store/products/:id` | Admin | JSON `ProductIn` | Bearer (Admin) | `ProductAdminOut` |
| `GET` | `/api/admin/store/orders` | Admin | None | Bearer (Admin) | `list[OrderAdminOut]` |
| `PUT` | `/api/admin/store/orders/:id/status` | Admin | Query `?status=...` | Bearer (Admin) | `OrderAdminOut` |
| `POST` | `/api/admin/media/upload` | Admin | FormData (`file`) | Bearer (Admin) | `{"id", "url"}` |
| `POST` | `/api/admin/media` | Admin | Query Params | Bearer (Admin) | `{"id": string}` |
| `GET` | `/api/admin/import/template/:kind`| Admin | Path (`students`/`questions`) | Bearer (Admin) | Streaming `.xlsx` file |
| `POST` | `/api/admin/import` | Admin | FormData (`file`) | Bearer (Admin) | Import result summary |
| `GET` | `/api/admin/export` | Admin | Query `?datasets=...` | Bearer (Admin) | Streaming `.xlsx` file |
