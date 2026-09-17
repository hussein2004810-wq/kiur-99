# KIUR-99 Authorization Matrix

**Specification:** KIUR99-SEC-2026-09  
**Principles:** Deny by default, server-side authority, strict ownership enforcement.

---

## 1. Matrix Overview

| Route Pattern | Method | Allowed Roles | Ownership / Scoping Rule | Unauthorized Response |
| :--- | :--- | :--- | :--- | :--- |
| `/health` | GET | Anonymous / Public | None | N/A |
| `/` | GET | Anonymous / Public | None | N/A |
| `/admin` | GET | Anonymous / Public | None | N/A |
| `/auth/register` | POST | Anonymous / Public | None | 400/403/429 |
| `/auth/login` | POST | Anonymous / Public | None | 401/403/429 |
| `/auth/google/*` | GET | Anonymous / Public | None | 400/502 |
| `/auth/2fa/verify` | POST | Anonymous / Public | Valid pending token | 401/429 |
| `/auth/session/restore` | POST | Anonymous / Public | Valid session cookie in DB | 401 |
| `/auth/forgot-password`| POST | Anonymous / Public | None | 429 |
| `/auth/reset-password` | POST | Anonymous / Public | Valid single-use token hash | 400/403 |
| `/auth/logout` | POST | Authenticated (Any) | Active session owner (`session.id`) | 401 |
| `/auth/me` | GET | Authenticated (Any) | Current user identity (`c.var.user.id`) | 401/403 |
| `/auth/me/profile` | PUT | Authenticated (Any) | Self only (`user.id === c.var.user.id`). No role editing. | 401/403 |
| `/auth/me/caption` | PUT | Authenticated (Any) | Self only | 401/403 |
| `/auth/me/preferences`| PUT | Authenticated (Any) | Self only | 401/403 |
| `/auth/me/photo` | POST | Authenticated (Any) | Self only | 401/403 |
| `/auth/me/skills` | POST | Authenticated (Any) | Self only | 401/403 |
| `/auth/me/skills/:id` | DELETE | Authenticated (Any) | Must own skill record (`skill.user_id === user.id`) | 404 |
| `/auth/me/recent-view` | POST | Authenticated (Any) | Self only | 401/403 |
| `/auth/me/continue-card`| GET | Authenticated (Any) | Self only | 401/403 |
| `/auth/me/stats` | GET | Authenticated (Any) | Self only | 401/403 |
| `/auth/me/daily` | GET | Authenticated (Any) | Self only | 401/403 |
| `/auth/me/performance` | GET | Authenticated (Any) | Self only | 401/403 |
| `/auth/me/leaderboard` | GET | Authenticated (Any) | Peered within same university/stage | 401/403 |
| `/auth/me/history` | GET | Authenticated (Any) | Self only | 401/403 |
| `/auth/me/sessions` | GET | Authenticated (Any) | Self only (`userSessions.user_id === user.id`) | 401/403 |
| `/auth/change-password`| POST | Authenticated (Any) | Self only (verifies current password hash) | 401/403 |
| `/auth/2fa/setup` | POST | Authenticated (Any) | Self only | 401/403 |
| `/auth/2fa/enable` | POST | Authenticated (Any) | Self only | 401/403 |
| `/auth/2fa/disable` | POST | Authenticated (Any) | Self only | 401/403 |
| `/api/catalog/tree` | GET | Anonymous / Public | None (Read-only curriculum tree) | N/A |
| `/api/public/stats` | GET | Anonymous / Public | None (Aggregate counts only) | N/A |
| `/api/pearls/preview` | GET | Anonymous / Public | None (3 teaser pearls max) | N/A |
| `/api/pearls` | GET | Authenticated (Any) | Enrolled students | 401/403 |
| `/api/pearls/:id` | GET | Authenticated (Any) | Enrolled students | 401/404 |
| `/api/questions/subject/:id` | GET | Authenticated (Any) | None (Subject questions pool) | 401/403 |
| `/api/questions/:id/answer` | POST | Authenticated (Any) | Records caller answer (`user_id = user.id`) | 401/403 |
| `/api/questions/:id/save` | POST / DELETE | Authenticated (Any) | Caller bookmark only | 401/403 |
| `/api/questions/saved/mine` | GET | Authenticated (Any) | Caller bookmarks only | 401/403 |
| `/api/questions/mistakes/mine` | GET | Authenticated (Any) | Caller mistake records only | 401/403 |
| `/api/exams/:id/start` | POST | Authenticated (Any) | Creates attempt bound to caller | 401/404 |
| `/api/exams/attempts/:aid/items/:iid/answer` | POST | Authenticated (Any) | Attempt must belong to caller (`attempt.user_id === user.id`) | 404 |
| `/api/exams/attempts/:aid/finish` | POST | Authenticated (Any) | Attempt must belong to caller (`attempt.user_id === user.id`) | 404 |
| `/api/exams/attempts/:aid/result` | GET | Authenticated (Any) | Attempt must belong to caller (`attempt.user_id === user.id`) | 404 |
| `/api/courses` | GET | Authenticated (Any) | Listed courses | 401/403 |
| `/api/courses/:id` | GET | Authenticated (Any) | Listed courses | 401/404 |
| `/api/courses/:id/materials` | GET | Authenticated (Any) | Listed courses | 401/404 |
| `/api/courses/lectures/:id/complete` | POST | Authenticated (Any) | Progress recorded for caller only | 401/404 |
| `/api/notifications` | GET | Authenticated (Any) | Caller notifications only | 401/403 |
| `/api/notifications/:id/read` | POST | Authenticated (Any) | Caller notification only | 401/404 |
| `/api/notifications/read-all` | POST | Authenticated (Any) | Caller notifications only | 401/403 |
| `/api/bans/mine` | GET | Authenticated (Any) | Caller ban record only | 401/403 |
| `/api/bans/appeal` | POST | Authenticated (Any) | Caller ban appeal only | 401/403 |
| `/api/activation/redeem` | POST | Authenticated (Any) | Caller code redemption | 401/400 |
| `/api/activation/mine` | GET | Authenticated (Any) | Caller redeemed codes only | 401/403 |
| `/api/students` | GET | Authenticated (Any) | Public search directory | 401/403 |
| `/api/students/:id/profile` | GET | Authenticated (Any) | Public student view | 401/404 |
| `/api/store/products` | GET | Authenticated (Any) | Store inventory | 401/403 |
| `/api/store/orders` | POST | Authenticated (Any) | Creates order bound to caller | 401/400 |
| `/api/store/orders/mine` | GET | Authenticated (Any) | Caller orders only (`orders.user_id === user.id`) | 401/403 |
| `/api/professors/*` | ALL | Professor, Admin | Professor operations; must match assigned subject | 401/403/404 |
| `/api/reseller/*` | ALL | Reseller, Admin | Reseller voucher allocation | 401/403 |
| `/api/admin/*` | ALL | Admin | Full platform administration | 401/403 |

---

## 2. Invariant Rules
1. **No Client Role Promotion:** The `role` column cannot be changed via `/me/profile` or any client update endpoint.
2. **Strict IDOR Resistance:** If User A attempts to read or mutate User B's exam attempt or order, the server returns 404 (does not disclose existence).
3. **Privilege Boundary:** Professor and Reseller roles cannot access `/api/admin/*` routes.

