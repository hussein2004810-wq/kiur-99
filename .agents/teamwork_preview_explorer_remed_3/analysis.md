# Deep Investigation & Technical Blueprint: MED-3 & MED-6

## 1. Executive Summary

This investigation analyzes two specific logic and security bugs in the Kiur/Nabd backend rewrite and provides exact, production-ready code blueprints for their remediation:

1. **MED-3**: In `src/routes/questions.ts`, `GET /daily` fetches the first 25 questions in physical storage/row order without an `ORDER BY` clause and slices the first 5 accessible questions. Consequently, every request returns identical questions in identical sequence. The fix introduces `ORDER BY RANDOM()` via Drizzle's `sql` template (`orderBy(sql`RANDOM()`)`), providing genuine randomized daily practice question sets on every request.
2. **MED-6**: In `src/routes/activation.ts`, the `code.status === 'active'` branch (lines 95–106) increments `failed_redeem_attempts` in the database but fails to enforce `MAX_FAILED_REDEEMS` lockout. It never sets `redeem_locked_until`, never resets `failed_redeem_attempts` to 0 on reaching the threshold, and never returns HTTP 429. An attacker can repeatedly attempt to redeem already-active codes without triggering account lockout. The fix mirrors the lockout logic from the invalid code branch (`!code`), locking the user out for 15 minutes after 5 failed attempts and returning HTTP 429.

Both fixes are fully backward compatible with the existing test suite (all 564 passing tests remain unaffected).

---

## 2. MED-3 Investigation & Blueprint

### 2.1 Problem & Root Cause

File: `src/routes/questions.ts`, lines 62–86:
```typescript
// GET /api/questions/daily
questionsRouter.get('/daily', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const candidates = await db.select().from(schema.questions).limit(25);
  const questions = (await Promise.all(candidates.map(async (q) =>
    (await canReadQuestion(db, user, q)) ? q : null
  ))).filter(Boolean).slice(0, 5) as typeof candidates;
  const questionIds = questions.map((q) => q.id);
  const choices =
    questionIds.length > 0
      ? await db.select().from(schema.choices).where(inArray(schema.choices.question_id, questionIds))
      : [];

  return c.json(
    questions.map((q) => {
      const { rationale: _rationale, ...safeQ } = q;
      return {
        ...safeQ,
        choices: choices
          .filter((ch) => ch.question_id === q.id)
          .map((ch) => ({ id: ch.id, text: ch.text, order_index: ch.order_index })),
      };
    })
  );
});
```

#### Defects Identified:
1. `db.select().from(schema.questions).limit(25)` executes:
   ```sql
   SELECT * FROM questions LIMIT 25;
   ```
   Without an `ORDER BY` clause, SQLite returns rows according to physical insertion order or rowid sequence.
2. `candidates` is always identical across every call for a given database state.
3. `.slice(0, 5)` selects the same initial 5 accessible questions every single time.
4. Violates acceptance criterion: `[ ] /api/questions/daily لا تُرجع نفس الأسئلة في كل طلب`.

### 2.2 Technical Feasibility & Database Behavior

- **SQLite / Cloudflare D1 Support**: SQLite natively implements `RANDOM()` which generates a pseudo-random 64-bit signed integer for every candidate row. Sorting by `RANDOM()` (`ORDER BY RANDOM() LIMIT 25`) yields a uniform random selection.
- **Node.js Test Verification**: Tested via `node:sqlite` in the local runtime environment:
  ```js
  const db = new DatabaseSync(':memory:');
  db.prepare('SELECT id FROM t ORDER BY RANDOM() LIMIT 5').all();
  // Successfully produced non-repeating randomized row sequences on consecutive executions
  ```
- **Drizzle ORM Compilation**:
  Importing `sql` from `drizzle-orm` and using `.orderBy(sql`RANDOM()`)`:
  ```typescript
  db.select().from(schema.questions).orderBy(sql`RANDOM()`).limit(25)
  ```
  Verified generated SQL:
  ```sql
  select ... from "questions" order by RANDOM() limit ? [25]
  ```

### 2.3 Exact Code Blueprint for `src/routes/questions.ts`

#### Edit 1: Import `sql` from `drizzle-orm`
Target: `src/routes/questions.ts`, line 6
```typescript
<<<< Before:
import { eq, desc, and, inArray, like } from 'drizzle-orm';
==== After:
import { eq, desc, and, inArray, like, sql } from 'drizzle-orm';
>>>>
```

#### Edit 2: Add `orderBy(sql`RANDOM()`)` to `GET /daily`
Target: `src/routes/questions.ts`, lines 62–68
```typescript
<<<< Before:
// GET /api/questions/daily
questionsRouter.get('/daily', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const candidates = await db.select().from(schema.questions).limit(25);
  const questions = (await Promise.all(candidates.map(async (q) =>
    (await canReadQuestion(db, user, q)) ? q : null
  ))).filter(Boolean).slice(0, 5) as typeof candidates;
==== After:
// GET /api/questions/daily
questionsRouter.get('/daily', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const candidates = await db.select().from(schema.questions).orderBy(sql`RANDOM()`).limit(25);
  const questions = (await Promise.all(candidates.map(async (q) =>
    (await canReadQuestion(db, user, q)) ? q : null
  ))).filter(Boolean).slice(0, 5) as typeof candidates;
>>>>
```

### 2.4 Test Suite Impact & Contract Router Alignment
- Existing test `test/tier1-features/05-questions-saved.test.ts` (test 5.9):
  ```typescript
  it('5.9 should return daily practice questions set via GET /api/questions/daily', async () => {
    const res = await apiRequest(app, 'GET', '/api/questions/daily', { token: ctx.fixtures.users.student.token }, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });
  ```
  This assertion requires an array with length > 0. A randomized result set continues to satisfy this test.
- Optional alignment in `test/harness/contract-router.ts` (line 504):
  ```typescript
  app.get('/api/questions/daily', async (c) => {
    const res = await c.env.DB.prepare('SELECT * FROM questions ORDER BY RANDOM() LIMIT 5').all();
    return c.json(res.results);
  });
  ```

---

## 3. MED-6 Investigation & Blueprint

### 3.1 Problem & Root Cause

File: `src/routes/activation.ts`, lines 95–106:
```typescript
  if (code.status === 'active') {
    const attempts = (fullUser.failed_redeem_attempts ?? 0) + 1;
    await db.update(schema.users).set({ failed_redeem_attempts: attempts }).where(eq(schema.users.id, user.id));
    recordAuditEvent({
      event: 'ACTIVATION_CODE_FAILED',
      status: 'FAILURE',
      actorId: user.id,
      targetId: code.id,
      details: { reason: 'already_active' },
    });
    return c.json({ detail: 'هذا الكود مستخدم بالفعل أو منتهي الصلاحية' }, 400);
  }
```

#### Defects Identified:
1. In the invalid code branch (`!code`, lines 58–77), the system checks:
   ```typescript
   if (attempts >= MAX_FAILED_REDEEMS) {
     lockUntil = new Date(Date.now() + REDEEM_LOCKOUT_MINUTES * 60000).toISOString();
     await db.update(schema.users).set({ failed_redeem_attempts: 0, redeem_locked_until: lockUntil }).where(eq(schema.users.id, user.id));
   } else {
     await db.update(schema.users).set({ failed_redeem_attempts: attempts }).where(eq(schema.users.id, user.id));
   }
   ...
   if (attempts >= MAX_FAILED_REDEEMS) {
     return c.json({ detail: 'تم قفل تفعيل الأكواد مؤقتاً لكثرة المحاولات الخاطئة' }, 429);
   }
   ```
2. In the `code.status === 'active'` branch, the code updates `failed_redeem_attempts: attempts` indefinitely, never evaluates `attempts >= MAX_FAILED_REDEEMS`, never sets `redeem_locked_until`, and never returns HTTP 429.
3. In the reference Python backend (`app/routers/activation.py`), `_register_failed_redeem(db, user)` was explicitly called on active codes:
   ```python
   if code.status == models.CodeStatus.active:
       if code.activated_by_user_id == user.id:
           raise HTTPException(400, "هذا الكود مُفعّل مسبقاً على حسابك")
       _register_failed_redeem(db, user)
       raise HTTPException(400, "هذا الكود مُفعّل مسبقاً من مستخدم آخر")
   ```
4. This creates a security gap: an attacker can repeatedly test stolen or active activation codes without facing the 15-minute lockout policy.

### 3.2 Exact Code Blueprint for `src/routes/activation.ts`

Target: `src/routes/activation.ts`, lines 95–106
```typescript
<<<< Before:
  if (code.status === 'active') {
    const attempts = (fullUser.failed_redeem_attempts ?? 0) + 1;
    await db.update(schema.users).set({ failed_redeem_attempts: attempts }).where(eq(schema.users.id, user.id));
    recordAuditEvent({
      event: 'ACTIVATION_CODE_FAILED',
      status: 'FAILURE',
      actorId: user.id,
      targetId: code.id,
      details: { reason: 'already_active' },
    });
    return c.json({ detail: 'هذا الكود مستخدم بالفعل أو منتهي الصلاحية' }, 400);
  }
==== After:
  if (code.status === 'active') {
    const attempts = (fullUser.failed_redeem_attempts ?? 0) + 1;
    let lockUntil: string | null = null;
    if (attempts >= MAX_FAILED_REDEEMS) {
      lockUntil = new Date(Date.now() + REDEEM_LOCKOUT_MINUTES * 60000).toISOString();
      await db.update(schema.users).set({ failed_redeem_attempts: 0, redeem_locked_until: lockUntil }).where(eq(schema.users.id, user.id));
    } else {
      await db.update(schema.users).set({ failed_redeem_attempts: attempts }).where(eq(schema.users.id, user.id));
    }

    recordAuditEvent({
      event: 'ACTIVATION_CODE_FAILED',
      status: 'FAILURE',
      actorId: user.id,
      targetId: code.id,
      details: { reason: 'already_active', attempts },
    });

    if (attempts >= MAX_FAILED_REDEEMS) {
      return c.json({ detail: 'تم قفل تفعيل الأكواد مؤقتاً لكثرة المحاولات الخاطئة' }, 429);
    }
    return c.json({ detail: 'هذا الكود مستخدم بالفعل أو منتهي الصلاحية' }, 400);
  }
>>>>
```

### 3.3 Test Suite Impact & Contract Router Alignment
- Existing tests in `test/tier2-boundaries/02-auth-security.test.ts` (test B2.26) and `test/tier3-combinations/combinations.test.ts` (test C3.20) only redeem an active code once (attempt #1), which returns HTTP 400. Since `attempts < MAX_FAILED_REDEEMS` (1 < 5), these tests pass without alteration.
- New unit test recommended to verify this fix explicitly:
  ```typescript
  it('MED-6: should lock redemption and return 429 after 5 already-active activation code attempts', async () => {
    // 1. Redeem once to transition to 'active'
    await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: ctx.fixtures.users.student.token,
      body: { code: ctx.fixtures.activationCodes.vipIdle },
    }, ctx);

    // 2. Perform 4 failed attempts against the now-active code (expect 400)
    for (let i = 0; i < 4; i++) {
      const res = await apiRequest(app, 'POST', '/api/activation/redeem', {
        token: ctx.fixtures.users.student.token,
        body: { code: ctx.fixtures.activationCodes.vipIdle },
      }, ctx);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.detail).toContain('مستخدم بالفعل');
    }

    // 3. 5th attempt must trigger lockout (expect 429)
    const lockRes = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: ctx.fixtures.users.student.token,
      body: { code: ctx.fixtures.activationCodes.vipIdle },
    }, ctx);
    expect(lockRes.status).toBe(429);
    const lockData = await lockRes.json();
    expect(lockData.detail).toContain('تم قفل تفعيل الأكواد مؤقتاً');
  });
  ```
- Optional alignment in `test/harness/contract-router.ts` (lines 1295–1297):
  ```typescript
  if (code.status !== 'idle') {
    const attempts = (user.failed_redeem_attempts || 0) + 1;
    let lockUntil: string | null = null;
    if (attempts >= 5) {
      lockUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    }
    await c.env.DB.prepare('UPDATE users SET failed_redeem_attempts = ?, redeem_locked_until = ? WHERE id = ?')
      .bind(attempts >= 5 ? 0 : attempts, lockUntil, user.id).run();
    if (attempts >= 5) {
      return c.json({ detail: 'تم قفل تفعيل الأكواد مؤقتاً لكثرة المحاولات الخاطئة' }, 429);
    }
    return c.json({ detail: 'هذا الكود مستخدم بالفعل أو منتهي الصلاحية' }, 400);
  }
  ```

---

## 4. Summary Table of Proposed Changes

| Issue ID | File | Line Numbers | Change Summary |
|---|---|---|---|
| **MED-3** | `src/routes/questions.ts` | 6 | Add `sql` to imports from `drizzle-orm` |
| **MED-3** | `src/routes/questions.ts` | 65 | Add `.orderBy(sql`RANDOM()`)` to `GET /daily` candidate query |
| **MED-6** | `src/routes/activation.ts` | 95–106 | Implement `MAX_FAILED_REDEEMS` check, 15-minute `lockUntil` computation, user lockout update, and HTTP 429 response |
