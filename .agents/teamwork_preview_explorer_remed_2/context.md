# Explorer Remed 2 Context: Admin Performance & Scalability
Target Files:
- src/routes/admin.ts (HIGH-1: N+1 queries in /professors, /resellers/:id/codes, /bans; HIGH-2: aggregates in /overview with DB.batch; HIGH-4: banId; HIGH-5: /users pagination)
