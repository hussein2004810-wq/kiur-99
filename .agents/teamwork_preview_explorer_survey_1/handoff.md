# API and Routes Investigation & Catalog Handoff Report

**Agent**: Explorer 1 (API and Routes Explorer)  
**Parent Conversation ID**: `fdf0f062-12fc-46d6-8dd0-3c6786653821`  
**Working Directory**: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_survey_1`  
**Date**: 2026-09-17  

---

## 1. Observation

### 1.1 Architecture & Directory Tree
The Python backend codebase is located at `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\app`:
```
app/
├── __init__.py
├── config.py             # Settings, pydantic-settings, environment configuration
├── database.py           # SQLAlchemy 2.x engine, SessionLocal, get_db dependency
├── deps.py               # Authentication dependencies: get_current_user, require_role
├── mailer.py             # SMTP email delivery for password reset
├── main.py               # FastAPI app initialization, middleware, routes inclusion
├── models.py             # SQLAlchemy models, enums (Role, ProductType, OrderStatus, BanStatus, CodeStatus)
├── ranking.py            # Aggregate queries for student streaks, accuracy, leaderboards
├── schemas.py            # Pydantic v2 schemas for request bodies, responses, computed fields
├── security.py           # PBKDF2-SHA256 hashing, JWT tokens, TOTP RFC6238, session lifecycle
├── storage.py            # Local disk vs S3 object storage abstraction
└── routers/
    ├── __init__.py
    ├── activation.py     # Code redemption (/api/activation)
    ├── admin.py          # Full admin CRUD operations (/api/admin)
    ├── auth.py           # Auth, OAuth, 2FA, session, password reset, stats (/auth)
    ├── bans.py           # Ban status and appeals (/api/bans)
    ├── catalog.py        # Curriculum tree read (/api/catalog)
    ├── courses.py        # Student courses and lectures (/api/courses)
    ├── exams.py          # Exam engine and attempts (/api/exams)
    ├── import_export.py  # Excel templates, import and export (/api/admin)
    ├── notifications.py  # Student notifications (/api/me/notifications)
    ├── pearls.py         # Clinical pearls (/api/pearls)
    ├── professors.py     # Professor profiles & dashboard (/api/professors)
    ├── public.py         # Public platform counts (/api/public)
    ├── questions.py      # Question bank & answering (/api)
    ├── reseller.py       # Reseller panel & codes (/api/reseller)
    ├── store.py          # Product catalog & order creation (/api/store)
    └── students.py       # Student search & public profile (/api/students)
```

### 1.2 Application Setup & Middleware (`app/main.py`)
- **FastAPI Instance**: `app = FastAPI(title="Nabd API", version="0.1.0")`
- **SessionMiddleware**:
  ```python
  app.add_middleware(SessionMiddleware, secret_key=settings.jwt_secret)
  ```
  Required by Authlib for stashing OAuth `state` during Google OAuth redirect.
- **CORSMiddleware**:
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
  `allow_credentials=True` is mandatory because the session cookie `nabd_session` is sent with requests (`credentials: 'include'`).
- **Static / SPA Serving**:
  - `GET /` -> serves `nabd-home-quiz-prototype.html` with header `Cache-Control: no-cache`.
  - `GET /admin` -> serves `nabd-admin-dashboard.html` with header `Cache-Control: no-cache`.
  - `GET /media-files/{name}` -> serves file from local storage or returns HTTP 307 redirect to S3 signed URL.
  - `GET /health` -> `{"status": "ok"}`.

### 1.3 Authentication & Session Security Architecture (`app/security.py`, `app/deps.py`)
1. **Password Hashing**:
   - Algorithm: PBKDF2-HMAC-SHA256 (`hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200_000)`).
   - Salt: 16 cryptographically random bytes (`secrets.token_hex(16)` = 32 hex characters).
   - Iterations: 200,000.
   - Stored Format: `<salt_hex>$<digest_hex>` (e.g. `a1b2...$c3d4...`).
   - Verification: `hmac.compare_digest(check.hex(), digest_hex)`.
2. **Access Token (JWT)**:
   - Algorithm: HS256 (`jwt_algorithm: str = "HS256"`).
   - Secret: `jwt_secret` (checked at boot to ensure it is not the default `"dev-secret-change-me"` when `DEBUG=false`).
   - Expiration: `jwt_expires_minutes` (default 14 days = 20,160 minutes).
   - Payload:
     ```json
     {
       "sub": "<user_id>",
       "sid": "<session_id>",
       "exp": "<utc_timestamp>"
     }
     ```
3. **Session Cookie**:
   - Name: `nabd_session` (configurable via `session_cookie_name`).
   - Scope: strictly scoped to `Path=/auth/session`.
   - Attributes: `HttpOnly=True`, `SameSite=lax`, `Secure=True` (when `DEBUG=false`).
   - Role: Provides persistent authentication across browser refreshes without storing JWT tokens in localStorage. The frontend calls `POST /auth/session/restore` to trade the cookie for a fresh in-memory access token.
4. **Anti-Piracy (Single Active Session per User)**:
   - Enforced by `models.UserSession` table and `start_new_session()` in `app/security.py`.
   - On every login (`/auth/login`, `/auth/dev-login`, `/auth/google/callback`, `/auth/register`, `/auth/2fa/verify`), all existing active sessions for that user are invalidated (`is_active = False`).
   - On every authenticated API request, `deps.py:get_current_user_allow_banned` retrieves the `UserSession` by `payload["sid"]`.
   - If the session does not exist or `not session.is_active`, it rejects with `HTTP 401 Unauthorized: "تم تسجيل الدخول من جهاز آخر"`.
5. **Two-Factor Authentication (TOTP / RFC 6238)**:
   - 6 digits, 30-second period, HMAC-SHA1, Base32 secret.
   - Drift window: ±1 period (30s before, current, 30s after = 90s tolerance).
   - Intermediate 2FA Token: `create_2fa_pending_token(user_id)` issues a 5-minute JWT with payload `{"pending_2fa_user": user_id, "exp": ...}`. It lacks `sid`, so it cannot be used as a Bearer token. It only unlocks `POST /auth/2fa/verify`.
6. **Password Reset Token**:
   - Raw token: `secrets.token_urlsafe(32)` (43 characters).
   - Stored in DB: SHA-256 hash (`hashlib.sha256(raw.encode()).hexdigest()`). The raw token is sent only in the email.
   - TTL: 60 minutes (`PASSWORD_RESET_TTL_MINUTES`).
   - Request cooldown: 120 seconds (`PASSWORD_RESET_COOLDOWN_SECONDS`) per user.
   - On successful reset, all existing sessions for the user are immediately set to `is_active = False`.
7. **Rate Limiting & Lockout**:
   - Login lockout: 5 consecutive failed attempts (`failed_login_attempts`) locks account for 15 minutes (`locked_until`). Returns `HTTP 429`.
   - Code redemption lockout: 5 consecutive failed code attempts (`failed_redeem_attempts`) locks code redemption for 15 minutes (`redeem_locked_until`). Returns `HTTP 429`.
8. **Role-Based Access Control**:
   - Roles enum: `student`, `professor`, `admin`, `reseller`.
   - `get_current_user`: checks `user.is_banned` -> `HTTP 403: "هذا الحساب محظور"`.
   - `get_current_user_allow_banned`: used only by `/api/bans/mine` and `/api/bans/appeal`.
   - `require_role(*roles)`: checks `user.role.value in roles` -> `HTTP 403: "لا تملك صلاحية الوصول"`.
   - All routes in `app/routers/admin.py` and `app/routers/import_export.py` have router-level dependency `require_role("admin")`.
   - Reseller routes in `app/routers/reseller.py` check `user.role == Role.reseller`.
   - Professor routes in `app/routers/professors.py` check `user.role == Role.professor`.

---

## 2. Logic Chain

1. **System Entrypoint & Routing Logic**:
   - `app/main.py` mounts 16 sub-routers using `app.include_router()`.
   - Prefix analysis shows:
     - `/auth` -> `auth.py`
     - `/api/catalog` -> `catalog.py`
     - `/api` -> `questions.py`
     - `/api/professors` -> `professors.py`
     - `/api/courses` -> `courses.py`
     - `/api/store` -> `store.py`
     - `/api/admin` -> `admin.py` and `import_export.py`
     - `/api/reseller` -> `reseller.py`
     - `/api/activation` -> `activation.py`
     - `/api/bans` -> `bans.py`
     - `/api/exams` -> `exams.py`
     - `/api/me/notifications` -> `notifications.py`
     - `/api/students` -> `students.py`
     - `/api/pearls` -> `pearls.py`
     - `/api/public` -> `public.py`
   - In addition, `main.py` defines direct routes: `/media-files/{name}`, `/health`, `/`, and `/admin`.

2. **Frontend Interoperability Requirements**:
   - Direct inspection of `nabd-home-quiz-prototype.html` and `nabd-admin-dashboard.html` reveals client expectations:
     - `apiFetch` uses `credentials: 'include'` and adds header `Authorization: Bearer <token>`.
     - JSON error responses must include a `detail` string: `{ "detail": "<error_message>" }`.
     - 204 No Content responses are parsed as `null`.
     - On Google redirect / 2FA / Password Reset, parameters are returned in the URL hash fragment:
       - `#access_token=...`
       - `#requires_2fa=1&pending_token=...`
       - `#reset_token=...`
       - `#google_error=role`
     - The SPA relies on `POST /auth/session/restore` with cookie `nabd_session` to re-authenticate on page refresh.

3. **Status Codes & Validation Rules**:
   - Standard FastAPI HTTPException errors return `{ "detail": "message" }`.
   - Pydantic validation errors return status code 422 with `{ "detail": [...] }`.
   - Rate limit / lockouts return status code 429.
   - Unauthorized / invalid session returns 401.
   - Forbidden / banned / wrong role returns 403.
   - Not found returns 404.
   - Unconfigured external service (e.g. SMTP) returns 503 or 500 (OAuth client ID missing).

---

## 3. Comprehensive Endpoint Inventory Catalog (145 Routes)

Below is the complete catalog of every route in the backend:

### Group 1: Main Application Routes (`app/main.py`)
| # | Method | Path | Tag | Auth / Guard | Request Params / Body | Success Response | Error Codes |
|---|---|---|---|---|---|---|---|
| 1 | GET | `/health` | default | None | None | `{"status": "ok"}` (200) | - |
| 2 | GET | `/media-files/{name}` | default | None | Path: `name: str` | FileResponse or 307 RedirectResponse to S3 presigned URL | 404 ("الملف غير موجود") |
| 3 | GET | `/` | default | None | None | FileResponse (`nabd-home-quiz-prototype.html`), Header: `Cache-Control: no-cache` | - |
| 4 | GET | `/admin` | default | None | None | FileResponse (`nabd-admin-dashboard.html`), Header: `Cache-Control: no-cache` | - |

---

### Group 2: Authentication & Identity Routes (`app/routers/auth.py`)
**Prefix**: `/auth` | **Tag**: `auth`

| # | Method | Path | Auth / Guard | Request Params / Body | Success Response | Error Codes & Conditions |
|---|---|---|---|---|---|---|
| 5 | GET | `/auth/google/login` | None | Query: `next: str = ""` | 302 Redirect to Google OAuth URL | 500 (GOOGLE_CLIENT_ID unset) |
| 6 | GET | `/auth/google/callback` | None | OAuth callback params / code | 302 Redirect to `frontend_url#access_token=...` or `...#requires_2fa=1&pending_token=...` or `admin#google_error=role` | 403 (domain not allowed) |
| 7 | POST | `/auth/dev-login` | DEBUG=true only | Query: `email: str`, `name: str = "طالب تجريبي"` | `LoginResponse` (200) + Set-Cookie `nabd_session` | 404 (if `DEBUG=false`) |
| 8 | POST | `/auth/login` | None | Body: `schemas.PasswordLoginIn` (`email: str`, `password: str`) | `LoginResponse` (200) OR `{"requires_2fa": true, "pending_token": "..."}` | 401 (bad credentials), 403 (banned), 429 (locked out 15m) |
| 9 | POST | `/auth/2fa/verify` | None | Body: `schemas.TOTPVerifyIn` (`pending_token: str`, `code: str`) | `LoginResponse` (200) + Set-Cookie `nabd_session` | 401 (expired/invalid token or bad TOTP), 403 (banned), 429 (locked) |
| 10 | POST | `/auth/2fa/setup` | `get_current_user` | None | `schemas.TOTPSetupOut` (`secret: str`, `otpauth_uri: str`) | 401, 403 |
| 11 | POST | `/auth/2fa/enable` | `get_current_user` | Body: `schemas.TOTPCodeIn` (`code: str`) | `{"ok": true}` (200) | 400 (setup not started), 403 (wrong code) |
| 12 | POST | `/auth/2fa/disable` | `get_current_user` | Body: `schemas.TOTPCodeIn` (`code: str`) | `{"ok": true}` (200) | 400 (not enabled), 403 (wrong code) |
| 13 | POST | `/auth/register` | None | Body: `schemas.RegisterIn` (`email: str`, `password: str`, `full_name: str`) | `LoginResponse` (200) + Set-Cookie `nabd_session` | 400 (name missing, pwd < 8, email exists), 403 (domain not allowed) |
| 14 | GET | `/auth/me` | `get_current_user` | None | `schemas.UserOut` (200) | 401, 403 |
| 15 | PUT | `/auth/me/profile` | `get_current_user` | Body: `schemas.ProfileUpdateIn` (`full_name`, `phone`, `section_id`, `university_id`, `is_graduate: bool`, `stage_id?`) | `schemas.UserOut` (200) | 400 (missing name/phone/stage, university mismatch), 401, 403 |
| 16 | PUT | `/auth/me/caption` | `get_current_user` | Body: `schemas.CaptionUpdateIn` (`caption: str = ""`) | `schemas.UserOut` (200) | 401, 403 |
| 17 | PUT | `/auth/me/preferences` | `get_current_user` | Body: `schemas.PreferencesUpdateIn` (`theme?`, `language?`) | `schemas.UserOut` (200) | 400 (invalid theme not light/dark or language not ar/en/ku), 401, 403 |
| 18 | GET | `/auth/me/skills` | `get_current_user` | None | `list[{"id": str, "text": str}]` (200) | 401, 403 |
| 19 | POST | `/auth/me/skills` | `get_current_user` | Body: `schemas.SkillIn` (`text: str`) | `{"id": str, "text": str}` (200) | 400 (empty text or count >= 12), 401, 403 |
| 20 | DELETE | `/auth/me/skills/{skill_id}` | `get_current_user` | Path: `skill_id: str` | `{"ok": true}` (200) | 404 (not found or not own skill), 401, 403 |
| 21 | POST | `/auth/me/photo` | `get_current_user` | Form: `file: UploadFile = File(...)` | `schemas.UserOut` (200) | 400 (>20MB or bad ext not in IMAGE_EXTS), 401, 403 |
| 22 | POST | `/auth/me/recent-view` | `get_current_user` | Body: `schemas.RecentViewIn` (`content_type: str`, `content_id: str`) | `{"ok": true}` (200) | 400 (content_type not in 'booklet', 'lecture'), 401, 403 |
| 23 | GET | `/auth/me/continue` | `get_current_user` | None | `{"course": course_dict or null, "booklet": booklet_dict or null}` (200) | 401, 403 |
| 24 | GET | `/auth/me/stats` | `get_current_user` | None | `schemas.StudentStatsOut` (`answered_today`, `streak_days`, `rank`, `total_ranked`, `accuracy_pct`) | 401, 403 |
| 25 | GET | `/auth/me/daily` | `get_current_user` | Query: `days: int = Query(7, ge=1, le=31)` | `{"days": list[day_dict], "previous": {"answered", "correct"}}` (200) | 401, 403 |
| 26 | GET | `/auth/me/performance` | `get_current_user` | None | `list[{"subject_id", "subject_name", "answered", "correct", "accuracy_pct"}]` (200) | 401, 403 |
| 27 | GET | `/auth/leaderboard` | `get_current_user` | Query: `limit: int = Query(20, ge=1, le=100)` | `list[{"rank", "user_id", "full_name", "photo_url", "correct_count", "is_you"}]` (200) | 401, 403 |
| 28 | GET | `/auth/me/history` | `get_current_user` | None | `list[{"type": "exam"|"order"|"code", "at", "title", "detail"}]` (max 30) (200) | 401, 403 |
| 29 | POST | `/auth/change-password` | `get_current_user` | Body: `schemas.ChangePasswordIn` (`current_password: str = ""`, `new_password: str`) | `{"ok": true}` (200) | 400 (pwd < 8), 403 (wrong current password), 401 |
| 30 | GET | `/auth/me/sessions` | `get_current_user` | None | `list[schemas.SessionOut]` (`device_label`, `created_at`) (200) | 401, 403 |
| 31 | POST | `/auth/session/restore` | Cookie: `nabd_session` | None (reads cookie) | `schemas.LoginResponse` (200) + Set-Cookie updated `nabd_session` | 401 (missing/expired/inactive session, user missing), 403 (banned) |
| 32 | POST | `/auth/forgot-password` | None | Body: `schemas.ForgotPasswordIn` (`email: str`) | `{"ok": true, "message": "..."}` (200) (always identical response) | 503 (SMTP unconfigured) |
| 33 | POST | `/auth/reset-password` | None | Body: `schemas.ResetPasswordIn` (`token: str`, `new_password: str`) | `{"ok": true, "message": "..."}` (200) | 400 (pwd < 8, invalid/expired token), 403 (banned) |
| 34 | POST | `/auth/logout` | `get_current_user` | None | `{"ok": true}` (200) + delete cookie `nabd_session` | 401, 403 |

---

### Group 3: Catalog Routes (`app/routers/catalog.py`)
**Prefix**: `/api/catalog` | **Tag**: `catalog`

| # | Method | Path | Auth / Guard | Request Params / Body | Success Response | Error Codes |
|---|---|---|---|---|---|---|
| 35 | GET | `/api/catalog/tree` | None | None | `list[schemas.SectionOut]` (sections -> universities -> stages -> subjects) (200) | - |

---

### Group 4: Question Bank Routes (`app/routers/questions.py`)
**Prefix**: `/api` | **Tag**: `questions`

| # | Method | Path | Auth / Guard | Request Params / Body | Success Response | Error Codes |
|---|---|---|---|---|---|---|
| 36 | GET | `/api/subjects/{subject_id}/questions` | `get_current_user` | Path: `subject_id: str`, Query: `limit: int = Query(20, ge=1, le=100)`, `offset: int = 0` | `list[schemas.QuestionOut]` (200) | 401, 403 |
| 37 | POST | `/api/questions/{question_id}/answer` | `get_current_user` | Path: `question_id: str`, Body: `schemas.AnswerIn` (`choice_id: str`) | `schemas.AnswerResult` (`is_correct: bool`, `correct_choice_id: str`, `rationale: str`) (200) | 400 (invalid choice), 404 (question not found), 401, 403 |
| 38 | POST | `/api/questions/{question_id}/save` | `get_current_user` | Path: `question_id: str` | `{"ok": true, "saved": true}` (200) | 404 (question not found), 401, 403 |
| 39 | DELETE | `/api/questions/{question_id}/save` | `get_current_user` | Path: `question_id: str` | `{"ok": true, "saved": false}` (200) | 401, 403 |
| 40 | GET | `/api/me/saved-questions` | `get_current_user` | None | `list[schemas.QuestionOut]` (200) | 401, 403 |
| 41 | GET | `/api/me/mistakes` | `get_current_user` | Query: `limit: int = Query(50, ge=1, le=200)` | `list[{"question_id", "eyebrow", "text", "rationale", "your_choice", "correct_choice", "answered_at"}]` (200) | 401, 403 |

---

### Group 5: Professor Panel & Profile Routes (`app/routers/professors.py`)
**Prefix**: `/api/professors` | **Tag**: `professors`

| # | Method | Path | Auth / Guard | Request Params / Body | Success Response | Error Codes |
|---|---|---|---|---|---|---|
| 42 | GET | `/api/professors` | `get_current_user` | None | `list[schemas.ProfessorOut]` (200) | 401, 403 |
| 43 | GET | `/api/professors/{professor_id}` | `get_current_user` | Path: `professor_id: str` | `schemas.ProfessorOut` (200) | 404 (not found), 401, 403 |
| 44 | GET | `/api/professors/booklets/latest` | `get_current_user` | None | `{"id", "title", "pages", "file_url", "subject_name", "professor_id"}` or `null` (200) | 401, 403 |
| 45 | PUT | `/api/professors/me/profile` | `get_current_user` + role=professor | Body: `schemas.ProfessorProfileUpdateIn` (`title`, `bio?`, `photo_url?`) | `schemas.ProfessorOut` (200) | 403 (not professor), 404 (no profile), 401 |
| 46 | POST | `/api/professors/me/photo` | `get_current_user` + role=professor | Form: `file: UploadFile = File(...)` | `{"photo_url": str}` (200) | 400 (>20MB or bad ext), 403, 404, 401 |
| 47 | GET | `/api/professors/me/dashboard` | `get_current_user` + role=professor | None | `{"professor": {...}, "booklet_count", "exam_count", "student_count", "avg_student_score", "booklets", "exams"}` (200) | 403, 404, 401 |
| 48 | GET | `/api/professors/me/students` | `get_current_user` + role=professor | None | `list[{"id", "name", "answered_count", "avg_score", "last_answered_at"}]` (200) | 403, 404, 401 |
| 49 | POST | `/api/professors/me/booklets` | `get_current_user` + role=professor | Body: `schemas.BookletIn` (`title: str`, `pages: int = 0`) | `schemas.BookletOut` (200) | 403, 404, 401 |
| 50 | PUT | `/api/professors/me/booklets/{booklet_id}` | `get_current_user` + role=professor | Path: `booklet_id: str`, Body: `schemas.BookletIn` | `schemas.BookletOut` (200) | 404 (not found or not own booklet), 403, 401 |
| 51 | DELETE | `/api/professors/me/booklets/{booklet_id}` | `get_current_user` + role=professor | Path: `booklet_id: str` | `{"ok": true}` (200) | 404, 403, 401 |
| 52 | POST | `/api/professors/me/booklets/{booklet_id}/file` | `get_current_user` + role=professor | Path: `booklet_id: str`, Form: `file: UploadFile = File(...)` | `schemas.BookletOut` (200) | 400 (>20MB or bad ext not in DOC_EXTS\|IMAGE_EXTS), 404, 403, 401 |
| 53 | POST | `/api/professors/me/exams` | `get_current_user` + role=professor | Body: `schemas.ExamIn` (`title: str`, `question_count: int = 0`, `duration_minutes: int = 30`) | `schemas.ExamOut` (200) | 403, 404, 401 |
| 54 | PUT | `/api/professors/me/exams/{exam_id}` | `get_current_user` + role=professor | Path: `exam_id: str`, Body: `schemas.ExamIn` | `schemas.ExamOut` (200) | 404, 403, 401 |
| 55 | DELETE | `/api/professors/me/exams/{exam_id}` | `get_current_user` + role=professor | Path: `exam_id: str` | `{"ok": true}` (200) | 404, 403, 401 |
| 56 | GET | `/api/professors/me/courses` | `get_current_user` + role=professor | None | `list[{"id", "title", "lectures": [...]}]` (200) | 403, 404, 401 |
| 57 | POST | `/api/professors/me/courses` | `get_current_user` + role=professor | Body: `schemas.CourseIn` (`title: str`) | `{"id", "title", "lectures": []}` (200) | 403, 404, 401 |
| 58 | PUT | `/api/professors/me/courses/{course_id}` | `get_current_user` + role=professor | Path: `course_id: str`, Body: `schemas.CourseIn` | `{"ok": true}` (200) | 404, 403, 401 |
| 59 | DELETE | `/api/professors/me/courses/{course_id}` | `get_current_user` + role=professor | Path: `course_id: str` | `{"ok": true}` (200) | 404, 403, 401 |
| 60 | POST | `/api/professors/me/courses/{course_id}/lectures` | `get_current_user` + role=professor | Path: `course_id: str`, Body: `schemas.LectureIn` (`title: str`, `duration_seconds: int = 0`) | `{"id", "title", "duration_seconds", "video_url": null}` (200) | 404, 403, 401 |
| 61 | PUT | `/api/professors/me/lectures/{lecture_id}` | `get_current_user` + role=professor | Path: `lecture_id: str`, Body: `schemas.LectureIn` | `{"ok": true}` (200) | 404, 403, 401 |
| 62 | DELETE | `/api/professors/me/lectures/{lecture_id}` | `get_current_user` + role=professor | Path: `lecture_id: str` | `{"ok": true}` (200) | 404, 403, 401 |
| 63 | POST | `/api/professors/me/lectures/{lecture_id}/file` | `get_current_user` + role=professor | Path: `lecture_id: str`, Form: `file: UploadFile = File(...)` | `{"id", "title", "duration_seconds", "video_url"}` (200) | 400 (>150MB or bad ext not in VIDEO_EXTS), 404, 403, 401 |

---

### Group 6: Courses Routes (`app/routers/courses.py`)
**Prefix**: `/api/courses` | **Tag**: `courses`

| # | Method | Path | Auth / Guard | Request Params / Body | Success Response | Error Codes |
|---|---|---|---|---|---|---|
| 64 | GET | `/api/courses` | `get_current_user` | None | `list[schemas.CourseOut]` (with `lectures` array with `done` booleans) (200) | 401, 403 |
| 65 | GET | `/api/courses/{course_id}` | `get_current_user` | Path: `course_id: str` | `schemas.CourseOut` (200) | 404, 401, 403 |
| 66 | GET | `/api/courses/{course_id}/materials` | `get_current_user` | Path: `course_id: str` | `{"booklets": list[...], "exams": list[...]}` (200) | 404, 401, 403 |
| 67 | POST | `/api/courses/lectures/{lecture_id}/complete` | `get_current_user` | Path: `lecture_id: str` | `{"ok": true}` (200) | 404, 401, 403 |

---

### Group 7: Store & Orders Routes (`app/routers/store.py`)
**Prefix**: `/api/store` | **Tag**: `store`

| # | Method | Path | Auth / Guard | Request Params / Body | Success Response | Error Codes |
|---|---|---|---|---|---|---|
| 68 | GET | `/api/store/products` | None | None | `list[schemas.ProductOut]` (`id`, `name`, `price`, `type`) (200) | - |
| 69 | POST | `/api/store/orders` | `get_current_user` | Body: `schemas.OrderIn` (`items: list[OrderItemIn(product_id, qty)]`, `payment_method: "zaincash"|"cod"`, `delivery_name?`, `delivery_phone?`, `delivery_address?`) | `schemas.OrderOut` (`id`, `total`, `status`, `payment_method`, `created_at`, `granted_activation_codes: []`) (200) | 400 (empty cart, COD without physical item, physical missing shipping info), 404 (product not found), 401, 403 |

---

### Group 8: Admin Panel Operations (`app/routers/admin.py`)
**Prefix**: `/api/admin` | **Tag**: `admin` | **All routes protected by**: `require_role("admin")`

| # | Method | Path | Auth / Guard | Request Params / Body | Success Response | Error Codes |
|---|---|---|---|---|---|---|
| 70 | GET | `/api/admin/overview` | `require_role("admin")` | None | `{"total_students", "active_activations", "pending_bans", "revenue_total", "weekly_activity": list[{"date", "count"}]}` (200) | 401, 403 |
| 71 | GET | `/api/admin/users` | `require_role("admin")` | Query: `role: str \| None = None` | `list[schemas.UserOut]` (200) | 401, 403 |
| 72 | POST | `/api/admin/users` | `require_role("admin")` | Body: `schemas.UserCreateIn` (`email`, `full_name`, `role`, `password?`, `subject_id?`, `title?`) | `schemas.UserOut` (200) | 400 (invalid role, email taken, professor missing subject_id), 404 (subject missing), 401, 403 |
| 73 | GET | `/api/admin/professors` | `require_role("admin")` | None | `list[{"user_id", "full_name", "email", "profile_id", "subject_id", "subject_name", "title"}]` (200) | 401, 403 |
| 74 | PUT | `/api/admin/professors/{user_id}` | `require_role("admin")` | Path: `user_id: str`, Body: `schemas.ProfessorAssignIn` (`subject_id`, `title = "أستاذ مساعد"`) | `{"profile_id", "subject_id", "title"}` (200) | 400 (not professor), 404 (user or subject not found), 401, 403 |
| 75 | PUT | `/api/admin/users/{user_id}` | `require_role("admin")` | Path: `user_id: str`, Body: `schemas.UserUpdateIn` (`email`, `full_name`, `role`, `password?`) | `schemas.UserOut` (200) | 400 (invalid role, email duplicate), 404 (user not found), 401, 403 |
| 76 | POST | `/api/admin/resellers/{reseller_id}/codes` | `require_role("admin")` | Path: `reseller_id: str`, Query: `count: int = 1`, `subject_id: str \| None = None` | `{"codes": list[str]}` (200) | 400 (count not 1-100), 404 (reseller or subject not found), 401, 403 |
| 77 | GET | `/api/admin/resellers/{reseller_id}/codes` | `require_role("admin")` | Path: `reseller_id: str` | `list[{"id", "code", "status", "subject_name", "sold_at"}]` (unmasked codes) (200) | 404 (reseller not found), 401, 403 |
| 78 | POST | `/api/admin/users/{user_id}/ban` | `require_role("admin")` | Path: `user_id: str`, Query: `reason: str` | `{"ok": true}` (200) | 404 (user not found), 401, 403 |
| 79 | POST | `/api/admin/users/{user_id}/unban` | `require_role("admin")` | Path: `user_id: str` | `{"ok": true}` (200) | 404 (user not found), 401, 403 |
| 80 | POST | `/api/admin/users/{user_id}/2fa/reset` | `require_role("admin")` | Path: `user_id: str` | `{"ok": true}` (200) | 404 (user not found), 401, 403 |
| 81 | GET | `/api/admin/logs` | `require_role("admin")` | Query: `limit: int = Query(50, ge=1, le=500)` | `list[{"id", "user_id", "action", "ip_address", "created_at"}]` (200) | 401, 403 |
| 82 | GET | `/api/admin/bans` | `require_role("admin")` | None | `list[{"id", "user_id", "user_name", "reason", "status", "created_at", "appeal_message", "appealed_at"}]` (200) | 401, 403 |
| 83 | POST | `/api/admin/bans/{ban_id}/approve-appeal` | `require_role("admin")` | Path: `ban_id: str` | `{"ok": true}` (200) | 404 (ban record not found), 401, 403 |
| 84 | POST | `/api/admin/bans/{ban_id}/reject-appeal` | `require_role("admin")` | Path: `ban_id: str` | `{"ok": true}` (200) | 404 (ban record not found), 401, 403 |
| 85 | GET | `/api/admin/catalog` | `require_role("admin")` | None | `list[{"id", "level": 0-3, "type": "section"\|"university"\|"stage"\|"subject", "name", "meta"}]` (200) | 401, 403 |
| 86 | POST | `/api/admin/catalog/sections` | `require_role("admin")` | Query: `name: str` | `{"id": str}` (200) | 401, 403 |
| 87 | POST | `/api/admin/catalog/universities` | `require_role("admin")` | Query: `name: str`, `section_id: str` | `{"id": str}` (200) | 404 (section not found), 401, 403 |
| 88 | POST | `/api/admin/catalog/stages` | `require_role("admin")` | Query: `name: str`, `university_id: str` | `{"id": str}` (200) | 404 (university not found), 401, 403 |
| 89 | POST | `/api/admin/catalog/subjects` | `require_role("admin")` | Query: `name: str`, `stage_id: str` | `{"id": str}` (200) | 404 (stage not found), 401, 403 |
| 90 | POST | `/api/admin/catalog/bulk` | `require_role("admin")` | Body: `schemas.CatalogBulkIn` (`parent_type: "root"\|"section"\|"university"\|"stage"`, `parent_id?`, `names: list[str]`) | `{"created": int, "skipped": int, "skipped_names": list[str]}` (200) | 400 (invalid parent_type or >300 names), 404 (parent not found), 401, 403 |
| 91 | POST | `/api/admin/catalog/duplicate` | `require_role("admin")` | Body: `schemas.CatalogDuplicateIn` (`type: "section"\|"university"\|"stage"\|"subject"`, `id`, `new_name?`, `new_names?`, `target_parent_id?`) | `{"copies": list[{"id", "name"}], "skipped": list, "universities", "stages", "subjects"}` (200) | 400 (invalid type, missing name, all skipped), 404 (node or target_parent not found), 401, 403 |
| 92 | POST | `/api/admin/catalog/import` | `require_role("admin")` | Body: `schemas.CatalogImportIn` (`text: str`, `preview: bool = False`) | `{"preview", "created": {...}, "reused": {...}, "total_created", "problems": list}` (200) | 400 (>4000 lines or empty text), 401, 403 |
| 93 | PUT | `/api/admin/catalog/sections/{section_id}` | `require_role("admin")` | Path: `section_id: str`, Query: `name: str` | `{"ok": true}` (200) | 404 (section not found), 401, 403 |
| 94 | DELETE | `/api/admin/catalog/sections/{section_id}` | `require_role("admin")` | Path: `section_id: str` | `{"ok": true}` (200) | 400 (blocked: has universities or users registered), 404, 401, 403 |
| 95 | PUT | `/api/admin/catalog/universities/{university_id}` | `require_role("admin")` | Path: `university_id: str`, Query: `name: str` | `{"ok": true}` (200) | 404 (university not found), 401, 403 |
| 96 | DELETE | `/api/admin/catalog/universities/{university_id}` | `require_role("admin")` | Path: `university_id: str` | `{"ok": true}` (200) | 400 (blocked: has stages or users registered), 404, 401, 403 |
| 97 | PUT | `/api/admin/catalog/stages/{stage_id}` | `require_role("admin")` | Path: `stage_id: str`, Query: `name: str` | `{"ok": true}` (200) | 404 (stage not found), 401, 403 |
| 98 | DELETE | `/api/admin/catalog/stages/{stage_id}` | `require_role("admin")` | Path: `stage_id: str` | `{"ok": true}` (200) | 400 (blocked: has subjects or users registered), 404, 401, 403 |
| 99 | PUT | `/api/admin/catalog/subjects/{subject_id}` | `require_role("admin")` | Path: `subject_id: str`, Query: `name: str` | `{"ok": true}` (200) | 404 (subject not found), 401, 403 |
| 100 | DELETE | `/api/admin/catalog/subjects/{subject_id}` | `require_role("admin")` | Path: `subject_id: str` | `{"ok": true}` (200) | 400 (blocked: questions, prof profiles, courses, exams, activation codes, or products linked), 404, 401, 403 |
| 101 | GET | `/api/admin/questions` | `require_role("admin")` | Query: `subject_id: str` | `list[schemas.QuestionAdminOut]` (includes correct answer flags) (200) | 401, 403 |
| 102 | POST | `/api/admin/questions` | `require_role("admin")` | Body: `schemas.QuestionAdminIn` (`subject_id`, `text`, `eyebrow?`, `rationale?`, `image_url?`, `choices: list[ChoiceIn(text, is_correct)]`) | `schemas.QuestionAdminOut` (200) | 400 (<2 choices or no correct choice), 404 (subject not found), 401, 403 |
| 103 | PUT | `/api/admin/questions/{question_id}` | `require_role("admin")` | Path: `question_id: str`, Body: `schemas.QuestionAdminIn` | `schemas.QuestionAdminOut` (200) | 400 (<2 choices or no correct choice), 404 (question or subject not found), 401, 403 |
| 104 | DELETE | `/api/admin/questions/{question_id}` | `require_role("admin")` | Path: `question_id: str` | `{"ok": true}` (200) | 404 (question not found), 401, 403 |
| 105 | GET | `/api/admin/weak-topics` | `require_role("admin")` | Query: `limit: int = Query(5, ge=1, le=50)` | `list[{"topic", "weakness_pct", "sample_size"}]` (200) | 401, 403 |
| 106 | GET | `/api/admin/students` | `require_role("admin")` | None | `list[{"id", "name", "email", "university", "stage", "is_banned", "avg_score", "answered_count"}]` (200) | 401, 403 |
| 107 | GET | `/api/admin/media` | `require_role("admin")` | None | `list[{"id", "filename", "url", "content_type", "size_bytes", "created_at"}]` (200) | 401, 403 |
| 108 | POST | `/api/admin/media` | `require_role("admin")` | Query: `filename: str`, `url: str`, `content_type: str = ""`, `size_bytes: int = 0` | `{"id": str}` (200) | 401, 403 |
| 109 | POST | `/api/admin/media/upload` | `require_role("admin")` | Form: `file: UploadFile = File(...)` | `{"id": str, "url": str}` (200) | 400 (>20MB or bad ext not in IMAGE\|DOC\|VIDEO), 401, 403 |
| 110 | GET | `/api/admin/store/products` | `require_role("admin")` | None | `list[schemas.ProductAdminOut]` (`id`, `name`, `price`, `type`, `is_activation_code`, `grants_subject_id`) (200) | 401, 403 |
| 111 | POST | `/api/admin/store/products` | `require_role("admin")` | Body: `schemas.ProductIn` (`name`, `price`, `type: "digital"\|"physical"\|"course"`, `is_activation_code = False`, `grants_subject_id?`) | `schemas.ProductAdminOut` (200) | 400 (invalid type), 404 (subject not found), 401, 403 |
| 112 | PUT | `/api/admin/store/products/{product_id}` | `require_role("admin")` | Path: `product_id: str`, Body: `schemas.ProductIn` | `schemas.ProductAdminOut` (200) | 400 (invalid type), 404 (product or subject not found), 401, 403 |
| 113 | DELETE | `/api/admin/store/products/{product_id}` | `require_role("admin")` | Path: `product_id: str` | `{"ok": true}` (200) | 400 (blocked: product has existing orders), 404, 401, 403 |
| 114 | GET | `/api/admin/store/orders` | `require_role("admin")` | None | `list[schemas.OrderAdminOut]` (`id`, `buyer_name`, `buyer_email`, `total`, `status`, `payment_method`, `created_at`, `delivery_name`, `delivery_phone`, `delivery_address`, `items: list[OrderAdminItemOut]`) (200) | 401, 403 |
| 115 | PUT | `/api/admin/store/orders/{order_id}/status` | `require_role("admin")` | Path: `order_id: str`, Query: `status: str` ("pending"\|"paid"\|"fulfilled"\|"cancelled") | `{"ok": true, "granted_activation_codes": list[str]}` (200) | 400 (invalid status), 404 (order not found), 401, 403 |
| 116 | GET | `/api/admin/notifications` | `require_role("admin")` | None | `list[{"id", "title", "body", "created_at", "user_id", "broadcast": bool}]` (max 50) (200) | 401, 403 |
| 117 | POST | `/api/admin/notifications` | `require_role("admin")` | Body: `schemas.NotificationCreateIn` (`title: str`, `body: str = ""`, `user_id: str \| None = None`) | `{"id", "title", "body", "created_at"}` (200) | 404 (target user not found), 401, 403 |
| 118 | GET | `/api/admin/pearls` | `require_role("admin")` | None | `list[schemas.ClinicalPearlOut]` (`id`, `tag`, `title`, `body`) (200) | 401, 403 |
| 119 | POST | `/api/admin/pearls` | `require_role("admin")` | Body: `schemas.ClinicalPearlIn` (`title: str`, `tag: str = ""`, `body: str = ""`) | `schemas.ClinicalPearlOut` (200) | 400 (title required), 401, 403 |
| 120 | PUT | `/api/admin/pearls/{pearl_id}` | `require_role("admin")` | Path: `pearl_id: str`, Body: `schemas.ClinicalPearlIn` | `schemas.ClinicalPearlOut` (200) | 400 (title required), 404 (pearl not found), 401, 403 |
| 121 | DELETE | `/api/admin/pearls/{pearl_id}` | `require_role("admin")` | Path: `pearl_id: str` | `{"ok": true}` (200) | 404 (pearl not found), 401, 403 |

---

### Group 9: Import & Export Routes (`app/routers/import_export.py`)
**Prefix**: `/api/admin` | **Tag**: `import-export` | **All routes protected by**: `require_role("admin")`

| # | Method | Path | Auth / Guard | Request Params / Body | Success Response | Error Codes |
|---|---|---|---|---|---|---|
| 122 | GET | `/api/admin/import/template/students` | `require_role("admin")` | None | StreamingResponse (.xlsx attachment: `قالب طلاب.xlsx`) | 401, 403 |
| 123 | GET | `/api/admin/import/template/questions` | `require_role("admin")` | None | StreamingResponse (.xlsx attachment: `قالب أسئلة.xlsx`) | 401, 403 |
| 124 | GET | `/api/admin/export` | `require_role("admin")` | Query: `datasets: str` (comma-separated subset of `students,questions,orders,logs`) | StreamingResponse (.xlsx attachment: `نبض-تصدير.xlsx`) | 401, 403 |
| 125 | POST | `/api/admin/import` | `require_role("admin")` | Form: `file: UploadFile = File(...)` | `{"kind": "students"\|"questions", "created": int, "skipped"?: int, "errors": list[str]}` (200) | 400 (unknown format), 401, 403 |

---

### Group 10: Reseller Routes (`app/routers/reseller.py`)
**Prefix**: `/api/reseller` | **Tag**: `reseller`

| # | Method | Path | Auth / Guard | Request Params / Body | Success Response | Error Codes |
|---|---|---|---|---|---|---|
| 126 | GET | `/api/reseller/summary` | `get_current_user` + role=reseller | None | `{"available": int, "sold": int, "activated": int, "weekly_sales": list[{"date", "count"}]}` (200) | 403 (not reseller), 401 |
| 127 | GET | `/api/reseller/codes` | `get_current_user` + role=reseller | None | `list[{"id", "code", "status", "subject_name", "sold_at"}]` (200) | 403 (not reseller), 401 |
| 128 | POST | `/api/reseller/codes` | `get_current_user` + role=reseller | Query: `count: int = 1`, `subject_id: str \| None = None` | `{"codes": list[str]}` (200) | 400 (count not 1-100), 403 (not reseller), 404 (subject not found), 401 |

---

### Group 11: Activation Code Redemption Routes (`app/routers/activation.py`)
**Prefix**: `/api/activation` | **Tag**: `activation`

| # | Method | Path | Auth / Guard | Request Params / Body | Success Response | Error Codes |
|---|---|---|---|---|---|---|
| 129 | POST | `/api/activation/redeem` | `get_current_user` | Body: `schemas.RedeemCodeIn` (`code: str`) | `schemas.ActivationOut` (`id`, `code_masked`, `subject_name`, `activated_at`, `expires_at`) (200) | 400 (expired or already active), 404 (not found), 429 (lockout 15m), 401, 403 |
| 130 | GET | `/api/activation/mine` | `get_current_user` | None | `list[schemas.ActivationOut]` (200) | 401, 403 |

---

### Group 12: Ban & Appeal Routes (`app/routers/bans.py`)
**Prefix**: `/api/bans` | **Tag**: `bans`

| # | Method | Path | Auth / Guard | Request Params / Body | Success Response | Error Codes |
|---|---|---|---|---|---|---|
| 131 | GET | `/api/bans/mine` | `get_current_user_allow_banned` | None | `schemas.BanStatusOut` (`is_banned: bool`, `reason?`, `status?`, `appeal_message?`, `appealed_at?`) (200) | 401 |
| 132 | POST | `/api/bans/appeal` | `get_current_user_allow_banned` | Body: `schemas.AppealIn` (`message: str`) | `{"ok": true}` (200) | 400 (not banned, empty message), 404 (no active ban record), 401 |

---

### Group 13: Exam Engine Routes (`app/routers/exams.py`)
**Prefix**: `/api/exams` | **Tag**: `exams`

| # | Method | Path | Auth / Guard | Request Params / Body | Success Response | Error Codes |
|---|---|---|---|---|---|---|
| 133 | POST | `/api/exams/{exam_id}/start` | `get_current_user` | Path: `exam_id: str` | `{"attempt_id", "exam_title", "expires_at", "duration_minutes", "total", "started_at", "finished_at", "questions": list}` (200) | 400 (no questions in subject pool), 404 (exam not found), 401, 403 |
| 134 | POST | `/api/exams/attempts/{attempt_id}/items/{item_id}/answer` | `get_current_user` | Path: `attempt_id: str`, `item_id: str`, Body: `schemas.ExamAttemptAnswerIn` (`choice_id: str`) | `{"ok": true}` (200) | 400 (exam expired or invalid choice), 404 (attempt or item not found), 401, 403 |
| 135 | POST | `/api/exams/attempts/{attempt_id}/finish` | `get_current_user` | Path: `attempt_id: str` | `{"attempt_id", "score", "total", "finished_at"}` (200) | 404 (attempt not found), 401, 403 |
| 136 | GET | `/api/exams/attempts/{attempt_id}/result` | `get_current_user` | Path: `attempt_id: str` | `{"attempt_id", "score", "total", "finished_at", "items": list[{"item_id", "question_id", "text", "choices", "is_correct", "correct_choice_id", "rationale", ...}]}` (200) | 404 (attempt not found), 401, 403 |

---

### Group 14: Notifications Routes (`app/routers/notifications.py`)
**Prefix**: `/api/me/notifications` | **Tag**: `notifications`

| # | Method | Path | Auth / Guard | Request Params / Body | Success Response | Error Codes |
|---|---|---|---|---|---|---|
| 137 | GET | `/api/me/notifications` | `get_current_user` | Query: `limit: int = Query(30, ge=1, le=100)` | `list[{"id", "title", "body", "created_at", "read": bool}]` (200) | 401, 403 |
| 138 | GET | `/api/me/notifications/unread-count` | `get_current_user` | None | `{"count": int}` (200) | 401, 403 |
| 139 | POST | `/api/me/notifications/{notification_id}/read` | `get_current_user` | Path: `notification_id: str` | `{"ok": true}` (200) | 401, 403 |

---

### Group 15: Student Directory & Profiles (`app/routers/students.py`)
**Prefix**: `/api/students` | **Tag**: `students`

| # | Method | Path | Auth / Guard | Request Params / Body | Success Response | Error Codes |
|---|---|---|---|---|---|---|
| 140 | GET | `/api/students/search` | `get_current_user` | Query: `q: str = ""`, `limit: int = Query(20, ge=1, le=50)` | `list[{"id", "full_name", "photo_url", "caption"}]` (200) | 401, 403 |
| 141 | GET | `/api/students/{student_id}/profile` | `get_current_user` | Path: `student_id: str` | `{"id", "full_name", "caption", "photo_url", "skills": list[str], "rank", "total_ranked", "streak_days", "correct_count"}` (200) | 404 (student not found or role != student), 401, 403 |

---

### Group 16: Clinical Pearls Routes (`app/routers/pearls.py`)
**Prefix**: `/api/pearls` | **Tag**: `clinical-pearls`

| # | Method | Path | Auth / Guard | Request Params / Body | Success Response | Error Codes |
|---|---|---|---|---|---|---|
| 142 | GET | `/api/pearls/preview` | None (Public) | Query: `limit: int = Query(3, ge=1, le=12)` | `list[schemas.ClinicalPearlPreviewOut]` (`id`, `tag`, `title` — strictly NO `body` field) (200) | - |
| 143 | GET | `/api/pearls` | `get_current_user` | None | `list[schemas.ClinicalPearlOut]` (`id`, `tag`, `title`, `body`) (200) | 401, 403 |
| 144 | GET | `/api/pearls/{pearl_id}` | `get_current_user` | Path: `pearl_id: str` | `schemas.ClinicalPearlOut` (200) | 404 (not found), 401, 403 |

---

### Group 17: Public Platform Statistics (`app/routers/public.py`)
**Prefix**: `/api/public` | **Tag**: `public`

| # | Method | Path | Auth / Guard | Request Params / Body | Success Response | Error Codes |
|---|---|---|---|---|---|---|
| 145 | GET | `/api/public/stats` | None (Public) | None | `{"questions": int, "professors": int, "lectures": int, "pearls": int}` (200) | - |

---

## 4. Caveats

1. **OAuth Redirect Flow on Cloudflare Workers**:
   - The original implementation uses Starlette's `SessionMiddleware` + `authlib.integrations.starlette_client.OAuth` to store the OAuth `state`/`nonce` in an encrypted session cookie.
   - In Hono/TypeScript for Cloudflare Workers, standard cookie-based OAuth state storage (e.g. `setCookie(c, 'oauth_state', state, ...)` or using standard web crypto OAuth libraries like `arctic`) must be used to replace Starlette's Python session middleware.
2. **Streaming and Multipart File Parsing on Cloudflare Workers**:
   - Cloudflare Workers handle `multipart/form-data` natively via standard Web API `request.formData()`.
   - File uploads in Python used `openpyxl` for Excel reading/writing (`.xlsx`). In the TypeScript rewrite on Cloudflare Workers, a lightweight pure-JS Excel library (such as `xlsx` / SheetJS or `exceljs`) that runs in V8 isolate without Node native bindings will be required.
3. **Database Layer & Timezone Semantics**:
   - The Python code relies heavily on `datetime.utcnow()` and SQLite `func.date()`.
   - SQLite date expressions in D1 should format UTC timestamps as ISO8601 strings (`YYYY-MM-DD HH:MM:SS` or `YYYY-MM-DDTHH:MM:SSZ`), and date math in `ranking.py` must preserve streak logic across day boundaries.

---

## 5. Conclusion

1. The existing backend is a well-structured, fully documented FastAPI application comprising **145 endpoints** across 16 sub-routers plus the root app.
2. All 145 endpoints have been cataloged with exact HTTP methods, paths, authorization dependencies, query/path parameters, request bodies (Pydantic models), success responses, and error codes.
3. Authentication relies on standard PBKDF2-HMAC-SHA256 (200,000 iterations), standard RFC 6238 TOTP, and HS256 JWT tokens, alongside a strict single-active-session policy backed by the `user_sessions` table.
4. The client SPAs interact with the API via a centralized `apiFetch` wrapper sending credentials and Bearer tokens, expecting standard `{ "detail": "..." }` JSON errors.
5. With this complete route and schema map, the TypeScript/Hono implementation team can rewrite each endpoint with 100% feature and interface parity.

---

## 6. Verification Method

To independently verify the endpoint inventory and application topology:
1. Run static analysis or inspect router registrations in `app/main.py`:
   - Inspect lines 44-59 of `app/main.py` to verify the 16 router inclusions.
   - Inspect lines 61-86, 144-147, 160-168 of `app/main.py` for root endpoints.
2. Verify all endpoint signatures in each router file under `app/routers/` against the catalog table above.
3. Verify authentication mechanics in `app/security.py` (lines 19-35 for PBKDF2, lines 36-43 for JWT, lines 117-156 for TOTP, lines 157-170 for sessions).
4. Verify SPA fetch contracts in `nabd-home-quiz-prototype.html` (lines 2625-2715) and `nabd-admin-dashboard.html` (lines 920-950).
