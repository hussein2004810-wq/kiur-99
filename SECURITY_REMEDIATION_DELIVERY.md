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
- `d2ae344` shares the browser-facing verification-link callback with the JSON verification logic and tests the redirect path.
- `23ad5b7` narrows CSP sources and applies the policy to the served SPA response.
- `d1de359` encodes dynamic arguments sent to legacy inline event handlers, preventing stored-text quote breakout.
- `f0b0f9e` requires a verified provider email in the Google OAuth callback.
- `4dea90e` accepts only audience-bound Google ID credentials and removes the UI's untrusted Google fallback.
- `228023b` verifies Google ID credentials against the provider JWKS rather than a response from `tokeninfo`.
- `95d23ad` binds each Google Identity credential to a short-lived, one-time browser flow nonce.
- `8eb881a` encodes the remaining dynamic identifiers passed through legacy administrator event handlers.
- `140212d` escapes fallback enum text from legacy roles, statuses, and product types before the SPA renders it.
- `38851d9` prevents production password registration unless transactional email is ready to deliver verification links.
- `66e718b` pins development `esbuild` at `^0.28.2`, satisfying the installed Vite/Vitest requirement and removing the invalid root dependency tree.
- `140877d` hardens admin media uploads and makes the streaming regression suite exercise the actual Worker authorization path.
- `fbdeda4` canonicalizes new media names and response MIME types from verified file signatures.
- `e410802` aligns direct Worker uploads at a verified 25 MB ceiling, including professor lecture videos; larger-video delivery remains an external architecture decision.
- `9949443` redacts unexpected server, mail-provider, Firebase, and admin-mutation failures from production responses and logs.
- `e033245` removes reseller self-minting: only an admin allocation may assign idle activation-code stock to a reseller.
- `e20aeb7` allows dynamically rendered media only from KIUR's `/media-files/...` and `/api/media/...` paths, preventing stored URLs from becoming external, `data:`, or `javascript:` browser navigations.
- `934007a` rejects arbitrary lecture video URLs at the server boundary, requires the verified video-upload flow, and limits a revoked banned session to its own appeal request only.
- `54138a0` escapes values as well as labels in the reusable administrator modal's dynamic select options.
- `ba9d129` removes the unused HTML rendering mode from the administrator confirmation modal, so confirmation messages remain text-only.
- `8808e70` encodes dynamic student UI identifiers passed to inline click handlers as JavaScript arguments rather than quoted interpolations.
- `2d4b91e` applies the same argument encoding to dynamic administrator account, catalogue, content, glimpse, and product controls.
- `e72c416` configures the existing Worker Assets integration for `public`, providing a same-origin delivery path for the planned external CSP modules.
- `dc6c366` applies one password policy to registration, change, and recovery, and rate-limits recovery completion and email verification.
- `c9b7508` makes missing debug configuration fail closed and exposes the development login route only with an explicit `DEBUG=true`.
- `c91b458` keeps password-reset tokens out of non-debug responses and makes the default session-cookie helpers secure.
- `af57bae` makes an unset production CORS allowlist reject cross-origin requests rather than defaulting to localhost.
- `a998ba8` adds browser isolation and privacy headers while retaining Google Identity popup compatibility.
- `6eef79b` rejects state-changing requests that carry the session cookie but provide neither `Origin` nor `Sec-Fetch-Site` browser provenance.
- `a4accb2` replaces OAuth redirect JWT fragments with origin-bound, hashed, 60-second, one-time handoff codes.
- This working-tree follow-up extends the same unapplied `0008` migration so OAuth accounts with 2FA also receive only a handoff code in the redirect fragment.
- The course lecture-completion endpoint now requires a valid authenticated user and the same server-side course entitlement used for protected video/material access.
- CSP now pins the two served inline application scripts with SHA-256 hashes through `script-src-elem`; `script-src-attr` remains the explicit temporary boundary for legacy inline event handlers, and a regression test derives the hashes from the served SPA files.

## Implemented controls

- `src/services/content-access.ts` is the shared server-side entitlement policy used by media, courses, questions, and exams.
- `src/routes/questions.ts`, `src/routes/exams.ts`, and `src/routes/students.ts` require authenticated, scoped access rather than relying on the client UI.
- Public registration always persists the `student` role and returns no access token or session cookie.  Existing unverified accounts cannot obtain a password/2FA/restored session until their email is verified.
- New and changed passwords are centrally constrained to 10–128 characters; registration, password change, and reset all enforce the same policy.  Password-reset completion and POST email verification are D1-backed rate-limited.
- Every Google entry point now requires a provider-asserted verified email before it creates, verifies, or signs in a local user; a verified Google callback may safely mark an existing local password account verified.
- Google Identity Services credentials are now verified with Google's OIDC JWKS using RS256, issuer, audience, issued-at, expiry, and a one-time browser-bound nonce; the direct credential route no longer treats the `tokeninfo` response as its authentication boundary.
- The Google GIS endpoint accepts only a signed ID credential whose issuer and audience exactly match the configured KIUR Google client; general OAuth access tokens and local remembered-account fallbacks cannot establish a session.  Both the flow-nonce and verification endpoints are D1-backed rate-limited to 10 requests per minute per originating IP.
- When SMTP is configured, registration and resend create a single-use verification token and schedule delivery of a link to `GET /auth/verify-email`; that callback consumes the same token-validation path as `POST /auth/verify-email` and redirects to a success or failure state.
- A production password-registration request now fails before creating a user unless a supported transactional-mail provider, sender identity, and provider secret are present; local debug mode remains usable for development and test workflows.
- Debug behavior is deny-by-default: a missing `DEBUG` value does not enable development login or development-only response data.  Password-reset tokens are returned only with explicit `DEBUG=true`, and the session-cookie helper defaults to `Secure`.
- If production has no `CORS_ORIGINS` configuration, the CORS middleware allows no configured cross-origin caller instead of falling back to localhost.  Responses also use `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin-allow-popups`, `Cross-Origin-Resource-Policy: same-origin`, and `Origin-Agent-Cluster: ?1`; the popup-compatible COOP value is intentional for Google Identity.
- Cookie-backed state changes that provide neither `Origin` nor `Sec-Fetch-Site` are denied.  This closes an ambiguous browser-request path while leaving bearer-token API clients unaffected.
- The Google OAuth callback never places an access token or 2FA pending JWT in its redirect fragment.  It stores only a hash of a one-time handoff code bound to the target frontend origin and active session (or 2FA user); `/auth/oauth/handoff` rate-limits the browser exchange, verifies the origin and account/session state, and atomically consumes the code before issuing the appropriate JWT response.
- The CSP permits only the Google Identity script origin required by the SPA, removes the unused jsDelivr allowlist, and restricts form submissions to same-origin destinations.
- Admin media uploads now fail closed before body parsing when R2 is absent, verify magic bytes rather than trusting the declared filename or MIME type, generate server-owned object names, and remove the R2 object if media-record persistence fails.
- Every new image, booklet, and lecture-video object now receives a server-generated filename with the extension detected from its verified bytes.  Media reads use a fixed extension-to-MIME allowlist and serve unrecognized legacy names as `application/octet-stream`.
- The professor lecture-file endpoint is explicitly classified as an upload by the global body limiter.  It accepts the same 25 MB direct-upload ceiling it advertises, instead of being accidentally limited as 100 KB JSON.
- A professor may create a lecture without a video, but cannot attach an arbitrary URL through the legacy creation route; only the verified lecture-file upload flow can create its media record and Worker-owned URL.
- Banning still immediately deactivates all sessions.  A valid token for one of those revoked sessions is accepted only for `POST /api/bans/appeal` for its own banned account; it cannot access any other protected route and remains invalid after unban until a fresh login.
- Unexpected production failures now emit only structured event/category records.  Firebase and admin error responses no longer expose raw exception messages, and transactional-mail failure logs omit recipient/provider error details.
- Resellers can sell only their assigned codes.  The administrator's allocation endpoint validates the target and requested count, writes each allocation in one D1 batch, and records the allocation; self-generation endpoints now reject with 403.
- Both static SPA documents escape persisted academic/profile/question text at their `innerHTML` rendering boundaries; regression coverage reads the served documents directly.
- The reusable administrator modal escapes both labels and values in dynamic `<option>` attributes, preventing a stored catalogue identifier from breaking its attribute boundary.
- Student academic-path selectors and the administrator question-bank selector also escape each dynamic `<option>` value, so a persisted catalogue identifier cannot break an attribute boundary in either SPA.
- Avatar initials and administrator weak-topic labels are escaped at their `innerHTML` boundaries too; derived text is not assumed safe merely because the full display name or topic is escaped elsewhere.
- The administrator confirmation modal no longer accepts an HTML payload; all confirmation copy is assigned through `textContent`.
- `wrangler.toml` now binds Worker Assets from `public`; `src/routes/static.ts` serves the SPA through that binding when deployed and retains its text-import fallback for tests.
- Both static SPA documents also allowlist dynamically rendered image, booklet, and lecture-video URLs to the Worker-owned media routes before placing them in `src` or `href`; unsafe or legacy external values render the existing safe fallback instead.
- Dynamic user-controlled values that must be passed to legacy inline handlers are encoded as a single JavaScript argument rather than HTML-escaped inside a quoted handler literal, preventing quote-breakout from stored catalogue, account, or Google-profile data.
- Student content cards, booklets, quizzes, products, notifications, saved questions, clinical glimpses, and profile links now apply that same argument encoding to their dynamic identifiers.
- Administrator account controls, academic-tree actions, content management, ban appeals, professor resources, clinical-glimpse workflow, and product controls also use encoded dynamic arguments.
- Administrator booklet/video upload triggers, clinical-glimpse approval/publication controls, and order-status changes now use the same encoded argument boundary; dynamic university IDs in DOM attributes and order/activation-code display values are escaped as well.
- `src/routes/exams.ts` stores question/choice snapshots, prevents a second open attempt with database constraints, performs conditional answer/finish transitions, and replays only a finish request bearing its original idempotency key.
- `migrations/0005_exam_integrity.sql`, `migrations/0006_durable_rate_limits.sql`, and `migrations/0007_exam_finish_idempotency.sql` are additive remote-D1 migrations.  They have not been applied remotely.
- `load-tests/exam-burst.k6.js` requires an explicit staging URL, exam id, and one entitled token per simulated student.  It cannot run against anything by default.
- `docs/SECURITY_PERMISSION_MATRIX.md` records the enforced access contract and its source-target regressions.

## Verification performed locally

- `npm run typecheck` passed after the final application changes.
- Latest local verification: `npm run typecheck` passed; `TEST_TARGET=src npm test -- test/security/p0-remediation.test.ts` passed 46 tests; `TEST_TARGET=src npm test -- test/security` passed 14 files and 142 tests; and `npm run build` completed as a Worker dry-run without deployment.
- `TEST_TARGET=src npm test -- test/security/p0-remediation.test.ts` passed: 40 tests, including verification-link, verified/unverified Google OAuth callback, audience, access-token rejection, production-mail readiness, admin-media upload hardening, and arbitrary-lecture-URL rejection cases.
- `TEST_TARGET=src npm test` passed: 40 files and 548 tests against the actual Worker, including Tier 3 and Tier 4 media, entitlement, session-revocation, and ban-appeal flows.
- `npm test` passed: 40 files and 548 tests after the final ownership, media, registration, rate-limit, D1-bound, R2 fail-closed, verification-link, CSP-source, Google OAuth credential, mail-readiness, admin-upload, direct-video-upload, error-redaction, and ban-appeal changes.
- `TEST_TARGET=src npm test -- --run test/security` passed: 14 files and 133 tests against the actual Worker routes.
- The scripts embedded in both served SPA documents were parsed after the URL-allowlist change; dynamic media URL regressions are covered by the P0 source-level test.
- `npm run build` passed as a Wrangler dry run; it did not deploy.
- Vitest was upgraded to `4.1.11`, closing its Moderate mocker path-traversal advisory.  `npm audit --json` now reports four Moderate development-only findings from Drizzle Kit's legacy `@esbuild-kit` chain; npm's only suggested fix is a major downgrade of Drizzle Kit to `0.18.1`, so it was not applied automatically.
- A current `npm audit --omit=dev --json` reports zero runtime dependency vulnerabilities.  The full audit still reports only the four Drizzle Kit development-tool findings above.

## Owner actions required before production

1. Generate and store a new 32+ character JWT secret in the deployment secret store, revoke existing sessions, and remove every historical exposed secret from deployment history/configuration.
2. Set exact production `CORS_ORIGINS` values and all production mail/OAuth values.  Empty/wildcard CORS is intentionally rejected in production; SMTP or the selected transactional-mail provider must be configured before public password registration is enabled, because unverified accounts now correctly receive no session.
3. Back up the remote D1 database, apply migrations 0005 through 0008, and confirm indexes with the production D1 tooling.  Migration 0008 is required before Google OAuth redirects can complete on a deployed Worker.
4. Run Gitleaks and CI from the remote provider, then run the supplied k6 test on isolated staging at 600 and 1,000 distinct entitled users.  Keep the results before claiming concurrency readiness.
5. Choose and budget for the video architecture before enabling large uploads or promising HLS/ABR playback.  Cloudflare Stream and a self-hosted transcoding pipeline are external product/operational decisions, not safe local code defaults.
6. Configure a real private R2 binding only after its bucket and access policy are approved.  The local Worker dry run currently exposes no R2 binding, so video/file upload must not be enabled in production as-is.

## Remaining limits

- No actual 600/1,000-user load result exists yet; the k6 harness is prepared but deliberately not run against any environment.
- Four Moderate development-only Drizzle Kit/esbuild advisories remain for a dedicated dependency-upgrade branch with full migration-tool regression testing; the reported npm fix is a major downgrade and is not a safe automatic remediation.
- The served SPA documents still use inline scripts, inline event handlers, and inline styles.  CSP therefore still contains `'unsafe-inline'` for scripts/styles; removing it safely requires a dedicated UI migration to external modules and delegated event listeners, not a header-only switch.
- This delivery does not modify Cloudflare, Firebase, mail, OAuth, GitHub, production secrets, or remote databases.
