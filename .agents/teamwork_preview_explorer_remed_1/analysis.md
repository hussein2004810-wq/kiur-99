# Production-Ready Code Blueprint: Remediation Batch 1
**Target Items**: CRIT-1, HIGH-3, FB-01, FB-02, FB-03, FB-04  
**Date**: 2026-09-24 / 2026-09-25  
**Author**: Explorer Remed 1  
**Integrity Mode**: Development / Read-Only Investigation  

---

## Executive Summary
This document provides exact, production-ready implementation blueprints for the six assigned remediation tasks (CRIT-1, HIGH-3, FB-01, FB-02, FB-03, FB-04). Each blueprint contains exact file paths, line references, full code context, before-and-after diffs, rationale, type safety verifications, and downstream impact analyses.

---

## 1. CRIT-1: Password Validation Boundary Test Alignment

### 1.1 Target File & Location
- **Target File**: `test/tier2-boundaries/01-input-validation.test.ts`
- **Location**: Line 39–46 (specifically assertion at line 45)

### 1.2 Current Implementation
```typescript
  it('B1.4 should return 400 on register with password shorter than 6 characters', async () => {
    const res = await apiRequest(app, 'POST', '/auth/register', {
      body: { email: 'val2@test.com', full_name: 'علي', password: '123' },
    }, ctx);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('6');
  });
```

### 1.3 Problem Analysis
- In `src/routes/auth.ts` (lines 62, 74–82):
  ```typescript
  const MIN_PASSWORD_LENGTH = 10;
  const MAX_PASSWORD_LENGTH = 128;
  ...
  function passwordPolicyError(password: unknown): string | null {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return `كلمة المرور يجب أن تكون ${MIN_PASSWORD_LENGTH} أحرف على الأقل`;
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      return `كلمة المرور يجب ألا تتجاوز ${MAX_PASSWORD_LENGTH} حرفًا`;
    }
    return null;
  }
  ```
- In `test/harness/contract-router.ts` (lines 92–95):
  ```typescript
  if (password.length < 10 || password.length > 128) {
    return c.json({ detail: 'كلمة المرور يجب أن تكون بين 10 و128 حرفًا' }, 400);
  }
  ```
- Both the production router and test contract router enforce a minimum password length of **10 characters**, returning `'كلمة المرور يجب أن تكون بين 10 و128 حرفًا'`.
- Test `B1.4` asserts `expect(data.detail).toContain('6')`, which causes an assertion failure:
  `AssertionError: expected 'كلمة المرور يجب أن تكون بين 10 و128 ح…' to contain '6'`.

### 1.4 Production-Ready Code Blueprint
Update line 39 and line 45 in `test/tier2-boundaries/01-input-validation.test.ts`:

```diff
--- a/test/tier2-boundaries/01-input-validation.test.ts
+++ b/test/tier2-boundaries/01-input-validation.test.ts
@@ -39,7 +39,7 @@ describe('Tier 2: Boundary 1 - Input Validation & Malformed Payloads', () => {
-  it('B1.4 should return 400 on register with password shorter than 6 characters', async () => {
+  it('B1.4 should return 400 on register with password shorter than 10 characters', async () => {
     const res = await apiRequest(app, 'POST', '/auth/register', {
       body: { email: 'val2@test.com', full_name: 'علي', password: '123' },
     }, ctx);
     expect(res.status).toBe(400);
     const data = await res.json();
-    expect(data.detail).toContain('6');
+    expect(data.detail).toContain('10');
   });
```

---

## 2. HIGH-3: Protect GET /leaderboard with requireAuth

### 2.1 Target File & Location
- **Target File**: `src/routes/students.ts`
- **Location**: Lines 44–60

### 2.2 Current Implementation
```typescript
// GET /api/students/leaderboard — public
studentsRouter.get('/leaderboard', async (c) => {
  const res = await c.env.DB.prepare(`
    SELECT u.id, u.full_name, COUNT(sa.id) as answers_count, SUM(sa.is_correct) as score
    FROM users u
    LEFT JOIN student_answers sa ON u.id = sa.user_id
    WHERE u.role = 'student'
    GROUP BY u.id
    ORDER BY score DESC
    LIMIT 20
  `).all();
  const ranked = ((res.results ?? []) as any[]).map((r, i) => ({ ...r, rank: i + 1 }));
  return c.json(ranked);
});

studentsRouter.use('*', requireAuth);

// GET /api/students — search with pagination and privacy protection
studentsRouter.get('/', async (c) => {
```

### 2.3 Problem Analysis
- In Hono, middleware executes in the sequence of route registration.
- Because `studentsRouter.get('/leaderboard', ...)` is mounted before `studentsRouter.use('*', requireAuth)`, requests to `/api/students/leaderboard` bypass authentication completely.
- This leaks student IDs, names, answer counts, and academic scores to unauthenticated external clients.

### 2.4 Production-Ready Code Blueprint
Move `studentsRouter.use('*', requireAuth);` above the `/leaderboard` handler and mark the handler with explicit `requireAuth` protection:

```diff
--- a/src/routes/students.ts
+++ b/src/routes/students.ts
@@ -42,6 +42,8 @@ async function canViewStudentProfile(
   return false;
 }
 
+studentsRouter.use('*', requireAuth);
+
-// GET /api/students/leaderboard — public
-studentsRouter.get('/leaderboard', async (c) => {
+// GET /api/students/leaderboard — protected
+studentsRouter.get('/leaderboard', requireAuth, async (c) => {
   const res = await c.env.DB.prepare(`
     SELECT u.id, u.full_name, COUNT(sa.id) as answers_count, SUM(sa.is_correct) as score
     FROM users u
     LEFT JOIN student_answers sa ON u.id = sa.user_id
     WHERE u.role = 'student'
     GROUP BY u.id
     ORDER BY score DESC
     LIMIT 20
   `).all();
   const ranked = ((res.results ?? []) as any[]).map((r, i) => ({ ...r, rank: i + 1 }));
   return c.json(ranked);
 });
 
-studentsRouter.use('*', requireAuth);
 
 // GET /api/students — search with pagination and privacy protection
 studentsRouter.get('/', async (c) => {
```

### 2.5 Downstream Considerations & Test Alignment
- In `test/tier1-features/07-students-skills.test.ts` (line 141), test 7.10 tests the contract router:
  `const res = await apiRequest(app, 'GET', '/api/students/leaderboard', {}, ctx);`
  The default test harness runs against `contract-router.ts`.
- If end-to-end integration tests are later run directly against `src/index.ts` (`TEST_TARGET=src`), test 7.10 will properly supply `{ token: ctx.fixtures.users.student.token }`.

---

## 3. FB-01: University Domain Whitelist Check in Firebase Verify

### 3.1 Target File & Location
- **Target File**: `src/routes/auth.ts`
- **Location**: Inside `authRouter.post('/firebase/verify', ...)`, lines 543–546

### 3.2 Current Implementation
```typescript
  // 2. Server-side token verification
  let fbUser;
  try {
    fbUser = await verifyFirebaseGoogleToken(c.env, idToken);
  } catch (err: any) {
    if (err instanceof FirebaseAuthError) {
      return c.json({ detail: err.message, code: err.code }, err.statusCode as any);
    }
    console.error(JSON.stringify({ event: 'FIREBASE_IDENTITY_VERIFICATION_FAILED', category: 'unexpected' }));
    return c.json({ detail: 'فشل التحقق من هوية Google' }, 500);
  }

  const db = drizzle(c.env.DB, { schema });
```

### 3.3 Problem Analysis
- In standard registration (`POST /auth/register`, line 743) and Google Identity verification (`POST /auth/google/verify`, line 260), the backend validates:
  ```typescript
  if (!domainAllowed(email, c.env.ALLOWED_UNIVERSITY_DOMAINS ?? '')) {
    return c.json({ detail: 'نطاق البريد الإلكتروني غير مسموح به في النظام' }, 403);
  }
  ```
- In `POST /auth/firebase/verify`, this check was omitted. Any user possessing an arbitrary Google account (e.g. `@gmail.com`) could bypass domain restrictions when `ALLOWED_UNIVERSITY_DOMAINS` is set.

### 3.4 Production-Ready Code Blueprint
Add the `domainAllowed` verification immediately after `verifyFirebaseGoogleToken` resolves:

```diff
--- a/src/routes/auth.ts
+++ b/src/routes/auth.ts
@@ -542,6 +542,10 @@ authRouter.post('/firebase/verify', firebaseAuthRateLimiter, async (c) => {
     return c.json({ detail: 'فشل التحقق من هوية Google' }, 500);
   }
 
+  if (!domainAllowed(fbUser.email, c.env.ALLOWED_UNIVERSITY_DOMAINS ?? '')) {
+    return c.json({ detail: 'نطاق البريد الإلكتروني غير مسموح به في النظام' }, 403);
+  }
+
   const db = drizzle(c.env.DB, { schema });
   const ip = c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1';
   const userAgent = c.req.header('user-agent');
```

---

## 4. FB-02 & FB-03: Safe Account Linking & Avatar Synchronization in Firebase Verify

### 4.1 Target File & Location
- **Target File**: `src/routes/auth.ts`
- **Location**: Inside `authRouter.post('/firebase/verify', ...)`, lines 556–574

### 4.2 Current Implementation
```typescript
  if (!user) {
    user = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, fbUser.email))
      .get();

    if (user) {
      // Link existing user
      await db
        .update(schema.users)
        .set({
          firebase_uid: fbUser.uid,
          email_verified_at: user.email_verified_at || new Date().toISOString(),
        })
        .where(eq(schema.users.id, user.id));
      user.firebase_uid = fbUser.uid;
    }
  }
```

### 4.3 Problem Analysis
1. **FB-02 (Local Mutation Bug)**: Mutating `user.firebase_uid = fbUser.uid` directly on the local in-memory object leaves other columns stale and risks discrepancy with the database state. Downstream checks (such as bootstrap admin assignment, role elevation, and `userOut(user)`) should operate on the authoritative row fetched from SQLite.
2. **FB-03 (Missing Avatar Synchronization)**: In `/google/verify` (lines 269–274), when an existing account is linked, any missing avatar (`photo_url`) is populated from Google. In Firebase verify, `fbUser.photoUrl` was ignored when linking existing accounts, leaving the user with an empty avatar.

### 4.4 Production-Ready Code Blueprint
Update the account linking block to construct a type-safe `patch` object, populate `photo_url` if empty, execute the database UPDATE, and refetch the authoritative user record:

```diff
--- a/src/routes/auth.ts
+++ b/src/routes/auth.ts
@@ -563,13 +563,18 @@ authRouter.post('/firebase/verify', firebaseAuthRateLimiter, async (c) => {
     if (user) {
       // Link existing user
+      const patch: Partial<typeof schema.users.$inferInsert> = {
+        firebase_uid: fbUser.uid,
+        email_verified_at: user.email_verified_at || new Date().toISOString(),
+      };
+      if (!user.photo_url && fbUser.photoUrl) {
+        patch.photo_url = fbUser.photoUrl;
+      }
       await db
         .update(schema.users)
-        .set({
-          firebase_uid: fbUser.uid,
-          email_verified_at: user.email_verified_at || new Date().toISOString(),
-        })
+        .set(patch)
         .where(eq(schema.users.id, user.id));
-      user.firebase_uid = fbUser.uid;
+      user = (await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get())!;
     }
   }
```

### 4.5 Type & Schema Verification
- `schema.users.photo_url`: defined as `text('photo_url')` in `src/db/schema.ts` (line 196).
- `fbUser.photoUrl`: defined as `photoUrl?: string` on `FirebaseVerifiedUser` in `src/services/firebase.ts` (line 9).
- `Partial<typeof schema.users.$inferInsert>`: standard Drizzle ORM typing used consistently in `src/routes/auth.ts` (e.g. lines 267 and 380).
- The non-null assertion `!` on the refetch is safe because the row was just matched and updated by primary key `id`.

---

## 5. FB-04: Secret Migration Explanatory Comment in wrangler.toml

### 5.1 Target File & Location
- **Target File**: `wrangler.toml`
- **Location**: Under `[vars]`, lines 29–35

### 5.2 Current Implementation
```toml
# Environment Variables ([vars] accessible via c.env)
[vars]
DEBUG = "false"
# Production JWT_SECRET must be configured securely via `wrangler secret put JWT_SECRET`.
# Never store production secrets in plaintext in version control.
JWT_ALGORITHM = "HS256"
JWT_EXPIRES_MINUTES = "20160"
BOOTSTRAP_ADMIN_EMAIL = "hussein2004810@gmail.com"
# The public Worker serves both the SPA and API on this same origin.  Keep CORS
# explicit in production; add custom domains here when they are provisioned.
CORS_ORIGINS = "https://kiur-99.hussein2004810.workers.dev"
```

### 5.3 Problem Analysis
- `BOOTSTRAP_ADMIN_EMAIL` designates the initial platform administrator during first sign-in.
- Storing administrator email identifiers in plaintext version control violates operational security best practices.
- Similar to `JWT_SECRET`, an operator deploying to production must store this value using `wrangler secret put BOOTSTRAP_ADMIN_EMAIL` to prevent credential exposure.

### 5.4 Production-Ready Code Blueprint
Add an explanatory comment directly above `BOOTSTRAP_ADMIN_EMAIL`:

```diff
--- a/wrangler.toml
+++ b/wrangler.toml
@@ -30,6 +30,8 @@ DEBUG = "false"
 # Never store production secrets in plaintext in version control.
 JWT_ALGORITHM = "HS256"
 JWT_EXPIRES_MINUTES = "20160"
+# In real production, BOOTSTRAP_ADMIN_EMAIL must be migrated to a Cloudflare secret
+# via `wrangler secret put BOOTSTRAP_ADMIN_EMAIL` rather than committed in plaintext.
 BOOTSTRAP_ADMIN_EMAIL = "hussein2004810@gmail.com"
 # The public Worker serves both the SPA and API on this same origin.  Keep CORS
 # explicit in production; add custom domains here when they are provisioned.
```

---

## 6. Verification and Validation Plan

| ID | Verification Command / Method | Expected Result |
|----|-------------------------------|-----------------|
| CRIT-1 | `cmd /c "npx vitest run test/tier2-boundaries/01-input-validation.test.ts"` | Test B1.4 passes; all tests in suite pass. |
| HIGH-3 | `cmd /c "npm run typecheck"` & route inspection | TypeScript compiles with 0 errors. Unauthenticated GET to `/api/students/leaderboard` returns 401. |
| FB-01 | Unit test / integration request with unapproved domain to `/auth/firebase/verify` | Returns HTTP 403 with `detail: 'نطاق البريد الإلكتروني غير مسموح به في النظام'`. |
| FB-02 | Route execution / inspect returned user object after linking | `user` contains DB-hydrated columns; no local object mutation. |
| FB-03 | Firebase verify linking with account possessing empty `photo_url` | DB record has `photo_url` populated from `fbUser.photoUrl`. |
| FB-04 | File inspection of `wrangler.toml` | Syntax valid TOML with clear operational documentation. |
| Overall Suite | `cmd /c "npm test"` | 565/565 tests passing (0 failures). |
| Overall Types | `cmd /c "npm run typecheck"` | 0 TypeScript errors. |
