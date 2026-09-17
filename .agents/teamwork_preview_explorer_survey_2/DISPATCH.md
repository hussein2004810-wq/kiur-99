# Task Assignment: Database & Data Layer Survey

## Original Request Reference
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md`

## Your Identity & Workspace
- Type: teamwork_preview_explorer
- Working Directory: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_survey_2`
- Parent: Orchestrator (`fdf0f062-12fc-46d6-8dd0-3c6786653821`)

## Objective
Thoroughly explore the database layer of the existing Python backend in the workspace (`c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى`), and evaluate its migration from PostgreSQL/SQLAlchemy to SQLite/Cloudflare D1.

## Scope of Investigation
1. Locate all database models (SQLAlchemy DeclarativeBase / Base), table definitions, schemas, and Alembic migrations.
2. Catalog EVERY database model and table:
   - Table name
   - Columns: name, data type (Integer, String, Text, Boolean, DateTime, JSON, Enum, Float, etc.), nullability, default values, primary keys, autoincrement
   - Foreign keys, references, ondelete/onupdate constraints
   - Unique constraints and indexes
   - Relationships and cascade behaviors
3. Catalog Database Access Patterns:
   - Common queries, joins, filtering, pagination, and transaction patterns in the CRUD/service layer.
   - Any raw SQL queries or PostgreSQL-specific extensions/functions (e.g. `ARRAY`, `JSONB`, `UUID`, text search, `NOW()`).
4. Evaluate Cloudflare D1 / SQLite Compatibility:
   - Data type mappings from PostgreSQL/SQLAlchemy to SQLite (INTEGER, REAL, TEXT, BLOB).
   - How to represent DateTime (ISO strings or integer timestamps in SQLite).
   - How to represent Boolean (0/1 integer in SQLite).
   - How to represent JSON / Enums in SQLite.
   - Foreign key pragmas and constraints in D1.
   - Migration strategy (Drizzle ORM schema vs raw SQL schema for D1).

## Output Requirements
Write your detailed report and complete schema inventory to:
`c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_survey_2\handoff.md`
Maintain your heartbeat in `.agents/teamwork_preview_explorer_survey_2/progress.md`.
When finished, send a completion message back to parent with a summary and reference to the handoff file.
