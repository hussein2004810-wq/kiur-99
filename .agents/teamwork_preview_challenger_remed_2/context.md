# Challenger Remed 2 Context
Empirically stress-test security boundaries, activation lockout, banId format, and domain validation:
- src/routes/students.ts (HIGH-3: requireAuth on GET /leaderboard)
- src/routes/activation.ts (MED-6: lockout on already active codes after 5 attempts)
- src/routes/auth.ts (FB-01: domain restriction on /firebase/verify, FB-02 & FB-03: user refetch & photo_url)
- src/routes/admin.ts (HIGH-4: banId crypto UUID)
- test/tier2-boundaries/01-input-validation.test.ts (CRIT-1: 10 chars password policy)
Worker Handoff: .agents/teamwork_preview_worker_remed_1/handoff.md
