# Task Assignment: API & Routes Survey

## Original Request Reference
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md`

## Your Identity & Workspace
- Type: teamwork_preview_explorer
- Working Directory: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_survey_1`
- Parent: Orchestrator (`fdf0f062-12fc-46d6-8dd0-3c6786653821`)

## Objective
Thoroughly explore the existing Python backend codebase in the workspace (`c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى`) to map all API routes, schemas, auth, and middleware.

## Scope of Investigation
1. Locate the Python backend root directory, FastAPI application entrypoint (`main.py` or equivalent), routers, and settings.
2. Catalog EVERY FastAPI route and endpoint:
   - HTTP Method and Route Path
   - Router/Tag grouping
   - Request headers, path params, query params, request body schema (Pydantic models)
   - Response models, status codes, error responses
   - Dependencies injected (auth, db session, current_user, etc.)
3. Investigate Auth and Security:
   - Token/Session mechanics (JWT, cookies, Bearer tokens, expiry)
   - Password hashing algorithm and parameters (bcrypt, passlib, etc.)
   - Permissions, roles, and protected route rules
4. Investigate Middleware & Error Handling:
   - CORS configuration (origins, headers, credentials)
   - Custom exception handlers and error JSON response format
   - Request logging or custom middleware

## Output Requirements
Write your detailed report and structured endpoint catalog to:
`c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_survey_1\handoff.md`
Maintain your heartbeat in `.agents/teamwork_preview_explorer_survey_1/progress.md`.
When finished, send a completion message back to parent with a summary and reference to the handoff file.
