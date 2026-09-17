# Task Assignment: M1 Explorer 2 - Drizzle ORM Schema & D1 SQL DDL Architecture

## Original Request Reference
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md`
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\PROJECT.md`
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_survey_2\handoff.md`

## Your Identity & Workspace
- Type: teamwork_preview_explorer
- Working Directory: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m1_2`
- Parent: Orchestrator (`fdf0f062-12fc-46d6-8dd0-3c6786653821`)

## Objective
Formulate the complete, production-ready Drizzle ORM TypeScript schema and raw SQLite DDL for all 30 tables and 5 enums for Milestone 1:
1. Validate every single table definition against `app/models.py` and Survey 2 findings:
   - Tables: `users`, `user_sessions`, `sections`, `universities`, `stages`, `subjects`, `professor_profiles`, `booklets`, `questions`, `choices`, `student_answers`, `exams`, `courses`, `lectures`, `recent_views`, `lecture_progress`, `activation_codes`, `products`, `orders`, `order_items`, `ban_records`, `activity_logs`, `media_files`, `exam_attempts`, `exam_attempt_questions`, `user_skills`, `saved_questions`, `notifications`, `notification_reads`, `clinical_pearls`.
2. Ensure correct SQLite types: `text` for strings/enums/dates, `integer` for ints/booleans/timestamps, `real` for floats.
3. Define primary keys (12-char hex string), foreign keys with appropriate `onDelete: 'cascade'`, unique constraints, and indexes.
4. Prepare `src/db/schema.ts`, `src/db/index.ts`, and `migrations/0000_initial_schema.sql`.
5. Ensure Drizzle relations are cleanly typed so queries can use relational queries (`db.query.users.findMany({ with: { sessions: true } })`).

Write your detailed recommendation and complete schema blueprint to:
`c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m1_2\handoff.md`
Update your heartbeat in `progress.md`. When complete, notify the orchestrator.

## 2026-09-17T00:24:32Z
You are M1 Explorer 2 (Drizzle Schema & D1 DDL) for Milestone 1: Foundation & Database Layer.
Your working directory is: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m1_2
Read your dispatch assignment in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m1_2\DISPATCH.md
Read the authoritative user request in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md
Read PROJECT.md in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\PROJECT.md
Read Survey 2 findings in: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_survey_2\handoff.md

Your task:
1. Formulate production-ready Drizzle ORM schema (src/db/schema.ts) and raw D1 SQLite DDL (migrations/0000_initial_schema.sql) covering all 30 tables and 5 enums.
2. Ensure types, cascades, indexes, and relations match the Python SQLAlchemy models exactly.
3. Write your complete schema specification to: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m1_2\handoff.md

Maintain your heartbeat in progress.md. When complete, message parent (fdf0f062-12fc-46d6-8dd0-3c6786653821).

