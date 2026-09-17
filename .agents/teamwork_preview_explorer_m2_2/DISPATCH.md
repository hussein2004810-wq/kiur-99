# Task Assignment: M2 Explorer 2 - Session Management, Anti-Piracy & Auth Middleware

## Original Request Reference
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md`
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\PROJECT.md`
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_survey_1\handoff.md`

## Your Identity & Workspace
- Type: teamwork_preview_explorer
- Working Directory: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m2_2`
- Parent: Orchestrator (`fdf0f062-12fc-46d6-8dd0-3c6786653821`)

## Objective
Formulate the exact session management, anti-piracy validation, cookie management, and auth middlewares:
1. **Single-Active-Session Anti-Piracy (`app/security.py` & `app/routers/auth.py`)**:
   - `start_new_session(db, user_id, device_label)`: marks all existing sessions for user as `is_active = false`, generates new 12-char hex session id, inserts new active `user_sessions` record.
   - On every authenticated request: verify token `sid` against `user_sessions`. If `session.is_active == false`, immediately return 401 with detail `"تم تسجيل الدخول من جهاز آخر"`.
   - On user ban check: if `user.is_banned == true`, return 403 with detail `"الحساب محظور"`.
2. **Session Cookie (`nabd_session`)**:
   - Helper to set session cookie on login/restore: `nabd_session=<jwt>; Path=/auth/session; HttpOnly; SameSite=Lax; Max-Age=1209600; Secure=(not debug)`.
   - Helper to clear session cookie on logout: `Max-Age=0`.
3. **Auth Middlewares (`src/middleware/auth.ts`)**:
   - `requireAuth`: extracts Bearer token, verifies JWT, checks session in D1 DB, checks user ban status, sets `c.set('user', user)` and `c.set('session', session)`.
   - `requireRole(...roles)`: asserts `user.role` is in allowed roles (admin, professor, reseller, student), returns 403 with detail `"غير مصرح"` if not authorized.
   - `requireAdmin`: shortcut for `requireRole('admin')`.
   - `requireProfessor`: shortcut for `requireRole('professor', 'admin')`.
   - `requireReseller`: shortcut for `requireRole('reseller', 'admin')`.

Write your detailed blueprint to:
`c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m2_2\handoff.md`
Update your heartbeat in `progress.md`. Notify orchestrator when complete.

## 2026-09-17T00:53:42Z
You are M2 Explorer 2 (Session Management, Anti-Piracy & Auth Middleware) for Milestone 2: Auth, Sessions & Security.
Your working directory is: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m2_2
Read your dispatch assignment in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m2_2\DISPATCH.md
Read the authoritative user request in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md
Read PROJECT.md in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\PROJECT.md

Your task:
1. Formulate single-active-session anti-piracy lifecycle (start_new_session, deactivating old sessions, checking active state in user_sessions on every authenticated request).
2. Formulate session cookie management for nabd_session at Path=/auth/session.
3. Formulate auth middleware (requireAuth, requireRole, requireAdmin, requireProfessor, requireReseller) with ban verification.
4. Write your complete blueprint and middleware code to: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m2_2\handoff.md.

Maintain your heartbeat in progress.md. When complete, message parent (fdf0f062-12fc-46d6-8dd0-3c6786653821).

