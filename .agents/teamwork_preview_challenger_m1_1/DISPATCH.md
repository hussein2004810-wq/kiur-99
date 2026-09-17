# Task Assignment: M1 Challenger 1 - Empirical Database Schema & Constraint Stress-Testing

## Original Request Reference
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md`
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\PROJECT.md`

## Your Identity & Workspace
- Type: teamwork_preview_challenger
- Working Directory: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_challenger_m1_1`
- Parent: Orchestrator (`fdf0f062-12fc-46d6-8dd0-3c6786653821`)

## Objective
Adversarially challenge and empirically test the database schema (`migrations/0000_initial_schema.sql` and `src/db/schema.ts`):
1. Write and execute an adversarial test harness in your working directory (e.g. `test_schema_stress.mjs`).
2. Stress tests:
   - Insert rows into all 30 tables in full relational hierarchies.
   - Verify Foreign Key enforcement: verify that inserting invalid foreign keys fails with `SQLITE_CONSTRAINT_FOREIGNKEY`.
   - Verify Cascade Deletes: verify that deleting a parent user/question/lecture cascades to sessions/choices/progress.
   - Verify Unique Constraints: verify that duplicate emails, duplicate codes, or duplicate composite keys are rejected.
   - Check `PRAGMA foreign_key_check` on the populated database.
3. Formulate your findings and report your verdict: **CONFIRM_CORRECTNESS** or **REJECT**.

Write your handoff report to:
`c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_challenger_m1_1\handoff.md`
Maintain your heartbeat in `progress.md`. Notify orchestrator when complete.
