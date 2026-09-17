# Master Execution Plan: Backend Rewrite (FastAPI -> TypeScript Hono / Cloudflare Workers)

## Objective
Rewrite the entire existing Python backend into TypeScript using Hono, Cloudflare D1 (SQLite), and Cloudflare R2, maintaining 100% feature parity with zero changes required to the frontend.

## Phases

### Phase 0: Survey & Specification Mining
- Spawn 3 Explorers / Spec Miners in parallel:
  - **Explorer 1 (API & Routes)**: Map all FastAPI routes, HTTP methods, route parameters, request/response models, middleware, auth/session management, status codes, error formats.
  - **Explorer 2 (Database & Data Layer)**: Map SQLAlchemy models, tables, columns, constraints, foreign keys, relationships, seed data/migrations, and evaluate SQLite/D1 translation.
  - **Explorer 3 / Spec Miner (Storage & System Integration)**: Map S3/boto3 file upload/download operations, presigned URLs, file streaming, environment configuration, frontend API consumer contracts.

### Phase 1: Architecture & Project Scope Document (`PROJECT.md`)
- Synthesize findings into `PROJECT.md § Feature Inventory` and `§ Architecture`.
- Define cross-module interface contracts, code layout, and milestones.
- Establish the E2E Testing Track architecture (`TEST_INFRA.md`).

### Phase 2: Dual Track Execution
- **E2E Testing Track**:
  - Implement standalone HTTP/API test harness (Vitest / Hono test client) testing against specification (Tiers 1-4).
  - Produce `TEST_READY.md`.
- **Implementation Track**:
  - Milestone 1: Project foundation (TypeScript, Hono, Wrangler, D1 & R2 configuration, schema definition with Drizzle ORM).
  - Milestone 2: Core Auth, Sessions, Middleware, and Database Repositories.
  - Milestone 3: Domain Routes (Courses, Lessons, Users, and other application endpoints).
  - Milestone 4: Storage & Assets (R2 file operations, upload/download endpoints).

### Phase 3: Final Milestone & Hardening
- Phase 1: Pass 100% of E2E test suite (Tiers 1-4).
- Phase 2: Adversarial Coverage Hardening (Tier 5) with Challengers & Reviewers.
- Forensic Auditor integrity verification.

### Phase 4: Final Handover
- Verify clean local startup with `wrangler dev`.
- Final audit and victory report.
