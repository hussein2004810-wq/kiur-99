# Task Assignment: Storage, System Config & Frontend Contract Spec Mining

## Original Request Reference
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md`

## Your Identity & Workspace
- Type: teamwork_preview_spec_miner
- Working Directory: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_spec_miner_survey_3`
- Parent: Orchestrator (`fdf0f062-12fc-46d6-8dd0-3c6786653821`)

## Objective
Extract detailed specifications for storage (S3 -> Cloudflare R2), environment configurations, background processes, and frontend integration requirements in the workspace (`c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى`).

## Scope of Investigation
1. Storage Analysis:
   - Identify all files using `boto3`, S3 client, file upload endpoints, download endpoints, and presigned URL generation.
   - Catalog all storage operations: bucket names, key naming conventions/paths, MIME type validation, file size limits, access controls (public vs private).
   - Detail how these translate to native Cloudflare R2 bindings (`env.R2_BUCKET.put()`, `env.R2_BUCKET.get()`, `env.R2_BUCKET.delete()`, public URLs or presigned URLs).
2. Configuration & Environment Variables:
   - Identify all environment variables in `.env`, `.env.example`, `config.py`, or Pydantic `BaseSettings`.
   - Classify variables: secrets, database URLs, storage credentials, JWT secrets, frontend URLs, ports.
   - Detail how these map to Cloudflare Workers `wrangler.toml` (vars, bindings for D1, bindings for R2, secrets).
3. Frontend Integration & Compatibility:
   - If a frontend exists in the workspace (React, Vue, Next.js, Flutter, etc.), investigate how it calls the backend:
     * Base URL and path prefixes (e.g., `/api`, `/api/v1`).
     * Auth token handling (Authorization header, cookie name, refresh logic).
     * Response payload expectations (envelope `{ data, error }` vs direct JSON, date format, casing `camelCase` vs `snake_case`).
     * File upload requests (multipart/form-data vs base64 vs presigned S3 upload).
4. Background Tasks & External Services:
   - Identify any background tasks (`BackgroundTasks` in FastAPI, Celery, cron jobs).
   - Any external APIs called (email sending, payment gateways, etc.).

## Output Requirements
Write your detailed report and specification extraction to:
`c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_spec_miner_survey_3\handoff.md`
Maintain your heartbeat in `.agents/teamwork_preview_spec_miner_survey_3/progress.md`.
When finished, send a completion message back to parent with a summary and reference to the handoff file.

## 2026-09-17T00:17:08Z
You are Spec Miner 3 (Storage and System Spec Miner) for the backend rewrite project.
Your working directory is: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_spec_miner_survey_3
Read your dispatch details in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_spec_miner_survey_3\DISPATCH.md
Read the authoritative user request in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md

Your task:
1. Explore c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى for storage, config, and frontend client contracts.
2. Identify all boto3 / S3 usage: file uploads, downloads, presigned URLs, MIME types, buckets, and paths. Detail how these map to Cloudflare R2 bindings.
3. Identify all environment variables (.env, config.py, settings) and classify them for wrangler.toml (vars, secrets, D1/R2 bindings).
4. Inspect the frontend codebase if present in the workspace, or client API callers, to identify base URLs, auth token transmission, response wrapping, date formats, and casing expectations.
5. Document any background tasks, email sending, cron jobs, or external services.

Update your progress.md regularly with heartbeat.
Write your complete analysis and specification report to:
c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_spec_miner_survey_3\handoff.md

When complete, send a message back to parent (conversation ID: fdf0f062-12fc-46d6-8dd0-3c6786653821) with a concise summary and link to your handoff.md.
