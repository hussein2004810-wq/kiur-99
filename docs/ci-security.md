# Continuous Integration & Dependency Security (Stage 22)

## 1. Overview
The security posture of **KIUR-99** is automatically verified on every code change via continuous integration. No code can be merged or deployed if security assertions fail.

## 2. Automated Pipeline Checks (`.github/workflows/security-ci.yml`)

1. **Static Type Checking (`tsc --noEmit`)**:
   - Ensures strict typing across all Hono routes, middleware, and database models.
   - Prevents unhandled null/undefined references and payload shape discrepancies.

2. **Automated Security Test Matrix (`npm test`)**:
   - Executes the full suite of security regression suites:
     - `test/security/01-config-secret-validation.test.ts`
     - `test/security/02-jwt-hardening.test.ts`
     - `test/security/03-session-hardening.test.ts`
     - `test/security/04-06-cookies-csrf-headers.test.ts`
     - `test/security/07-08-body-limits-ratelimit.test.ts`
     - `test/security/09-11-authorization-idor.test.ts`
     - `test/security/12-15-passwords-2fa-oauth.test.ts`
     - `test/security/16-18-media-exams-db.test.ts`
     - `test/security/19-logging-audit-trail.test.ts`
     - `test/security/23-adversarial-regression.test.ts`
   - Plus all 23 baseline feature test suites (358 tests).

3. **Secret Scanning**:
   - Regex scans source files for accidental commits of GitHub Personal Access Tokens, Google API keys, or private keys.

4. **Software Composition Analysis (SCA)**:
   - `npm audit --audit-level=critical` fails the build on any critical known vulnerability in direct or transitive packages.

## 3. Deployment Gating
- Production deployments through Wrangler (`npm run deploy`) should only trigger after all CI test steps and security audits have exited with code 0.
- Secrets are securely managed via Cloudflare Workers Secrets (`wrangler secret put`) and are never part of the CI build artifacts.

