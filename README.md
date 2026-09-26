# Kiur — Cloudflare Worker

This repository serves the student SPA, the staff dashboard, and a Hono API from one Cloudflare Worker. User records and sessions live in D1; Firebase Authentication is used only to verify Google identity. The Worker issues Kiur sessions after checking the provider token and the stored account binding.

## Local development

1. Install Node.js and run `npm ci`.
2. Configure the required Worker secrets for your local environment. Keep `JWT_SECRET` and email provider credentials out of Git.
3. Run `npm run db:migrate:local` and then `npm run dev`.
4. Open the local Wrangler URL. The student app is `/`, and the staff dashboard is `/admin`.

`npm run typecheck` checks TypeScript. For the security suite, use `TEST_TARGET=src` with Vitest (PowerShell: `$env:TEST_TARGET='src'; npm test -- --run test/security`). `npm run build` performs a Worker dry run. The migration command for a remote D1 database is `npm run db:migrate:remote`; use it only for an intended deployment environment.

## Sign in

Email registration requires verification before the first session. Transactional email must be configured for verification, password reset, and staff invitations. A staff member created in the dashboard receives an invitation and chooses a password using the emailed link. Google sign in requires a working Firebase Web configuration and a Google provider enabled for the deployment domain. An existing Kiur account must be linked from its security settings using a current Kiur session and password; a matching email by itself does not link accounts. Staff roles are never assigned by public registration.

Offline preview controls are for development only. They are hidden from the published login screen and do not authenticate to the API.

## Operations

The source files and local tests do not prove that production email, Firebase domains, Cloudflare bindings, and D1 migrations are configured. Check these in staging with real student and staff accounts before deployment. See `docs/KIUR_SECURITY_AUTH_UX_REQUIREMENTS_2026-09-25.md` for the audit requirements and acceptance criteria.
