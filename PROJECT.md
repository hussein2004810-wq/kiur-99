# Project: Nabd/Kiur Backend Rewrite (FastAPI to TypeScript Hono / Cloudflare Workers)

## Architecture
- **Runtime**: Cloudflare Workers (V8 isolates, serverless edge, zero-cost tier).
- **Framework**: Hono v4 (lightweight, ultra-fast web framework with native Web Standards `Request`/`Response`).
- **Database Layer**: Cloudflare D1 (Serverless SQLite) with Drizzle ORM (`drizzle-orm/d1`) for type-safe queries and relations.
- **Storage Layer**: Cloudflare R2 (S3-compatible, zero-egress object storage) via native Worker bindings (`env.R2_BUCKET`).
- **Crypto & Security**: Web Crypto API (`crypto.subtle`) for PBKDF2-HMAC-SHA256 (200,000 iterations), JWT generation/verification (`jose` or Hono jwt), and RFC 6238 TOTP.
- **Data Serialization**: Strictly `snake_case` JSON payloads without outer envelope wrapping. Error format `{ "detail": "..." }`.
- **Frontend Compatibility**: 100% identical API surface and route contracts to serve `nabd-home-quiz-prototype.html` (`/`) and `nabd-admin-dashboard.html` (`/admin`) without modifying a single line of frontend code.

## Code Layout
```
├── src/
│   ├── index.ts                # Main entrypoint, Hono app instance, route mounting, static file routes
│   ├── types.ts                # AppEnv (Bindings for DB, R2, vars, secrets; Variables for user, session)
│   ├── config.ts               # Configuration helpers, defaults, constants
│   ├── db/
│   │   ├── index.ts            # Drizzle D1 database instance factory
│   │   └── schema.ts           # All 30 tables and 5 Enums defined using drizzle-orm/sqlite-core
│   ├── middleware/
│   │   ├── auth.ts             # Auth middleware (requireAuth, requireRole, single-active-session check)
│   │   ├── cors.ts             # CORS handling
│   │   └── error.ts            # Centralized exception/error handler returning { detail: string }
│   ├── services/
│   │   ├── crypto.ts           # PBKDF2-HMAC-SHA256, password verification, token generation
│   │   ├── jwt.ts              # JWT signing and verification with expiration
│   │   ├── totp.ts             # RFC 6238 TOTP generation and validation
│   │   ├── storage.ts          # R2 storage wrapper (put, get, delete, exists, range streaming)
│   │   └── mailer.ts           # Email sending (background task using c.executionCtx.waitUntil)
│   └── routes/
│       ├── auth.ts             # /auth/* (login, register, session, 2fa, google, reset password)
│       ├── catalog.ts          # /api/catalog/* (sections, universities, stages, subjects, booklets)
│       ├── questions.ts        # /api/questions/* and /api/saved-questions/*
│       ├── exams.ts            # /api/exams/* (attempt flow, submission, scoring, history, leaderboard)
│       ├── students.ts         # /api/students/* (profile, stats, skills, study tracker, lecture progress)
│       ├── pearls.ts           # /api/pearls/* (clinical pearls)
│       ├── courses.ts          # /api/courses/* and /api/lectures/*
│       ├── professors.ts       # /api/professors/* (portal, booklets, questions, exams, courses)
│       ├── store.ts            # /api/store/* (products, orders, order items)
│       ├── reseller.ts         # /api/reseller/* (reseller inventory, activations)
│       ├── activation.ts       # /api/activation/* (code redemption)
│       ├── admin.ts            # /api/admin/* (users, stats, logs, media, bulk actions)
│       ├── bans.ts             # /api/bans/* (ban records, appeals)
│       ├── notifications.ts    # /api/notifications/*
│       ├── import-export.ts    # /api/admin/import and /api/admin/export (Excel parsing/generation)
│       ├── media.ts            # /media-files/:name (HTTP Range streaming from R2)
│       └── public.ts           # /api/public/* (public stats, professor catalog)
├── migrations/
│   └── 0000_initial_schema.sql # Raw D1 SQLite initial schema DDL
├── public/                     # Static frontend SPA files (served with Cache-Control: no-cache)
│   ├── nabd-home-quiz-prototype.html
│   └── nabd-admin-dashboard.html
├── test/                       # E2E & integration test suites (Tiers 1-4)
│   ├── fixtures/
│   ├── tier1-features/
│   ├── tier2-boundaries/
│   ├── tier3-combinations/
│   └── tier4-scenarios/
├── wrangler.toml               # Cloudflare Workers configuration (D1, R2, vars)
├── package.json                # Dependencies, build/test scripts
├── tsconfig.json               # TypeScript configuration
├── vitest.config.ts            # Vitest testing configuration
└── drizzle.config.ts           # Drizzle kit configuration
```

## Feature Inventory
| # | Feature Group | Scope & Endpoints | Milestone | Source |
|---|---|---|---|---|
| 1 | Infrastructure & Schema | Wrangler config, D1 SQLite schema (30 tables), Drizzle ORM, CORS, Error middleware, Static SPA serving | M1 | app/main.py, app/models.py, app/database.py |
| 2 | Auth & Registration | `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/me`, `/auth/change-password` | M2 | app/routers/auth.py |
| 3 | Session & Anti-Piracy | `/auth/session`, `/auth/session/restore`, single-active-session `user_sessions` validation | M2 | app/routers/auth.py, app/security.py |
| 4 | Two-Factor Auth (2FA) | `/auth/2fa/setup`, `/auth/2fa/verify`, `/auth/2fa/disable`, `/auth/2fa/login` | M2 | app/routers/auth.py |
| 5 | Password Reset & Recovery | `/auth/forgot-password`, `/auth/reset-password` (SHA-256 token hashing, email dispatch) | M2 | app/routers/auth.py, app/mailer.py |
| 6 | Google OAuth 2.0 | `/auth/google/login`, `/auth/google/callback` with URL hash fragments | M2 | app/routers/auth.py |
| 7 | Academic Catalog | `/api/catalog/sections`, `/universities`, `/stages`, `/subjects`, `/booklets` | M3 | app/routers/catalog.py |
| 8 | Questions & Saved Questions | `/api/questions/*`, `/api/saved-questions/*` (bookmarks, notes) | M3 | app/routers/questions.py |
| 9 | Exams & Attempt Engine | `/api/exams/*` (create, start attempt, submit question answer, finish, leaderboard) | M3 | app/routers/exams.py |
| 10 | Student Workspace | `/api/students/profile`, `/stats`, `/skills`, `/study-tracker`, `/lecture-progress` | M3 | app/routers/students.py |
| 11 | Clinical Pearls | `/api/pearls/*` (daily pearls, bookmarking, reactions) | M3 | app/routers/pearls.py |
| 12 | Courses & Lectures | `/api/courses/*`, `/api/lectures/*`, `/recent-views` | M4 | app/routers/courses.py |
| 13 | Professor Portal | `/api/professors/*` (profile, booklets, questions, exams, courses, lectures, stats) | M4 | app/routers/professors.py |
| 14 | Store & Products | `/api/store/products`, `/api/store/orders`, `/api/store/order-items` | M4 | app/routers/store.py |
| 15 | Reseller Operations | `/api/reseller/inventory`, `/api/reseller/activations`, `/api/reseller/generate` | M4 | app/routers/reseller.py |
| 16 | Activation Redemption | `/api/activation/redeem` (rate limiting, code validation, role upgrading) | M4 | app/routers/activation.py |
| 17 | Admin Management | `/api/admin/overview`, `/users`, `/users/:id/role`, `/logs`, `/media` | M5 | app/routers/admin.py |
| 18 | Bans & Appeals | `/api/bans/records`, `/api/bans/appeal`, `/api/bans/lift` | M5 | app/routers/bans.py |
| 19 | Notifications System | `/api/notifications/*` (list, mark read, unread count) | M5 | app/routers/notifications.py |
| 20 | Excel Import / Export | `/api/admin/import`, `/api/admin/export` | M5 | app/routers/import_export.py |
| 21 | Cloudflare R2 Storage | `/media-files/:name` streaming with Range requests, photo/PDF/video uploads | M5 | app/storage.py, app/main.py |
| 22 | Public Endpoints | `/api/public/stats`, `/api/public/professors` | M5 | app/routers/public.py |
| 23 | E2E Test Suite Pass | 100% pass across all Tiers 1-4 | M6 | ORIGINAL_REQUEST.md |
| 24 | Adversarial Hardening | Tier 5 adversarial stress testing, coverage gaps, and Forensic Integrity Audit | M6 | Project Pattern |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Foundation & Database Layer | TypeScript project setup, `wrangler.toml`, Drizzle ORM schema (30 tables), D1 migration SQL, error/CORS middleware, SPA static serving | none | DONE |
| M2 | Auth, Sessions & Security | PBKDF2 Web Crypto, JWT, 2FA TOTP, session cookies, anti-piracy validation, Google OAuth, auth middleware | M1 | PLANNED |
| M3 | Catalog, Questions, Exams & Students | Academic catalog, questions/saved questions, exam attempt engine, student stats & skills, clinical pearls | M1, M2 | PLANNED |
| M4 | Courses, Professors, Store & Activations | Courses & lectures, professor portal & uploads, store products/orders, reseller portal, activation codes | M1, M2, M3 | PLANNED |
| M5 | Admin, Bans, Notifications, Media & Import | Admin dashboard APIs, bans/appeals, notifications, R2 media streaming (Range requests), Excel import/export, public APIs | M1, M2, M3, M4 | PLANNED |
| M6 | Final Verification & Coverage Hardening | 100% E2E test suite pass (Tiers 1-4), Tier 5 adversarial coverage hardening, and Forensic Integrity Audit | M1, M2, M3, M4, M5 | PLANNED |

## Interface Contracts
### App Environment (`src/types.ts`)
```typescript
export interface AppBindings {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  JWT_SECRET: string;
  JWT_ALGORITHM?: string;
  JWT_EXPIRES_MINUTES?: string;
  DEBUG?: string;
  CORS_ORIGINS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM?: string;
  SMTP_FROM_NAME?: string;
}

export interface CurrentUser {
  id: string;
  email: string;
  full_name: string;
  role: 'student' | 'professor' | 'admin' | 'reseller';
  is_banned: boolean;
  university_id?: string | null;
  stage_id?: string | null;
  section_id?: string | null;
}

export interface CurrentSession {
  id: string;
  user_id: string;
  device_label: string;
  is_active: boolean;
}

export interface AppVariables {
  user?: CurrentUser;
  session?: CurrentSession;
  requestId: string;
}

export type AppEnv = {
  Bindings: AppBindings;
  Variables: AppVariables;
};
```

### Response Formats
- **Standard Success**: Direct JSON object or array matching Python Pydantic output, with `snake_case` keys.
- **Standard Error**: `{ "detail": "نص رسالة الخطأ بالعربية" }` with appropriate HTTP status code (400, 401, 403, 404, 429, 503).
- **Session Cookie**: `nabd_session=<token>; Path=/auth/session; HttpOnly; SameSite=Lax; Max-Age=1209600`.
- **Media Serving**: `GET /media-files/:name` returns streaming R2 object body with `Content-Type`, `Content-Length`, `ETag`, and `Accept-Ranges: bytes` (status 200 or 206 for Range requests).
