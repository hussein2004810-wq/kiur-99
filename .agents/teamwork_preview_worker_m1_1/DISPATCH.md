# Task Assignment: M1 Implementation Worker - Foundation & Database Layer

## Original Request Reference
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md`
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\PROJECT.md`
Read Explorer Findings:
- Tooling Blueprint: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m1_1\handoff.md`
- Schema Blueprint: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m1_2\handoff.md`
- Middleware & Serving Blueprint: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m1_3\handoff.md`

## Your Identity & Workspace
- Type: teamwork_preview_worker
- Working Directory: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_worker_m1_1`
- Parent: Orchestrator (`fdf0f062-12fc-46d6-8dd0-3c6786653821`)

## Mandatory Integrity Warning
> DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Exclusive File Ownership
You exclusively own and are responsible for creating/modifying:
- `package.json`
- `tsconfig.json`
- `wrangler.toml`
- `drizzle.config.ts`
- `vitest.config.ts`
- `.dev.vars.example`
- `.gitignore`
- `src/types.ts`
- `src/config.ts`
- `src/index.ts`
- `src/db/schema.ts`
- `src/db/index.ts`
- `src/middleware/error.ts`
- `src/middleware/cors.ts`
- `src/routes/static.ts`
- `src/html.d.ts`
- `migrations/0000_initial_schema.sql`
- `public/nabd-home-quiz-prototype.html`
- `public/nabd-admin-dashboard.html`
- `test/tier1-features/middleware.test.ts`

## Implementation Instructions
1. **Scaffold Project Configs**:
   - Write `package.json` with dependencies and scripts (`build`, `dev`, `test`, `typecheck`, `db:generate`) using the verified versions from Explorer 1.
   - Write `wrangler.toml` configured for Cloudflare Workers with D1 binding `DB` (`binding = "DB"`, `database_name = "nabd-db"`, `database_id = "local-d1"`), R2 bucket binding `R2_BUCKET` (`binding = "R2_BUCKET"`, `bucket_name = "nabd-media"`), and `[vars]`.
   - Write `tsconfig.json`, `drizzle.config.ts`, `vitest.config.ts`, `.dev.vars.example`, `.gitignore`.
2. **Implement Database Layer**:
   - Write `src/db/schema.ts` containing all 30 tables and 5 enums in topological order with complete types, foreign keys, cascades, indexes, and relations (copy from Explorer 2's `proposed_schema.ts`).
   - Write `src/db/index.ts` (copy from Explorer 2's `proposed_db_index.ts`).
   - Write `migrations/0000_initial_schema.sql` (copy from Explorer 2's `proposed_0000_initial_schema.sql`).
3. **Implement Types, Config & Middleware**:
   - Write `src/types.ts` with `AppBindings`, `AppVariables`, `AppEnv`, `CurrentUser`, `CurrentSession`.
   - Write `src/config.ts` with environment defaults and constants.
   - Write `src/middleware/error.ts` enforcing `{ "detail": string }` format and CORS error headers.
   - Write `src/middleware/cors.ts` supporting credentials and Range headers.
   - Write `src/html.d.ts` and `src/routes/static.ts` serving `public/nabd-home-quiz-prototype.html` at `GET /` and `public/nabd-admin-dashboard.html` at `GET /admin` with `Cache-Control: no-cache`. Copy the HTML files into `public/`.
   - Write `src/index.ts` setting up the Hono app, registering error handlers, CORS, static routes, and a healthcheck route `GET /health` (`{ status: "ok" }`).
4. **Verification Commands**:
   - Install dependencies: `npm.cmd install`
   - Run typecheck: `npm.cmd run typecheck` or `npx.cmd tsc --noEmit`
   - Apply D1 schema: `npx.cmd wrangler d1 execute DB --local --file=./migrations/0000_initial_schema.sql`
   - Run tests: `npx.cmd vitest run test/tier1-features/middleware.test.ts`
   - Check local dev dry-run: `npx.cmd wrangler dev --dry-run`

## Completion Criteria
Document all commands and verbatim results in `handoff.md`.
Update `progress.md` with heartbeat.
Notify orchestrator when complete.

## 2026-09-17T00:29:42Z
Received dispatch request:
You are Worker M1 (Foundation & Database Layer Implementer) for the backend rewrite project.
Your working directory is: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_worker_m1_1
Read your dispatch details in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_worker_m1_1\DISPATCH.md
Read the authoritative user request in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md
Read the master architecture in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\PROJECT.md

