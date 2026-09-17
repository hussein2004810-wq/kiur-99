# Cloudflare Hardening & Security Deployment Guide (SEC-CF-001, SEC-CF-002)

This document outlines the security configuration, environment isolation, and edge defense procedures for deploying the **KIUR-99** backend on Cloudflare Workers.

---

## 1. Cloudflare Secrets Management (SEC-CF-001)

Sensitive credentials must **never** be committed in plain text to version control or `wrangler.toml`. In production, store all secrets in Cloudflare Workers encrypted secret storage using the Wrangler CLI.

### Required Production Secrets
Run the following commands to provision production secrets securely:

```bash
# 1. High-entropy JWT Signing Key (minimum 32 cryptographically random characters)
npx wrangler secret put JWT_SECRET

# 2. Google OAuth Client Secret
npx wrangler secret put GOOGLE_CLIENT_SECRET

# 3. SMTP Password for transactional emails
npx wrangler secret put SMTP_PASSWORD

# 4. Bootstrap Admin Email (optional secret or bound var)
npx wrangler secret put BOOTSTRAP_ADMIN_EMAIL
```

> **Security Rule:** Once these secrets are set in Cloudflare Workers, remove any sensitive test values from `wrangler.toml`'s `[vars]` block so that only non-sensitive configuration keys (e.g., `DEBUG = "false"`, `JWT_EXPIRES_MINUTES = "20160"`) are committed to Git.

---

## 2. Least-Privilege D1 Database & Storage Bindings

1. **D1 Database Isolation**:
   - Production database: `kiur-99-db` (ID: `89fbb990-643f-4727-b71b-99733e65593a`).
   - The Worker binding `DB` connects exclusively to `kiur-99-db`.
   - **Strict Constraint**: Under no circumstances should `kiur-database`, `syn-books-db`, or `maktabat-alcenter-db` be bound or referenced by this Worker.
2. **R2 Media Bucket Isolation**:
   - Use an isolated R2 bucket `kiur-99-media` for user avatars and document assets.
   - Filenames are sanitized via `safeUploadName()` and access paths are validated against directory traversal.

---

## 3. Cloudflare Edge WAF & Rate Limiting Rules (SEC-CF-002)

While the Worker enforces in-memory rate limiting and request body limits, configuring Cloudflare Edge rules provides defense-in-depth before malicious traffic reaches Worker CPU execution.

### Recommended Edge Rate Limiting Rules (Cloudflare Dashboard > Security > WAF > Rate Limiting Rules)

| Route Pattern | Method | Rate Limit Window | Threshold | Action |
| :--- | :--- | :--- | :--- | :--- |
| `*/auth/login` | `POST` | 1 minute | 10 requests | Block / Challenge (429) |
| `*/auth/register` | `POST` | 10 minutes | 5 requests | Block / Challenge (429) |
| `*/auth/forgot-password` | `POST` | 10 minutes | 3 requests | Block / Challenge (429) |
| `*/auth/2fa/verify` | `POST` | 5 minutes | 5 requests | Block (429) |
| `*/api/exams/*/start` | `POST` | 1 minute | 10 requests | Block (429) |

### Cloudflare WAF Managed Rules
Enable the following managed rulesets under **Security > WAF > Managed Rules**:
- **Cloudflare Managed Ruleset** (Protects against OWASP Top 10 vulnerabilities, SQL injection, Command Injection).
- **Cloudflare Exposed Credentials Check** (Flags requests using publicly compromised credential dumps).

---

## 4. Cloudflare Turnstile Integration (Bot Protection)

For anonymous public mutations (registration and password recovery requests):
1. Create a Turnstile widget in Cloudflare Dashboard under **Turnstile**.
2. Mount the Turnstile client widget on `/auth/register` and `/auth/forgot-password` forms.
3. Verify the Turnstile response token on the Worker backend using the `https://challenges.cloudflare.com/turnstile/v0/siteverify` endpoint before processing the transaction.

---

## 5. Observability, Logging & Alerting (SEC-LOG-001)

1. **Security Audit Logs**:
   - The application streams structured JSON logs via `console.info` / `console.warn` tagged with `{"audit": true, "event": "...", "status": "..."}`.
   - Use **Cloudflare Workers Tail** (`npx wrangler tail`) to monitor live security events and token revocation.
   - For enterprise retention, configure **Cloudflare Logpush** to ship Worker logs to Amazon S3, Google Cloud Storage, or Datadog.
2. **Alerting Triggers**:
   - Configure alert notifications in Cloudflare Dashboard (**Notifications**) for:
     - Spikes in 401/403 responses (potential brute-force or credential stuffing attack).
     - Spikes in 429 responses (rate limiting abuse).
     - Sudden surges in 5xx errors or CPU execution time.

---

## 6. Staging vs Production Separation

- **Preview/Staging Worker**: Run against a dedicated staging D1 database (`kiur-99-staging-db`) to prevent development and test fixtures from polluting production data.
- **CORS Allowlist**: Never leave `CORS_ORIGINS = "*"` in production when credentials/cookies are in use. Set `CORS_ORIGINS` to the exact production frontend domains (e.g. `https://kiur.app,https://admin.kiur.app`).

