# Task Assignment: E2E Test Infrastructure & Test Suite Creation (Dual Track)

## Original Request Reference
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md`
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\PROJECT.md`
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\TEST_INFRA.md`

## Your Identity & Workspace
- Type: teamwork_preview_test_writer
- Working Directory: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_test_writer_e2e_1`
- Parent: Orchestrator (`fdf0f062-12fc-46d6-8dd0-3c6786653821`)

## Objective
Implement the comprehensive E2E test suite for the backend rewrite project based on `TEST_INFRA.md` and user requirements in `ORIGINAL_REQUEST.md`.

## Detailed Responsibilities
1. Test Harness & Infrastructure:
   - Configure Vitest (`vitest.config.ts`) and test setup files.
   - Build a reusable test harness that instantiates the Hono app and provides mock/local D1 database (initialized with the 30-table SQLite schema) and mock R2 bucket.
   - Create helper utilities to easily execute requests (`request(app, method, path, { headers, body })`).
2. Test Case Implementation across Tiers 1-4:
   - **Tier 1 (Feature Coverage)**: Isolated happy-path tests for all 15 feature groups (Auth, Catalog, Questions, Exams, Students, Pearls, Courses, Professors, Store, Activations, Admin, Bans, Notifications, Media, Public).
   - **Tier 2 (Boundary & Corner Cases)**: Input validation errors, duplicate registrations, invalid credentials, expired tokens, role authorization (e.g. non-admin accessing admin endpoints), invalid IDs, file size limits.
   - **Tier 3 (Cross-Feature Combinations)**: Authentication + single-active session eviction, exam attempt + question answering + score calculation, order creation + admin fulfillment + activation code redemption.
   - **Tier 4 (Real-World Application Scenarios)**: Implement scenarios S1 to S6 defined in `TEST_INFRA.md`.
3. Completion & Handover:
   - Run the test suite commands to verify test syntax and runner readiness.
   - When the test suite is ready, publish `TEST_READY.md` at project root (`c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\TEST_READY.md`) following the exact template from `PROJECT.md`.
   - Write your complete handoff report to:
     `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_test_writer_e2e_1\handoff.md`

Maintain your heartbeat in `.agents/teamwork_preview_test_writer_e2e_1/progress.md`.
When complete, notify the orchestrator.

## 2026-09-17T00:24:32Z
You are E2E Test Writer (Test Infrastructure & Suite Creation) for the backend rewrite project.
Your working directory is: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_test_writer_e2e_1
Read your dispatch assignment in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_test_writer_e2e_1\DISPATCH.md
Read the authoritative user request in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md
Read the master architecture in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\PROJECT.md
Read the test infrastructure specification in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\TEST_INFRA.md

Your task:
1. Build the E2E test harness using Vitest and Hono test client against local/mock D1 database and R2 bucket.
2. Implement comprehensive opaque-box test suites covering Tiers 1-4 (Features, Boundaries, Combinations, Real-World Scenarios).
3. Verify test runners work and publish TEST_READY.md at project root (c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\TEST_READY.md).
4. Write your full handoff report to: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_test_writer_e2e_1\handoff.md

Maintain your heartbeat in progress.md. When complete, message parent (fdf0f062-12fc-46d6-8dd0-3c6786653821).
