# Original User Request

## Initial Request — 2026-09-17T00:16:01Z

You are the Project Orchestrator for the backend rewrite project.

# Working Directory & Paths
- Your working directory: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\orchestrator
- Workspace root: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى
- Authoritative Original Request: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\ORIGINAL_REQUEST.md

# Mission
Rewrite the entire existing Python (FastAPI/SQLAlchemy) backend project into TypeScript using the Hono framework, so it can be hosted natively and completely for free on Cloudflare Workers. Maintain 100% feature parity so the existing frontend continues to work without any changes.

## Core Requirements
1. **R1. Framework Migration (FastAPI to Hono)**:
   - Translate all existing FastAPI routes, middleware (CORS, Sessions/Auth), and Pydantic schemas into TypeScript using Hono and Zod.
   - The API surface must remain exactly identical to the original so the frontend requires zero changes.
2. **R2. Database Migration (PostgreSQL to Cloudflare D1)**:
   - Replace the SQLAlchemy/PostgreSQL database layer with Cloudflare D1 (Serverless SQLite).
   - Translate the SQL schema to SQLite and update all database queries in the backend to use the D1 API (e.g., using Drizzle ORM or raw D1 binding queries).
3. **R3. Storage Migration (S3 to Cloudflare R2)**:
   - Replace the `boto3` S3 storage logic with native Cloudflare R2 bindings for handling file uploads and downloads.

## Acceptance Criteria
- Automated test suite (e.g. using Vitest or Hono testing utilities) verifying that the core migrated endpoints (Auth, Courses, etc.) return the exact same JSON structure and HTTP status codes as the original Python backend.
- `wrangler.toml` is fully configured for D1 and R2, and the project can be run successfully locally using `wrangler dev`.
- The database schema is successfully translated and applied to a local D1 database without syntax errors.

# Operational Discipline
- Maintain your `plan.md` and `progress.md` in your working directory (`c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\orchestrator`).
- Update `progress.md` regularly as milestones are achieved.
- When finished, report back with your comprehensive victory claim and handoff details.

## Follow-up — 2026-09-24T21:54:14Z

إصلاح شامل ومنظّم لجميع المشاكل المكتشفة في منصة KIUR-99 (Hono/Cloudflare Workers/D1) بناءً على تقرير الفحص الكامل. الإصلاحات تشمل ثغرات أمنية، مشاكل أداء، وأخطاء منطقية.

Working directory: c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى
Integrity mode: development

## Requirements

### R1. إصلاح الأخطاء الحرجة والعالية (Critical + High)

**CRIT-1:** في `test/tier2-boundaries/01-input-validation.test.ts` السطر 45، غيّر `expect(data.detail).toContain('6')` إلى `expect(data.detail).toContain('10')` — السياسة الأمنية تستخدم 10 أحرف كحد أدنى.

**HIGH-3:** في `src/routes/students.ts`، نقطة نهاية `/leaderboard` يجب أن تتطلب مصادقة (`requireAuth`) — حالياً تأتي قبل `studentsRouter.use('*', requireAuth)` مما يجعلها عامة.

**HIGH-4:** في `src/routes/admin.ts` السطر 296، استبدل:
```typescript
const banId = 'ban_' + Math.random().toString(36).substring(2, 10);
```
بـ:
```typescript
const banId = schema.genId();
```

**HIGH-5:** في `src/routes/admin.ts`، نقطة `GET /users` تجلب كل المستخدمين دون pagination. أضف `LIMIT` و`OFFSET` من query params (افتراضي: limit=50, offset=0, max limit=200).

**FB-01:** في `src/routes/auth.ts`، مسار `POST /firebase/verify` (حوالي السطر 544، بعد الحصول على `fbUser.email`)، أضف فحص `domainAllowed` بنفس المنطق المستخدم في `/google/verify`:
```typescript
if (!domainAllowed(fbUser.email, c.env.ALLOWED_UNIVERSITY_DOMAINS ?? '')) {
  return c.json({ detail: 'نطاق البريد الإلكتروني غير مسموح به في النظام' }, 403);
}
```

**FB-02:** في `src/routes/auth.ts`، بعد عملية ربط الحساب (account linking) في مسار Firebase، أعد جلب صف المستخدم من DB بعد الـ UPDATE بدلاً من تعديل الكائن محلياً (`user.firebase_uid = fbUser.uid`).

### R2. إصلاح مشاكل الأداء (N+1 + Full Table Scans)

**HIGH-1:** في `src/routes/admin.ts`:
- `GET /professors`: استبدل الـ loop مع `await` لكل أستاذ بجلب البيانات دفعة واحدة عبر `inArray()` أو JOIN
- `GET /resellers/:id/codes`: استبدل Promise.all/map مع استعلام لكل كود بـ JOIN أو `inArray()` لجلب أسماء المواد
- `GET /bans`: استبدل الـ loop مع استعلام لكل حظر بـ JOIN أو `inArray()`

**HIGH-2:** في `src/routes/admin.ts`، نقطة `GET /overview`:
استبدل `db.select().from(schema.users)` وما شابهه بـ aggregate queries مباشرة:
- `SELECT COUNT(*) FROM users` للإجمالي
- `SELECT COUNT(*) FROM users WHERE role='student'` للطلاب  
- `SELECT SUM(total) FROM orders WHERE status IN ('paid','fulfilled')` للإيرادات
- `SELECT DATE(answered_at), COUNT(*) FROM student_answers WHERE answered_at >= DATE('now','-7 days') GROUP BY DATE(answered_at)` للنشاط الأسبوعي
استخدم `c.env.DB.batch([...])` لتشغيل الاستعلامات معاً.

### R3. إصلاح المشاكل المتوسطة

**MED-3:** في `src/routes/questions.ts`، نقطة `GET /daily` تجلب 25 سؤالاً وتُرجع 5 — لكنها تأخذ أول 5 دائماً. أضف `ORDER BY RANDOM()` أو استخدم seed يومي لضمان تنوع حقيقي.

**MED-6:** في `src/routes/activation.ts`، في الحالة `code.status === 'active'` (السطور 95-106)، أضف نفس منطق lockout المطبّق في حالة الكود الخاطئ (فحص MAX_FAILED_REDEEMS وتطبيق lockout إذا تخطّى الحد).

**FB-04:** في `wrangler.toml`، أضف تعليق يوضح أن `BOOTSTRAP_ADMIN_EMAIL` يجب نقله إلى `wrangler secret put` في الإنتاج الحقيقي.

**FB-03:** في `src/routes/auth.ts`، مسار Firebase `/firebase/verify`، عند ربط الحساب الموجود، أضف تحديث `photo_url` إذا كانت فارغة (مثل مسار GIS).

## Acceptance Criteria

### أمان
- [ ] `studentsRouter.get('/leaderboard', ...)` يحتوي `requireAuth` كـ middleware مباشرة أو تم نقله بعد `use('*', requireAuth)`
- [ ] `banId` في admin.ts لا يحتوي على `Math.random()` — يستخدم `schema.genId()` أو ما يعادله من crypto عشوائي آمن
- [ ] `/firebase/verify` يستدعي `domainAllowed()` قبل البحث في DB
- [ ] بعد account linking في Firebase، يتم جلب صف المستخدم من DB من جديد وليس تعديله محلياً

### أداء
- [ ] `GET /admin/users` يقبل query params `limit` و `offset` ولا يجلب كل الجدول
- [ ] `GET /admin/overview` لا تحتوي على `db.select().from(schema.users)` أو ما شابه بدون LIMIT أو WHERE محدد
- [ ] `GET /admin/professors` لا تحتوي على `Promise.all` مع استعلام منفصل لكل أستاذ في الـ map

### الاختبارات
- [ ] `cmd /c "npm test"` يُكمل بـ 0 فشل (جميع 565 اختبار نجاح) — شغّل هذا الأمر للتحقق
- [ ] `cmd /c "npm run typecheck"` يُكمل بـ 0 أخطاء TypeScript

### منطق الأعمال
- [ ] `/api/questions/daily` لا تُرجع نفس الأسئلة في كل طلب
- [ ] في `activation.ts`، كود `already_active` يُطبّق lockout بعد تجاوز MAX_FAILED_REDEEMS

