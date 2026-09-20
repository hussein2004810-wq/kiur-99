# KIUR-99 Security Remediation Delivery

Status: local remediation complete for the implemented Worker code.  Nothing in this delivery was pushed, deployed, or applied to a remote D1 database.

## Local commits

- `dbd7ff2` closes media-object authorization, hardens JWT/session validation, adds exam snapshots and constraints, and adds security CI gates.
- `688f3e6` replaces isolate-local rate-limit state with a D1-backed window table.
- `b011aab` applies academic entitlement checks to questions, exams, the student directory, and direct student profile access.
- `8fdc900` moves student directory filtering/pagination into SQL and makes answer-vs-finish races return a rejection instead of a false success.
- `3dfaafa` makes a lost finish response safely replayable with the same idempotency key, adds migration `0007`, and supplies the k6 exam burst harness.
- `f67b49f` bounds legacy long-attempt D1 queries and selects a bounded question set in D1.
- `fbe5b1a` applies durable limits to both account and IP and attaches the exam-start limiter.
- `ae4ede3` prevents cross-professor content creation, mutation, and deletion through generic professor routes.
- `7dc0ea4` removes raw booklet URLs from public professor metadata.
- `ac9fb15` makes every upload endpoint fail closed with a controlled 503 when R2 is not configured.
- `b2ce237` closes the remaining public-registration privilege escalation, requires email verification before any password session, and fixes additional stored-text escaping in both served SPA files.
- `d67f157` sends verification links through the configured mail provider during registration and resend flows.
- The current working change exercises the browser-facing verification-link callback and shares its verification logic with the JSON API.

## Implemented controls

- `src/services/content-access.ts` is the shared server-side entitlement policy used by media, courses, questions, and exams.
- `src/routes/questions.ts`, `src/routes/exams.ts`, and `src/routes/students.ts` require authenticated, scoped access rather than relying on the client UI.
- Public registration always persists the `student` role and returns no access token or session cookie.  Existing unverified accounts cannot obtain a password/2FA/restored session until their email is verified.
- Every Google entry point now requires a provider-asserted verified email before it creates, verifies, or signs in a local user; a verified Google callback may safely mark an existing local password account verified.
- When SMTP is configured, registration and resend create a single-use verification token and schedule delivery of a link to `GET /auth/verify-email`; that callback consumes the same token-validation path as `POST /auth/verify-email` and redirects to a success or failure state.
- The CSP permits only the Google Identity script origin required by the SPA, removes the unused jsDelivr allowlist, and restricts form submissions to same-origin destinations.
- Both static SPA documents escape persisted academic/profile/question text at their `innerHTML` rendering boundaries; regression coverage reads the served documents directly.
- Dynamic user-controlled values that must be passed to legacy inline handlers are encoded as a single JavaScript argument rather than HTML-escaped inside a quoted handler literal, preventing quote-breakout from stored catalogue, account, or Google-profile data.
- `src/routes/exams.ts` stores question/choice snapshots, prevents a second open attempt with database constraints, performs conditional answer/finish transitions, and replays only a finish request bearing its original idempotency key.
- `migrations/0005_exam_integrity.sql`, `migrations/0006_durable_rate_limits.sql`, and `migrations/0007_exam_finish_idempotency.sql` are additive remote-D1 migrations.  They have not been applied remotely.
- `load-tests/exam-burst.k6.js` requires an explicit staging URL, exam id, and one entitled token per simulated student.  It cannot run against anything by default.
- `docs/SECURITY_PERMISSION_MATRIX.md` records the enforced access contract and its source-target regressions.

## Verification performed locally

- `npm run typecheck` passed after the final application changes.
- `TEST_TARGET=src npm test -- test/security/p0-remediation.test.ts` passed: 32 tests, including a verification-link callback and verified/unverified Google OAuth callback cases.
- `npm test` passed: 40 files and 536 tests after the final ownership, media, registration, rate-limit, D1-bound, R2 fail-closed, verification-link, CSP-source, and Google OAuth verification changes.
- `TEST_TARGET=src npm test -- --run test/security` passed: 14 files and 123 tests against the actual Worker routes.
- `npm run build` passed as a Wrangler dry run; it did not deploy.
- Vitest was upgraded to `4.1.11`, closing its Moderate mocker path-traversal advisory.  `npm audit --json` now reports four Moderate development-only findings from Drizzle Kit's legacy `@esbuild-kit` chain; npm's only suggested fix is a major downgrade of Drizzle Kit to `0.18.1`, so it was not applied automatically.

## Owner actions required before production

1. Generate and store a new 32+ character JWT secret in the deployment secret store, revoke existing sessions, and remove every historical exposed secret from deployment history/configuration.
2. Set exact production `CORS_ORIGINS` values and all production mail/OAuth values.  Empty/wildcard CORS is intentionally rejected in production; SMTP or the selected transactional-mail provider must be configured before public password registration is enabled, because unverified accounts now correctly receive no session.
3. Back up the remote D1 database, apply migrations 0005 through 0007, and confirm indexes with the production D1 tooling.
4. Run Gitleaks and CI from the remote provider, then run the supplied k6 test on isolated staging at 600 and 1,000 distinct entitled users.  Keep the results before claiming concurrency readiness.
5. Choose and budget for the video architecture before enabling large uploads or promising HLS/ABR playback.  Cloudflare Stream and a self-hosted transcoding pipeline are external product/operational decisions, not safe local code defaults.
6. Configure a real private R2 binding only after its bucket and access policy are approved.  The local Worker dry run currently exposes no R2 binding, so video/file upload must not be enabled in production as-is.

## Remaining limits

- No actual 600/1,000-user load result exists yet; the k6 harness is prepared but deliberately not run against any environment.
- Four Moderate development-only Drizzle Kit/esbuild advisories remain for a dedicated dependency-upgrade branch with full migration-tool regression testing; the reported npm fix is a major downgrade and is not a safe automatic remediation.
- The served SPA documents still use inline scripts, inline event handlers, and inline styles.  CSP therefore still contains `'unsafe-inline'` for scripts/styles; removing it safely requires a dedicated UI migration to external modules and delegated event listeners, not a header-only switch.
- This delivery does not modify Cloudflare, Firebase, mail, OAuth, GitHub, production secrets, or remote databases.
