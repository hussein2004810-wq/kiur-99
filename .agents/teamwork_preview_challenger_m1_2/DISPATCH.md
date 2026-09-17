# Task Assignment: M1 Challenger 2 - Empirical Middleware, Error & Edge-Case Stress-Testing

## Original Request Reference
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md`
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\PROJECT.md`

## Your Identity & Workspace
- Type: teamwork_preview_challenger
- Working Directory: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_challenger_m1_2`
- Parent: Orchestrator (`fdf0f062-12fc-46d6-8dd0-3c6786653821`)

## Objective
Adversarially probe and stress-test the Hono application entrypoint (`src/index.ts`) and middleware (`src/middleware/error.ts`, `src/middleware/cors.ts`, `src/routes/static.ts`):
1. Write and execute an adversarial test script in your working directory (e.g. `test_edge_cases.mjs` or vitest suite).
2. Stress tests:
   - Malformed JSON payloads to trigger body-parsing exceptions.
   - Non-existent routes to test 404 handler.
   - Custom simulated exceptions (HTTPException, ZodError, Error).
   - Verify that 100% of error responses have `{ "detail": string | object }` and never leak internal stack traces or produce HTML error pages.
   - Test CORS behavior: OPTIONS preflight with allowed vs disallowed origins; verify `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials: true`, and exposed headers.
   - Test static routes `GET /` and `GET /admin`: verify exact headers `Cache-Control: no-cache` and status 200 with HTML bodies.
3. Formulate your findings and report your verdict: **CONFIRM_CORRECTNESS** or **REJECT**.

Write your handoff report to:
`c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_challenger_m1_2\handoff.md`
Maintain your heartbeat in `progress.md`. Notify orchestrator when complete.

## 2026-09-17T00:42:08Z
You are Challenger 2 (Empirical Middleware & Edge-Case Stress-Tester) for Milestone 1.
Your working directory is: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_challenger_m1_2
Read your dispatch assignment in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_challenger_m1_2\DISPATCH.md
Read the authoritative user request in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md
Read PROJECT.md in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\PROJECT.md

Your task:
1. Adversarially stress-test Hono app entrypoint and middleware in src/index.ts, src/middleware/error.ts, and src/middleware/cors.ts.
2. Probe with malformed JSON, 404 routes, CORS headers, error response format, and static SPA serving.
3. Issue an explicit verdict: CONFIRM_CORRECTNESS or REJECT.
4. Write your full handoff report to: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_challenger_m1_2\handoff.md.

Maintain your heartbeat in progress.md. When complete, message parent (fdf0f062-12fc-46d6-8dd0-3c6786653821).

