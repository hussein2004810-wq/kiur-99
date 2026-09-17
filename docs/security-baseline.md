# KIUR-99 Security Baseline & Inventory

**Date:** 2026-09-17  
**Status:** Stage 0 Completed  
**Test Baseline:** 23 test suites passing (358 tests total), `tsc --noEmit` clean (0 errors).

---

## 1. Route Classification & Access Matrix

### A. Public Routes (No Authentication Required)
- `GET /health` — Health check probe
- `GET /` — Student Single Page Application HTML
- `GET /admin` — Admin Dashboard Single Page Application HTML
- `POST /auth/register` — User registration with email/password
- `POST /auth/login` — Authentication via email & password
- `GET /auth/google/login` — Google OAuth redirection
- `GET /auth/google/callback` — Google OAuth authorization code exchange
- `POST /auth/2fa/verify` — Two-factor TOTP verification for pending login
- `POST /auth/session/restore` — Session restoration using HTTP-only cookie
- `POST /auth/forgot-password` — Password reset link dispatch
- `POST /auth/reset-password` — Password update using single-use reset token
- `GET /api/catalog/tree` — Academic hierarchy (Sections -> Universities -> Stages -> Subjects)
- `GET /api/public/stats` — High-level platform statistics
- `GET /api/pearls/preview` — Unauthenticated clinical pearls sample preview
- `GET /media-files/:name` — Object/media streaming (to be guarded with private object authorization in Stage 16)

### B. Authenticated Base Routes (`requireAuth`)
- `POST /auth/logout` — Server-side session deactivation
- `GET /auth/me` — Current user profile retrieval
- `PUT /auth/me/profile` — Update basic profile metadata
- `PUT /auth/me/caption` — Update student bio/caption
- `PUT /auth/me/preferences` — Update UI and account preferences
- `POST /auth/me/photo` — Upload and update user avatar
- `POST /auth/me/skills` — Add student skill
- `DELETE /auth/me/skills/:skill_id` — Remove student skill
- `POST /auth/me/recent-view` — Record navigation history
- `GET /auth/me/continue-card` — Resume learning context
- `GET /auth/me/stats` — Student performance statistics
- `GET /auth/me/daily` — Daily streak and question quotas
- `GET /auth/me/performance` — Detailed historical accuracy breakdown
- `GET /auth/me/leaderboard` — Peer academic ranking
- `GET /auth/me/history` — Student activity timeline
- `GET /auth/me/sessions` — Active login sessions
- `POST /auth/change-password` — Authenticated password update
- `POST /auth/2fa/setup` — Generate TOTP secret & QR URI
- `POST /auth/2fa/enable` — Confirm TOTP setup
- `POST /auth/2fa/disable` — Turn off 2FA
- `GET /api/questions/subject/:subject_id` — Subject practice questions
- `POST /api/questions/:question_id/answer` — Submit practice answer
- `POST /api/questions/:question_id/save` — Bookmark question
- `DELETE /api/questions/:question_id/save` — Remove bookmark
- `GET /api/questions/saved/mine` — List bookmarked questions
- `GET /api/questions/mistakes/mine` — Review incorrect answers
- `POST /api/exams/start` — Start timed or practice exam
- `POST /api/exams/:attempt_id/answer` — Record exam question response
- `POST /api/exams/:attempt_id/finish` — Finalize exam attempt
- `GET /api/exams/:attempt_id/result` — Fetch score and corrections
- `GET /api/courses` — List enrolled courses
- `GET /api/courses/:course_id` — Course syllabus & details
- `GET /api/courses/:course_id/materials` — Course attachments & resources
- `POST /api/courses/lectures/:lecture_id/complete` — Mark lecture finished
- `GET /api/pearls` — Clinical pearls directory
- `GET /api/pearls/:pearl_id` — Single pearl details
- `GET /api/notifications` — In-app alerts
- `GET /api/notifications/unread-count` — Count unread alerts
- `POST /api/notifications/:id/read` — Mark alert read
- `POST /api/notifications/read-all` — Mark all alerts read
- `GET /api/bans/mine` — Check active ban status
- `POST /api/bans/appeal` — Submit ban appeal statement
- `POST /api/activation/redeem` — Redeem voucher code
- `GET /api/activation/mine` — List redeemed vouchers
- `GET /api/students` — Search public student profiles
- `GET /api/students/:id/profile` — View specific student public profile
- `GET /api/store/products` — Browse store catalogue
- `POST /api/store/orders` — Create purchase order
- `GET /api/store/orders/mine` — View order status

### C. Professor Portal (`requireProfessor`: professor | admin)
- `GET /api/professors` — Directory of professors
- `GET /api/professors/me` — Authenticated professor identity & subject
- `GET /api/professors/dashboard` — Activity overview
- `GET /api/professors/students` — Students enrolled in professor's subject
- `GET /api/professors/booklets` / `POST /api/professors/booklets` / `DELETE /api/professors/booklets/:id`
- `GET /api/professors/exams` / `POST /api/professors/exams` / `DELETE /api/professors/exams/:id`
- `GET /api/professors/courses` / `POST /api/professors/courses` / `DELETE /api/professors/courses/:id`
- `POST /api/professors/courses/:id/lectures` / `DELETE /api/professors/lectures/:id`
- `POST /api/professors/upload` — Upload lecture pdf/slides

### D. Reseller Portal (`requireRole('reseller', 'admin')`)
- `GET /api/reseller/summary` — Code distribution analytics
- `GET /api/reseller/codes` — List assigned codes
- `POST /api/reseller/codes/take` — Claim code batch

### E. Admin Portal (`requireAdmin`)
- `GET /api/admin/overview` — System KPI dashboard
- `GET /api/admin/users` / `POST /api/admin/users` / `PUT /api/admin/users/:id` / `DELETE /api/admin/users/:id`
- `GET /api/admin/professors` / `POST /api/admin/professors`
- `GET /api/admin/reseller/codes` / `POST /api/admin/reseller/codes`
- `GET /api/admin/bans` / `POST /api/admin/bans` / `DELETE /api/admin/bans/:id` / `PUT /api/admin/bans/:id/appeal`
- `GET /api/admin/catalog` / CRUD for sections, universities, stages, subjects
- `GET /api/admin/questions` / `POST /api/admin/questions` / `PUT /api/admin/questions/:id` / `DELETE /api/admin/questions/:id`
- `GET /api/admin/weak-topics`
- `GET /api/admin/students`
- `POST /api/admin/media/upload`
- `GET /api/admin/store/products` / `POST /api/admin/store/products` / `PUT /api/admin/store/products/:id` / `DELETE /api/admin/store/products/:id`
- `GET /api/admin/store/orders` / `PUT /api/admin/store/orders/:order_id/status`
- `GET /api/admin/notifications` / `POST /api/admin/notifications`
- `GET /api/admin/pearls` / `POST /api/admin/pearls` / `PUT /api/admin/pearls/:id` / `DELETE /api/admin/pearls/:id`

---

## 2. Environment Variables & Bindings Inventory

| Binding / Variable | Type | Invariant / Requirement |
| :--- | :--- | :--- |
| `DB` | D1Database | SQLite storage on Cloudflare D1. Bound and required. |
| `R2_BUCKET` | R2Bucket | Media storage on Cloudflare R2. Optional with graceful fallback. |
| `JWT_SECRET` | string | Used for signing & verifying JWTs. Must fail closed in production if insecure/default. |
| `JWT_ALGORITHM` | string | Must be explicitly constrained to approved algorithms (HS256). |
| `JWT_EXPIRES_MINUTES` | string | Token lifespan. Target 15-30 min access token in hardened policy. |
| `DEBUG` | string | "true" or "false". Controls stack trace leakage and dev bypasses. |
| `BOOTSTRAP_ADMIN_EMAIL`| string | One-time server-side bootstrap admin email. Must not be hijacked. |
| `CORS_ORIGINS` | string | Allowed origins allowlist. Must reject wildcard with credentials. |
| `ALLOWED_UNIVERSITY_DOMAINS`| string | Restricted university domains for student registration. |
| `GOOGLE_CLIENT_ID` | string | Google OAuth application client ID. |
| `GOOGLE_CLIENT_SECRET` | string | Google OAuth secret. Never logged or exposed. |
| `GOOGLE_REDIRECT_URI` | string | Validated callback destination. |
| `PASSWORD_RESET_TTL_MINUTES` | string | Expiration of password reset tokens. |
| `PASSWORD_RESET_COOLDOWN_SECONDS` | string | Reset request throttling. |
| `SMTP_*` | string | Mailer configuration for password reset emails. |

---

## 3. Vulnerability Inventory & Audit Findings

1. **Production Secret Validation (Stage 1):** Currently, default placeholder secrets like `"dev-secret-change-me..."` are allowed when `DEBUG="false"`. Production must fail closed.
2. **JWT Hardening (Stage 2):** JWTs lack explicit `iss`, `aud`, and `token_type` ("access" vs "pending_2fa") validation. Token expiry defaults to 20160 minutes (14 days), far too long for an access token.
3. **Session Hardening (Stage 3):** Session deactivation and creation should be race-condition resistant.
4. **Cookie Policy (Stage 4):** Session restoration cookie needs strict `HttpOnly`, `Secure`, `SameSite=Lax`, and narrow path scoping.
5. **CORS & CSRF (Stage 5):** When credentials are used, CORS cannot allow wildcard origins. State-changing requests must validate origin.
6. **Security Headers & CSP (Stage 6):** Global responses currently lack CSP, HSTS, X-Content-Type-Options: nosniff, and Permissions-Policy.
7. **Body Limits & Schema Parsing (Stage 7):** Incoming JSON bodies are parsed without size limits, making endpoints vulnerable to memory exhaustion / DoS.
8. **Rate Limiting (Stage 8):** Auth endpoints (`/login`, `/register`, `/forgot-password`, `/2fa/verify`) need strict rate limiting to prevent brute force.
9. **Authorization & IDOR (Stages 9, 10, 11):** Exam attempts, student answer submissions, profiles, and media downloads must strictly verify user ownership server-side.
10. **Exam Integrity (Stage 17):** Server must be sole authority on start time, duration, attempt status, and scoring.

