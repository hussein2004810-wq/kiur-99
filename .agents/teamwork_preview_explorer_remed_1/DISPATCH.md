## 2026-09-24T21:57:17Z

You are Explorer Remed 1. Your working directory is c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_remed_1.

MANDATORY FIRST STEP: Read c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\ORIGINAL_REQUEST.md (specifically the section: ## Follow-up — 2026-09-24T21:54:14Z) before doing anything else.

Your objective: Investigate and produce an exact, production-ready code blueprint for:
1. CRIT-1: In test/tier2-boundaries/01-input-validation.test.ts line 45, change expect(data.detail).toContain('6') to expect(data.detail).toContain('10').
2. HIGH-3: In src/routes/students.ts, protect GET /leaderboard with requireAuth (currently exposed before wildcard auth). Check exact routing and middleware setup.
3. FB-01: In src/routes/auth.ts, in POST /firebase/verify (around line 544, after getting fbUser.email), add domainAllowed check mirroring /google/verify:
   if (!domainAllowed(fbUser.email, c.env.ALLOWED_UNIVERSITY_DOMAINS ?? '')) {
     return c.json({ detail: 'نطاق البريد الإلكتروني غير مسموح به في النظام' }, 403);
   }
4. FB-02: In src/routes/auth.ts, after account linking in Firebase route, refetch user row from DB after UPDATE instead of mutating local object.
5. FB-03: In src/routes/auth.ts, in POST /firebase/verify, when linking an existing account, update photo_url if empty (mirroring GIS route).
6. FB-04: In wrangler.toml, add an explanatory comment that BOOTSTRAP_ADMIN_EMAIL must be migrated to wrangler secret put in real production.

Inspect each file thoroughly using view_file. Verify types and imports.
DO NOT modify source files directly.
Write your detailed analysis to c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_remed_1\analysis.md.
Write your handoff report to c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_remed_1\handoff.md.
When finished, send a brief message to your parent with the handoff path.
