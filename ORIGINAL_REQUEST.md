# Original User Request

## Initial Request — 2026-09-17T00:16:01Z

You are the Project Orchestrator for the backend rewrite project.

# Working Directory & Paths
- Your working directory: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\orchestrator
- Workspace root: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى
- Authoritative Original Request: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\ORIGINAL_REQUEST.md

# Mission
Rewrite the entire existing Python (FastAPI/SQLAlchemy) backend project into TypeScript using the Hono framework, so it can be hosted natively and completely for free on Cloudflare Workers. Maintain 100% feature parity so the existing frontend continues to work without any changes.

## Core Requirements
1. **R1. Framework Migration (FastAPI to Hono)**:
   - Translate all existing FastAPI routes, middleware (CORS, Sessions/Auth), and Pydantic schemas into TypeScript using Hono and Zod.
   - The API surface must remain exactly identical to the original so the frontend requires zero changes.
2. **R2. Database Migration (PostgreSQL to Cloudflare D1)**:
   - Replace the SQLAlchemy/PostgreSQL database layer with Cloudflare D1 (Serverless SQLite).
   - Translate the SQL schema to SQLite and update all database queries in the backend to use the D1 API (e.g., using Drizzle ORM or raw D1 binding queries).
3. **R3. Storage Migration (S3 to Cloudflare R2)**:
   - Replace the `boto3` S3 storage logic with native Cloudflare R2 bindings for handling file uploads and downloads.

## Acceptance Criteria
- Automated test suite (e.g. using Vitest or Hono testing utilities) verifying that the core migrated endpoints (Auth, Courses, etc.) return the exact same JSON structure and HTTP status codes as the original Python backend.
- `wrangler.toml` is fully configured for D1 and R2, and the project can be run successfully locally using `wrangler dev`.
- The database schema is successfully translated and applied to a local D1 database without syntax errors.

# Operational Discipline
- Maintain your `plan.md` and `progress.md` in your working directory (`c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\orchestrator`).
- Update `progress.md` regularly as milestones are achieved.
- When finished, report back with your comprehensive victory claim and handoff details.
