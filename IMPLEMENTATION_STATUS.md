# حالة تنفيذ خطة الأمان والإصلاح المعماري — منصة KIUR-99

**تاريخ البدء:** 2026-09-19  
**الـ Commit المرجعي للبدء:** `c1328e4449cfa4f11b37dd287cfd580d29b13fb3`  
**الفرع الحالي المستقل:** `security-remediation`  
**بيئة العمل:** TypeScript / Hono / Cloudflare Workers & D1  
**حالة النشر:** تم إيقاف أي نشر تلقائي إلى الإنتاج تماماً، العمل محلي حصراً بدون تعديل خدمات خارجية.

---

## 1. جدول التحقق من ثغرات P0 (المرحلة الأولى)

| المعرّف | الثغرة الأمنية | هل ما زالت موجودة؟ | الملف المصدر | الأسطر | اختبار الإثبات الدفاعي (PoC / Regression Test) |
|---|---|---|---|---|---|
| **P0-1** | تجاوز مصادقة Google وإنشاء Admin عبر `next=admin` و fallback البريد المباشر | **نعم (مؤكدة)** | `src/routes/auth.ts` | 337–427, 430–585 | إرسال طلب `POST /auth/google/login` مع `{email, next: 'admin'}` يُنشئ مستخدماً بدور `admin` وجلسة صالحة دون فحص Google |
| **P0-2** | مفتاح JWT Secret مكشوف في Git وتجاوز التحقق الآمن في بدء التشغيل | **نعم (مؤكدة)** | `wrangler.toml`<br>`src/config.ts`<br>`src/index.ts` | `wrangler.toml:22`<br>`src/config.ts:51-70`<br>`src/index.ts:1-77` | التحقق من وجود القيمة الثابتة في `wrangler.toml` وعدم استدعاء `validateConfig` إطلاقاً في نقطة دخول التطبيق `src/index.ts` |
| **P0-3** | الجلسة غير مربوطة بصاحب sub في JWT (تفكك الجلسة عن المستخدم) | **نعم (مؤكدة)** | `src/middleware/auth.ts`<br>`src/routes/bans.ts` | `src/middleware/auth.ts:28-45`<br>`src/routes/bans.ts:20-28` | إنشاء JWT بـ `sub` لمستخدم A مع `sid` لجلسة مستخدم B نشطة؛ الميدلوير يقبل الطلب كالمستخدم A دون مقارنة `session.user_id === payload.sub` |
| **P0-4** | مصادقة Firebase JWT بدون تحقق توقيع تشفيري موثوق (Parse-only) | **نعم (مؤكدة)** | `src/services/firebase.ts`<br>`src/routes/auth.ts` | `src/services/firebase.ts:90-109`<br>`src/routes/auth.ts:704-848` | تمرير توكن موقع بمفتاح وهمي مع `alg: RS256`؛ الكود يكتفي بفك الـ JSON بدون فحص التوقيع عبر Google JWKS عند غياب API Key أو وضعه mock |
| **P0-5** | ثغرة Stored XSS عبر المهارات وتفسير الإجابات وضعف سياسة CSP | **نعم (مؤكدة)** | `src/routes/auth.ts`<br>`public/nabd-home-quiz-prototype.html`<br>`src/middleware/security-headers.ts` | `auth.ts:1431-1443`<br>`HTML:8389-8390`<br>`security-headers.ts:5-10` | إرسال مهارة تحتوي `<img src=x onerror=alert(1)>`؛ تُخزن بدون تنظيف وتُعرض عبر `innerHTML`، والـ CSP يسمح بـ `'unsafe-inline'` |
| **P0-6** | تسريب الإجابات الصحيحة والتفسير للطالب قبل حل السؤال | **نعم (مؤكدة)** | `src/routes/questions.ts` | 15–41, 130–142 | استدعاء `GET /api/questions/subjects/:id/questions` كطالب؛ الـ JSON المعود يتضمن حقل `is_correct` داخل `choices` وتفسير `rationale` قبل الإجابة |
| **P0-7** | وصول عام وغير مصرح للملفات والوسائط والمقررات وتجاوز الـ Entitlement | **نعم (مؤكدة)** | `src/routes/media.ts`<br>`src/routes/courses.ts` | `src/routes/media.ts:11-78`<br>`src/routes/courses.ts:51-115, 127-138` | طلب ملف عبر `GET /media-files/:name` مباشرة من R2 حتى لو لم يكن مسجلاً بالـ DB؛ وتسريب روابط الفيديوهات في المقررات دون التحقق من الدفع/النطاق الأكاديمي، بالإضافة إلى خطأ `&&` المنطقي في Drizzle |
| **P0-8** | رفع محتوى نشط (HTML/SVG) وخدمته من نفس الأصل (Same-Origin Execution) | **نعم (مؤكدة)** | `src/routes/auth.ts`<br>`src/services/storage.ts`<br>`src/routes/media.ts` | `auth.ts:1403-1420`<br>`storage.ts:106-156`<br>`media.ts:74-77` | رفع ملف HTML باسم `avatar.png` وتمرير `file.type: text/html`؛ الخادم يخزنه ويخدمه مباشرة مع ترويسة HTML على نفس الأصل بدون فحص Magic Bytes إلزامي صارم |

---

## 2. نتائج الفحص الآلي الحالية

- **فحص الأنواع (`npm run typecheck`):** ناجح بنسبة 100% (0 أخطاء).
- **بناء الحزمة (`npm run build` --dry-run):** ناجح بدون أخطاء.
- **الاختبارات الافتراضية عبر `contract-router`:** 36 ملف، 479 اختبار ناجح.
- **الاختبارات الحقيقية ضد `src` المباشر (`TEST_TARGET=src`):**
  - كشفت عن اختلافات حقيقية بين الـ contract-router الوهمي والتطبيق الحقيقي (مثل هيكل توكن المصادقة، قراءة اسم الجهاز، واستعادة الجلسات).
  - تم إثبات أن الاعتماد على `contract-router` وحده كان يُخفي ثغرات واختلافات سلوكية جوهرية.

---

## 3. خطة العمل التفصيلية لمعالجة ثغرات P0 (المرحلة الثانية)

1. **إصلاح P0-1 (Google Auth & Admin Escalation):**
   - إزالة مسار الـ fallback القائم على البريد الإلكتروني في `POST /auth/google/login`.
   - إلغاء قراءة `next === 'admin'` لترقية الحساب إلى مشرف؛ أي مستخدم جديد يُسجل حصراً بدور `student`.
   - منع منح صلاحية `admin` إلا من خلال آلية خادم مركزية معتمدة ومسجلة (Audit Log) أو عبر `BOOTSTRAP_ADMIN_EMAIL` عند أول تهيئة فقط.
   - في حال عدم تهيئة مفاتيح Google/Firebase، الرد بـ `503 Service Unavailable` بدلاً من أي نموذج تجريبي.

2. **إصلاح P0-2 (JWT Secret & Bootstrapping Validation):**
   - تفريغ `JWT_SECRET` من `wrangler.toml` في Git لمنع تسريبه وتوثيق رفعه عبر `wrangler secret put`.
   - استدعاء `validateConfig(getConfig(c.env))` في ميدلوير عالمي أو عند بدء تشغيل التطبيق في `src/index.ts` لفرض Fail-Closed.
   - التحقق من معايير التشفير (`issuer`, `audience`, `algorithm`, `min length 32`).

3. **إصلاح P0-3 (ربط الجلسة sid بالمستخدم sub):**
   - تحديث دالة `requireAuth` للتحقق المركب:
     `and(eq(userSessions.id, payload.sid), eq(userSessions.user_id, payload.sub), eq(userSessions.is_active, true))`
   - تطبيق نفس الفحص في جميع مسارات استعادة الجلسة، الحظر، والوسائط.

4. **إصلاح P0-4 (التحقق التشفيري الصارم من Firebase Token):**
   - استخدام `jose` للتحقق التشفيري المباشر عبر Google Secure Token JWKS (`https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`).
   - رفض التوكنات مجهولة التوقيع أو غير المطابقة لمشروع Firebase و issuer الصالح.

5. **إصلاح P0-5 (إغلاق Stored XSS وتشديد CSP):**
   - تنظيف وتطهير إدخال المهارات (`userSkills`) وحظر وسوم HTML وخاصة `<script>` و `<img>` و `<iframe>`.
   - تعديل كود الواجهة لاستخدام `textContent` و DOM APIs بدلاً من `innerHTML`.
   - تشديد CSP في `security-headers.ts` لتقييد مصادر النصوص والاتصالات وإزالة الممارسات غير الآمنة.

6. **إصلاح P0-6 (منع تسريب الإجابات والتفسير للطالب):**
   - فصل DTO المخصص للطلاب عن DTO المخصص للأساتذة والمراجعة.
   - حذف `is_correct` و `rationale` تماماً من استجابات أسئلة المواد والأسئلة المحفوظة للطلاب قبل الحل والتسليم.

7. **إصلاح P0-7 (حوكمة الوسائط والمقررات وتصحيح `&&` في Drizzle):**
   - منع خدمة أي ملف لا يملك سجلاً معتمداً في جدول `mediaFiles`.
   - تطبيق فحص الصلاحيات والاستحقاق (Entitlement) للمقررات والفيديوهات قبل توفير الروابط أو البيانات.
   - استبدال `&&` بـ `and(...)` في استعلامات Drizzle بمسارات `courses.ts` و `bans.ts`.

8. **إصلاح P0-8 (منع رفع وتنفيذ المحتوى النشط):**
   - فحص Magic Bytes بشكل إلزامي؛ رفض أي ملف لا يتطابق توقيعه البايتي بدقة مع الامتدادات المسموحة (`png`, `jpeg`, `webp`, `pdf`).
   - تعيين `Content-Type` المشتق من الخادم بعد فحص البايتات، وتضمين `Content-Disposition: attachment` أو عزل استعراض الوسائط.

---

## 4. القرارات المعمارية المتخذة

1. **اعتماد TypeScript / Hono كمصدر حقيقة وحيد:** تركيز كافة الإصلاحات الأمنية والمعمارية في مجلد `src` ونظام Cloudflare Workers / D1 الحالي، دون تشغيل Python بشكل موازٍ لتجنب تشتت السلوك الأمني.
2. **العمل على فرع منعزل (`security-remediation`):** الالتزام بعدم المساس بالفرع الرئيسي `main` حتى اكتمال جميع المراحل بنجاح.
3. **مبدأ الفشل الآمن (Fail-Closed):** أي غياب للتهيئة أو بيانات التحقق يجب أن يرجع رمز خطأ صريح (503/401/403) بدلاً من اللجوء لحسابات افتراضية أو تصاريح مؤقتة.

---

## 5. نقطة الاستئناف الدقيقة

- تم الانتهاء من **المرحلة الأولى (التحقق والتوثيق)**.
- الخطوة القادمة فور اعتماد الخطة: البدء في **المرحلة الثانية (تنفيذ إصلاحات P0-1 حتى P0-8 خطوة بخطوة مع اختبارات الانحدار الخاصة بكل ثغرة)**.

