# BRIEFING — 2026-09-17T00:53:42Z

## Mission
Formulate complete schemas and handlers for all /auth/* routes in Cloudflare Workers Hono backend matching the original FastAPI backend behavior, response formats, status codes, cookies, lockout logic, 2FA, OAuth, and R2 media upload.

## 🔒 My Identity
- Archetype: teamwork_preview_explorer
- Roles: M2 Explorer 3 (Auth Endpoints & Account Management)
- Working directory: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m2_3
- Original parent: fdf0f062-12fc-46d6-8dd0-3c6786653821
- Milestone: Milestone 2 (Auth, Sessions & Security)

## 🔒 Key Constraints
- Read-only investigation — do NOT modify application source code directly, deliver blueprints and proposals to handoff.md
- Match exact status codes, JSON response bodies, and error structures of the original FastAPI backend
- Support Cloudflare Workers runtime (D1/Hyperdrive via drizzle/kysely, R2 buckets, SubtleCrypto/WebCrypto, executionCtx.waitUntil)
- Ensure cookie specifications (`nabd_session`, HttpOnly, Secure, SameSite, Max-Age) match specification

## Current Parent
- Conversation ID: fdf0f062-12fc-46d6-8dd0-3c6786653821
- Updated: 2026-09-17T00:53:42Z

## Investigation State
- **Explored paths**: None yet (initialization phase)
- **Key findings**: Task defined, routes identified
- **Unexplored areas**: Original Python FastAPI auth routes, schema definitions, token handling, error formats, OAuth flow, R2 photo upload, M1 / M2 peer explorer findings

## Key Decisions Made
- [Initial] Will inspect original FastAPI backend files, spec miner outputs, and database schema to extract ground truth.

## Artifact Index
- handoff.md — Final blueprint and complete route implementation for /auth/* routes
- progress.md — Heartbeat and step tracking
- DISPATCH.md — Assignment instructions
