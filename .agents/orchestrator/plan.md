# Master Execution Plan: KIUR-99 Remediation Project

## Objective
Remediate all identified security vulnerabilities, performance bottlenecks, and logic defects in the KIUR-99 platform (Hono / Cloudflare Workers / D1) per ORIGINAL_REQUEST.md (Follow-up 2026-09-24T21:54:14Z), achieving 0 test failures across all 565 tests and 0 TypeScript compilation errors with verified genuine implementations.

## Requirements Scope
1. **R1: Critical & High Security & Validation Fixes**
   - **CRIT-1**: In `test/tier2-boundaries/01-input-validation.test.ts` line 45, change `expect(data.detail).toContain('6')` to `expect(data.detail).toContain('10')` (min password length policy).
   - **HIGH-3**: In `src/routes/students.ts`, protect `GET /leaderboard` with `requireAuth` (currently exposed before wildcard auth).
   - **HIGH-4**: In `src/routes/admin.ts`, replace `Math.random()` banId generation with `schema.genId()`.
   - **HIGH-5**: In `src/routes/admin.ts`, add `limit` and `offset` pagination to `GET /users` (default: limit=50, offset=0, max limit=200).
   - **FB-01**: In `src/routes/auth.ts`, add `domainAllowed` check to `POST /firebase/verify` (mirroring `/google/verify`).
   - **FB-02**: In `src/routes/auth.ts`, refetch user row from DB after Firebase account linking instead of mutating the local object.
2. **R2: Performance Optimizations (Eliminating N+1 & Full Table Scans)**
   - **HIGH-1**: In `src/routes/admin.ts`, replace per-item query loops in `GET /professors`, `GET /resellers/:id/codes`, and `GET /bans` using batch `inArray()` or JOINs.
   - **HIGH-2**: In `src/routes/admin.ts`, replace full table scans in `GET /overview` with direct aggregate queries via `c.env.DB.batch([...])`.
3. **R3: Medium Logic Fixes**
   - **MED-3**: In `src/routes/questions.ts`, add random ordering or daily seed to `GET /daily` so questions vary.
   - **MED-6**: In `src/routes/activation.ts`, apply MAX_FAILED_REDEEMS lockout logic when code status is already active.
   - **FB-04**: In `wrangler.toml`, add explanatory comment regarding `BOOTSTRAP_ADMIN_EMAIL` migration to `wrangler secret put`.
   - **FB-03**: In `src/routes/auth.ts`, update `photo_url` on Firebase account linking if empty.

## Execution Phases

### Phase 1: Parallel Exploration & Blueprinting (3 Explorers)
- **Explorer Remed 1 (Auth, Security, Config & Boundaries)**:
  - Targets: `src/routes/auth.ts` (FB-01, FB-02, FB-03), `src/routes/students.ts` (HIGH-3), `wrangler.toml` (FB-04), `test/tier2-boundaries/01-input-validation.test.ts` (CRIT-1).
  - Inspect exact AST/lines, imports, context, and propose minimal, exact TypeScript diffs.
- **Explorer Remed 2 (Admin Performance & Scalability)**:
  - Targets: `src/routes/admin.ts` (HIGH-1: N+1 loops in `/professors`, `/resellers/:id/codes`, `/bans`; HIGH-2: aggregates in `/overview` using `DB.batch`; HIGH-4: `banId`; HIGH-5: pagination for `/users`).
  - Propose exact Drizzle/D1 batch and JOIN implementations avoiding schema breakage.
- **Explorer Remed 3 (Application Logic & Protection)**:
  - Targets: `src/routes/questions.ts` (MED-3: `/daily` random variation/seed), `src/routes/activation.ts` (MED-6: lockout on `already_active`).
  - Propose exact implementations adhering to existing helper functions and schemas.

### Phase 2: Implementation (Worker)
- Dispatch `teamwork_preview_worker` with unified exploration blueprint and strict anti-cheat warning.
- Execute changes across target files:
  - File ownership clearly defined.
  - Run `npm run typecheck` and `npm test` locally within worker environment.
  - Document all modifications and test runs in worker handoff.

### Phase 3: Multi-Perspective Verification (Reviewers + Challengers)
- **Reviewers (2 parallel reviewers)**:
  - Reviewer 1: Code correctness, interface conformance, and TypeScript safety.
  - Reviewer 2: Security posture, SQL/D1 query correctness, and error handling.
  - Both run typecheck and test suites.
- **Challengers (2 parallel challengers)**:
  - Challenger 1: Empirical stress-testing of pagination, aggregate queries, and question randomness.
  - Challenger 2: Empirical testing of security boundaries (leaderboard auth, domain restrictions, activation lockout).

### Phase 4: Forensic Integrity Audit
- Dispatch `teamwork_preview_auditor` to ensure zero hardcoded cheats, authentic implementations, and no bypasses.
- Evaluate gate status in `GATE_STATUS.md`.

### Phase 5: Synthesis & Handover
- Verify all 565 tests passing, 0 typecheck errors, clean audit verdict.
- Report comprehensive victory and handoff to parent.
