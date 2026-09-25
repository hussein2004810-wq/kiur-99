# Handoff Report: Remediation Blueprint for MED-3 & MED-6

**Agent**: Explorer Remed 3  
**Working Directory**: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_remed_3`  
**Handoff Type**: Hard (Investigation & Technical Blueprint Complete)  
**Related Documents**:
- Technical Blueprint & Root Cause Analysis: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_remed_3\analysis.md`
- Machine-Applicable Patch: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_remed_3\remediation.patch`

---

## 1. Observation

### 1.1 MED-3: In `src/routes/questions.ts`, `GET /daily` Lacks Random Ordering
- **File**: `src/routes/questions.ts`, line 6
  ```typescript
  import { eq, desc, and, inArray, like } from 'drizzle-orm';
  ```
  `sql` is not imported from `drizzle-orm`.
- **File**: `src/routes/questions.ts`, lines 62–68
  ```typescript
  // GET /api/questions/daily
  questionsRouter.get('/daily', async (c) => {
    const db = drizzle(c.env.DB, { schema });
    const user = c.get('user')!;
    const candidates = await db.select().from(schema.questions).limit(25);
    const questions = (await Promise.all(candidates.map(async (q) =>
      (await canReadQuestion(db, user, q)) ? q : null
    ))).filter(Boolean).slice(0, 5) as typeof candidates;
  ```
- **Observed Behavior**: `db.select().from(schema.questions).limit(25)` executes `SELECT * FROM questions LIMIT 25;` without an `ORDER BY` clause. In SQLite/D1, rows are returned in primary key/rowid order. As a result, `.slice(0, 5)` returns the identical set of 5 questions in the exact same order on every request.
- **D1 / SQLite Verification**: Ran SQLite test in `node:sqlite`:
  ```bash
  node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE t (id INT); INSERT INTO t VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10);'); console.log(db.prepare('SELECT id FROM t ORDER BY RANDOM() LIMIT 5').all());"
  ```
  Confirmed that `ORDER BY RANDOM()` is natively supported and produces varying pseudo-random row sets.
- **Drizzle SQL Compilation**: Verified with Drizzle ORM that `orderBy(sql`RANDOM()`)` compiles cleanly to:
  `select ... from "questions" order by RANDOM() limit ?` with parameter `[ 25 ]`.

### 1.2 MED-6: In `src/routes/activation.ts`, Active Code Branch Lacks Lockout Logic
- **File**: `src/routes/activation.ts`, lines 95–106:
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
- **Comparison with Invalid Code Branch** (`src/routes/activation.ts`, lines 58–77):
  ```typescript
  // Register failed attempt
  const attempts = (fullUser.failed_redeem_attempts ?? 0) + 1;
  let lockUntil: string | null = null;
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
- **Observed Behavior**: The `code.status === 'active'` branch updates `failed_redeem_attempts: attempts` without checking if `attempts >= MAX_FAILED_REDEEMS`. It never sets `redeem_locked_until`, never resets `failed_redeem_attempts` to 0, and never returns HTTP 429. An attacker can repeatedly attempt to redeem active codes without triggering an account lockout.
- **Python Reference**: In `app/routers/activation.py` lines 59–64:
  ```python
  if code.status == models.CodeStatus.active:
      if code.activated_by_user_id == user.id:
          raise HTTPException(400, "هذا الكود مُفعّل مسبقاً على حسابك")
      _register_failed_redeem(db, user)
      raise HTTPException(400, "هذا الكود مُفعّل مسبقاً من مستخدم آخر")
  ```
  The Python reference explicitly registered failed attempts triggering `user.redeem_locked_until = datetime.utcnow() + timedelta(minutes=REDEEM_LOCKOUT_MINUTES)`.

### 1.3 Test Suite Baseline
- `cmd /c "npm test"`: 41 test files, 565 tests total (564 passed, 1 failed — CRIT-1 in `test/tier2-boundaries/01-input-validation.test.ts:45`).
- `cmd /c "npm run typecheck"`: Exited with code 0 (clean TypeScript build).

---

## 2. Logic Chain

1. **Root Cause MED-3**:
   - `src/routes/questions.ts:65` queries questions without ordering, yielding the same 25 candidates on every invocation.
   - Slicing the first 5 readable questions (`.slice(0, 5)`) yields identical questions across requests.
   - Adding `.orderBy(sql`RANDOM()`)` to the candidate query randomizes the sample at the database level before access filtering and slicing.
   - Therefore, successive requests return varied question sets, satisfying acceptance criterion: `[ ] /api/questions/daily لا تُرجع نفس الأسئلة في كل طلب`.

2. **Root Cause MED-6**:
   - `src/routes/activation.ts:95-106` increments `failed_redeem_attempts` but lacks the branch `if (attempts >= MAX_FAILED_REDEEMS)`.
   - Applying the identical lockout logic as `!code` ensures that after 5 failed redemptions of already-active codes:
     1. `lockUntil` is calculated 15 minutes into the future (`REDEEM_LOCKOUT_MINUTES * 60000`).
     2. `schema.users` is updated with `failed_redeem_attempts: 0` and `redeem_locked_until: lockUntil`.
     3. An audit log is written with `reason: 'already_active', attempts`.
     4. An HTTP 429 response is returned with `{ detail: 'تم قفل تفعيل الأكواد مؤقتاً لكثرة المحاولات الخاطئة' }`.
   - Subsequent requests within the 15-minute window are caught by the existing lockout guard (lines 31–42), returning HTTP 429.
   - Therefore, brute-forcing already-active codes is mitigated and the acceptance criterion `[ ] في activation.ts، كود already_active يُطبّق lockout بعد تجاوز MAX_FAILED_REDEEMS` is fully met.

---

## 3. Caveats

1. **`code.status === 'expired'` branch**: In `src/routes/activation.ts` lines 84–93, expired codes do not increment `failed_redeem_attempts`. This strictly matches the Python reference (`app/routers/activation.py:57-58`) and the prompt scope ("in the code.status === 'active' branch (lines 95-106)"). If desired in a future security enhancement, this can be unified.
2. **Contract Router (`test/harness/contract-router.ts`)**: The test harness mock router contains hardcoded `SELECT * FROM questions LIMIT 5` (line 504) and `if (code.status !== 'idle')` (lines 1295–1297). While tests run by default against the contract router, running with `TEST_TARGET=src` tests the real routes in `src/`. For complete consistency, `contract-router.ts` can optionally receive the same changes.
3. **Small Database In Test Environment**: In tests with only 5 questions in the database, `ORDER BY RANDOM()` randomizes the presentation order of those 5 questions. In production with hundreds of questions, it selects 5 random questions out of a randomized 25-candidate pool.

---

## 4. Conclusion & Actionable Code Blueprint

The implementer agent should apply the following precise edits (also available in `.agents/teamwork_preview_explorer_remed_3/remediation.patch`):

### Blueprint 1: `src/routes/questions.ts`
1. Line 6: Add `sql` to drizzle-orm import:
   ```typescript
   import { eq, desc, and, inArray, like, sql } from 'drizzle-orm';
   ```
2. Line 65: Update `GET /daily` candidate query to order by random:
   ```typescript
   const candidates = await db.select().from(schema.questions).orderBy(sql`RANDOM()`).limit(25);
   ```

### Blueprint 2: `src/routes/activation.ts`
Replace lines 95–106 with:
```typescript
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
```

---

## 5. Verification Method

### 5.1 Verification Commands
Execute in project root:
1. **Typecheck**:
   ```powershell
   cmd /c "npm run typecheck"
   ```
   *Expected outcome*: Exits with code 0 and no TypeScript errors.
2. **Targeted Test Execution against `src/`**:
   ```powershell
   cmd /c "set TEST_TARGET=src&& npx vitest run test/tier1-features/05-questions-saved.test.ts"
   cmd /c "set TEST_TARGET=src&& npx vitest run test/tier2-boundaries/02-auth-security.test.ts"
   ```
   *Expected outcome*: Tests pass with 0 failures.
3. **Full Suite Execution**:
   ```powershell
   cmd /c "npm test"
   ```
   *Expected outcome*: 564 passed tests remain passing (1 known failure on CRIT-1 in `01-input-validation.test.ts` pending CRIT-1 remediation).

### 5.2 Recommended Verification Test Case for Tester Agent
Add to `test/tier2-boundaries/02-auth-security.test.ts`:
```typescript
it('MED-6: should lock redemption and return 429 after 5 already-active activation code attempts', async () => {
  // 1. Redeem once to activate
  await apiRequest(app, 'POST', '/api/activation/redeem', {
    token: ctx.fixtures.users.student.token,
    body: { code: ctx.fixtures.activationCodes.vipIdle },
  }, ctx);

  // 2. 4 failed attempts against the active code (returns 400)
  for (let i = 0; i < 4; i++) {
    const res = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: ctx.fixtures.users.student.token,
      body: { code: ctx.fixtures.activationCodes.vipIdle },
    }, ctx);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('مستخدم بالفعل');
  }

  // 3. 5th attempt must return 429 lockout
  const lockRes = await apiRequest(app, 'POST', '/api/activation/redeem', {
    token: ctx.fixtures.users.student.token,
    body: { code: ctx.fixtures.activationCodes.vipIdle },
  }, ctx);
  expect(lockRes.status).toBe(429);
  const data = await lockRes.json();
  expect(data.detail).toContain('تم قفل تفعيل الأكواد مؤقتاً');
});
```

### 5.3 Invalidation Conditions
- If `sql` is imported from an incorrect module instead of `drizzle-orm`.
- If `attempts >= MAX_FAILED_REDEEMS` does not reset `failed_redeem_attempts` to 0 (which would cause subsequent attempts after the lock expires to lock out immediately on attempt 1).
- If the Arabic lockout message string differs from `'تم قفل تفعيل الأكواد مؤقتاً لكثرة المحاولات الخاطئة'`, breaking contract matching.
