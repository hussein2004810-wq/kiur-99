## 2026-09-24T22:06:14Z

You are Worker Remed 1. Your working directory is c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_worker_remed_1.

MANDATORY FIRST STEP: Read c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\ORIGINAL_REQUEST.md (specifically the section: ## Follow-up — 2026-09-24T21:54:14Z) before doing anything else.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

You own the following files exclusively:
- test/tier2-boundaries/01-input-validation.test.ts
- src/routes/students.ts
- src/routes/auth.ts
- wrangler.toml
- src/routes/admin.ts
- src/routes/questions.ts
- src/routes/activation.ts

Read the 3 detailed Explorer handoffs before implementing:
1. c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_remed_1\handoff.md
2. c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_remed_2\handoff.md
3. c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_remed_3\handoff.md

Your tasks:
1. CRIT-1: In test/tier2-boundaries/01-input-validation.test.ts line 45, change expect(data.detail).toContain('6') to expect(data.detail).toContain('10').
2. HIGH-3: In src/routes/students.ts, protect GET /leaderboard with requireAuth (ensure it is mounted after studentsRouter.use('*', requireAuth) or has requireAuth middleware).
3. FB-01: In src/routes/auth.ts, in POST /firebase/verify (after token verification), add domainAllowed check:
   if (!domainAllowed(fbUser.email, c.env.ALLOWED_UNIVERSITY_DOMAINS ?? '')) {
     return c.json({ detail: 'نطاق البريد الإلكتروني غير مسموح به في النظام' }, 403);
   }
4. FB-02 & FB-03: In src/routes/auth.ts, in POST /firebase/verify, when linking an existing account:
   - If user lacks photo_url and fbUser.photoUrl exists, update photo_url.
   - Refetch user row from DB via db.select().from(schema.users)... rather than mutating in-memory user.
5. FB-04: In wrangler.toml, add explanatory comment above BOOTSTRAP_ADMIN_EMAIL that it must be migrated to wrangler secret put in production.
6. HIGH-1: In src/routes/admin.ts:
   - GET /professors: eliminate N+1 loop using leftJoin with professorProfiles and subjects.
   - GET /resellers/:reseller_id/codes: eliminate N+1 loop using leftJoin with subjects.
   - GET /bans: eliminate N+1 loop using leftJoin with users.
7. HIGH-2: In src/routes/admin.ts, GET /overview:
   - Replace full table scans with direct SQL aggregates (COUNT(*), SUM(total), etc.) via c.env.DB.batch([...]). Follow Explorer 2's blueprint with defensive fallback so both production D1 and test mock work seamlessly.
8. HIGH-4: In src/routes/admin.ts around line 296, replace Math.random() banId with schema.genId().
9. HIGH-5: In src/routes/admin.ts, GET /users: add limit and offset pagination (default: limit=50, offset=0, max limit=200).
10. MED-3: In src/routes/questions.ts: add sql to drizzle-orm import and add .orderBy(sql`RANDOM()`) to GET /daily candidate query.
11. MED-6: In src/routes/activation.ts: in code.status === 'active' branch, implement the MAX_FAILED_REDEEMS lockout logic matching the invalid code branch.

After applying the changes:
1. Run: cmd /c "npm run typecheck" — must have 0 errors.
2. Run: cmd /c "npm test" — must have 0 failures (565/565 passing).
3. Document all changes and test results in c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_worker_remed_1\handoff.md.
4. Send a message to parent with the handoff path.
