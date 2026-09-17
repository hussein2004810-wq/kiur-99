# Task Assignment: M2 Explorer 3 - Auth Endpoints & Account Management

## Original Request Reference
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md`
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\PROJECT.md`
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_survey_1\handoff.md`
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_spec_miner_survey_3\handoff.md`

## Your Identity & Workspace
- Type: teamwork_preview_explorer
- Working Directory: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m2_3`
- Parent: Orchestrator (`fdf0f062-12fc-46d6-8dd0-3c6786653821`)

## Objective
Formulate the exact endpoint schemas, handlers, and integration for all `/auth/*` routes in Hono (`src/routes/auth.ts`):
1. **Account Lifecycle Endpoints**:
   - `POST /auth/register`: validates body (email, password, full_name, role, university_id, stage_id, section_id), creates user, starts session, issues JWT + cookie.
   - `POST /auth/login`: checks lockout (`locked_until`), verifies password hash, checks 2FA (`totp_enabled` -> returns temporary 2fa pending token), starts new session (deactivating old sessions), resets failed attempts, returns access token + user + sets cookie.
   - `POST /auth/session/restore`: reads `nabd_session` cookie, verifies active session, returns fresh token + user.
   - `POST /auth/logout`: deactivates current session in DB, clears cookie (`Max-Age=0`).
   - `GET /auth/me`: returns current user object.
   - `PATCH /auth/me`: updates profile fields (full_name, phone, university_id, stage_id, section_id, theme, language).
   - `POST /auth/change-password`: verifies old password, updates hash, increments password_changed_at, terminates other sessions.
2. **Password Recovery & 2FA**:
   - `POST /auth/forgot-password`: generates raw token, hashes with SHA-256, stores in `reset_token_hash` with 60 min expiry, dispatches email in background via `c.executionCtx.waitUntil()`.
   - `POST /auth/reset-password`: validates token hash and expiry, updates password hash, clears reset token.
   - `POST /auth/2fa/setup`: generates TOTP secret, returns base32 secret and QR uri.
   - `POST /auth/2fa/verify`: verifies code, enables TOTP.
   - `POST /auth/2fa/disable`: verifies code, disables TOTP.
   - `POST /auth/2fa/login`: receives pending token and 6-digit code, verifies TOTP, starts session, returns full JWT access token.
3. **Google OAuth & Media Upload**:
   - `GET /auth/google/login`: redirects to Google OAuth endpoint.
   - `GET /auth/google/callback`: validates code, checks email against `allowed_university_domains`, auto-creates user if new, redirects to frontend with URL hash fragments (`#access_token=...` or `#requires_2fa=1...`).
   - `POST /auth/me/photo`: uploads profile photo to Cloudflare R2 bucket (`env.R2_BUCKET.put()`), deletes old photo if exists, stores `/media-files/<name>` reference in `user.photo_url`.

Write your detailed blueprint and route handlers to:
`c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m2_3\handoff.md`
Update your heartbeat in `progress.md`. Notify orchestrator when complete.

## 2026-09-17T00:53:42Z
You are M2 Explorer 3 (Auth Endpoints & Account Management) for Milestone 2: Auth, Sessions & Security.
Your working directory is: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m2_3
Read your dispatch assignment in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m2_3\DISPATCH.md
Read the authoritative user request in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md
Read PROJECT.md in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\PROJECT.md

Your task:
1. Formulate complete schemas and handlers for all /auth/* routes (register, login, session restore, logout, me, change-password, forgot-password, reset-password, 2fa, google oauth, profile photo upload).
2. Ensure status codes and response bodies match original FastAPI backend exactly.
3. Write your complete blueprint and route code to: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m2_3\handoff.md.

Maintain your heartbeat in progress.md. When complete, message parent (fdf0f062-12fc-46d6-8dd0-3c6786653821).
