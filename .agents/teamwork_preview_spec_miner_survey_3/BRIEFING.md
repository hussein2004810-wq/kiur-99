# BRIEFING — 2026-09-17T00:22:30Z

## Mission
Discover and document complete specifications for storage (S3 -> Cloudflare R2), configuration & environment variables (FastAPI -> wrangler.toml), frontend client contracts, background tasks, and external services for the backend rewrite project.

## 🔒 My Identity
- Archetype: teamwork_preview_spec_miner
- Roles: Specification Miner (Storage, System Config & Frontend Contract Spec Miner)
- Working directory: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_spec_miner_survey_3
- Original parent: fdf0f062-12fc-46d6-8dd0-3c6786653821
- Milestone: spec_mining_survey

## 🔒 Key Constraints
- Read-only on source code: do NOT implement or modify application code during mining
- Exhaustively probe all storage operations (boto3, S3, uploads, downloads, presigned URLs, MIME, paths, R2 bindings)
- Classify all environment variables for wrangler.toml (vars, secrets, D1, R2)
- Map frontend API client expectations (base URLs, auth headers/cookies, envelope formats, casing, date formats)
- Document all background tasks, email sending, cron jobs, and external services
- Provide full 5-component handoff report with discovery tables

## Current Parent
- Conversation ID: fdf0f062-12fc-46d6-8dd0-3c6786653821
- Updated: 2026-09-17T00:17:08Z

## Task Summary
- **What to build**: Comprehensive specification report of Storage, System Configuration, Frontend Client Contracts, and External Services.
- **Success criteria**: Detailed, accurate handoff.md mapping existing Python/FastAPI/S3 behaviors to Cloudflare Workers (Hono/R2/D1) and recording frontend contracts.
- **Interface contracts**: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md
- **Code layout**: Python backend & Frontend in c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى

## Key Decisions Made
- Discovered 2 frontend SPAs served directly by FastAPI (`/` and `/admin`) with unified `apiFetch` architecture.
- Identified all 6 file upload paths and 1 media streaming route (`/media-files/{name}` with Range header support for lecture videos).
- Documented exact R2 native binding mapping (`env.R2_BUCKET.put/get/delete/head`) with HTTP Range support.
- Classified all 27 environment variables into wrangler.toml vars, secrets, D1 binding, and R2 binding.
- Validated API expectations: strictly snake_case, no response envelopes, ISO-8601 dates, standard `{ detail }` error format, in-memory Bearer token + httpOnly session cookie on `/auth/session`.
- Documented external services (Google OAuth 2.0 OpenID, SMTP password reset) and background task execution via `ctx.waitUntil`.

## Artifact Index
- c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_spec_miner_survey_3\DISPATCH.md — Dispatch log
- c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_spec_miner_survey_3\progress.md — Liveness heartbeat & task progress
- c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_spec_miner_survey_3\handoff.md — Final specification report

## Loaded Skills
- None explicitly assigned in dispatch.
