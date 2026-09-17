# Handoff Report: Drizzle ORM Schema & Cloudflare D1 DDL Architecture

- **Agent**: M1 Explorer 2 (Drizzle Schema & D1 DDL)
- **Milestone**: Milestone 1: Foundation & Database Layer
- **Parent**: Orchestrator (`fdf0f062-12fc-46d6-8dd0-3c6786653821`)
- **Working Directory**: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m1_2`
- **Timestamp**: 2026-09-17T00:30:00Z

---

## 1. Observation

### 1.1 Codebase Audit Findings
1. **Model Source of Truth** (`app/models.py:1-453`):
   - Exactly **30 tables** are declared inheriting from `Base = declarative_base()` (`app/database.py:20`).
   - Tables in alphabetical order: `activation_codes`, `activity_logs`, `ban_records`, `booklets`, `choices`, `clinical_pearls`, `courses`, `exam_attempt_questions`, `exam_attempts`, `exams`, `lecture_progress`, `lectures`, `media_files`, `notification_reads`, `notifications`, `order_items`, `orders`, `products`, `professor_profiles`, `questions`, `recent_views`, `saved_questions`, `sections`, `stages`, `student_answers`, `subjects`, `universities`, `user_sessions`, `user_skills`, `users`.
   - Exactly **5 enumerations** are declared (`app/models.py:17-47`):
     - `Role(str, enum.Enum)`: `student`, `professor`, `admin`, `reseller`
     - `ProductType(str, enum.Enum)`: `digital`, `physical`, `course`
     - `OrderStatus(str, enum.Enum)`: `pending`, `paid`, `fulfilled`, `cancelled`
     - `BanStatus(str, enum.Enum)`: `active`, `appealed`, `lifted`
     - `CodeStatus(str, enum.Enum)`: `idle`, `active`, `expired`
   - Primary Key Generation (`app/models.py:13-14`):
     ```python
     def gen_id() -> str:
         return uuid.uuid4().hex[:12]
     ```
     Every single table uses `id = Column(String, primary_key=True, default=gen_id)`.

2. **Column Patching & Startup Reflection** (`app/main.py:88-137`):
   - The application does not use Alembic migrations. At server startup, `Base.metadata.create_all(bind=engine)` is called, followed by `_patch_missing_columns()`.
   - `_patch_missing_columns` iterates over `Base.metadata.sorted_tables` and compares against `inspect(engine).get_columns(table.name)`, executing `ALTER TABLE ... ADD COLUMN ...` and backfilling non-null defaults.
   - Conclusion from this: The Python SQLAlchemy models in `app/models.py` represent the absolute definitive schema contract.

3. **Relationship Cascades in SQLAlchemy** (`app/models.py`):
   - `User.sessions`: `cascade="all, delete-orphan"` (`app/models.py:88`) -> `user_sessions.user_id`
   - `Question.choices`: `cascade="all, delete-orphan"` (`app/models.py:178`) -> `choices.question_id`
   - `Course.lectures`: `cascade="all, delete-orphan"` (`app/models.py:226`) -> `lectures.course_id`
   - `Order.items`: `cascade="all, delete-orphan"` (`app/models.py:308`) -> `order_items.order_id`
   - `ExamAttempt.items`: `cascade="all, delete-orphan"` (`app/models.py:371`) -> `exam_attempt_questions.attempt_id`

4. **Foreign Key Deletion Constraints & Application Logic**:
   - `app/routers/professors.py:245-250`: Explicitly purges `NotificationRead` when deleting content announcements.
   - `app/routers/admin.py:839-857`: Subject deletion contains strict application-level blocker checks against questions, professors, courses, exams, activation codes, and products.
   - `app/routers/admin.py:924-925`: Deleting a question explicitly purges `StudentAnswer` rows, while `Choice` rows cascade via the ORM.
   - `app/routers/questions.py:80-85`: Unsaving a question purges `SavedQuestion` rows.

5. **Interface Contracts & Serialization Rules** (`PROJECT.md:127-155`):
   - `CurrentUser` and `CurrentSession` use strict `snake_case` keys:
     ```typescript
     export interface CurrentUser {
       id: string;
       email: string;
       full_name: string;
       role: 'student' | 'professor' | 'admin' | 'reseller';
       is_banned: boolean;
       university_id?: string | null;
       stage_id?: string | null;
       section_id?: string | null;
     }
     ```
   - All API endpoints return flat `snake_case` JSON matching Python Pydantic output without envelope wrapping.

---

## 2. Logic Chain

### 2.1 Type Translation: Python / SQLAlchemy -> Cloudflare D1 (SQLite) -> Drizzle ORM
1. **Primary Keys (`gen_id`)**:
   - Python: 12-char hex string (`uuid.uuid4().hex[:12]`).
   - Web Crypto / Cloudflare Workers: `crypto.randomUUID().replace(/-/g, '').slice(0, 12)`.
   - SQLite DDL: `TEXT PRIMARY KEY NOT NULL`.
   - Drizzle ORM: `text('id').primaryKey().$defaultFn(genId)`.

2. **Strings & Texts**:
   - Python: `String`, `Text`.
   - SQLite DDL: `TEXT`.
   - Drizzle ORM: `text('column_name')`.
   - SQLite has a single TEXT storage class, so `String` and `Text` both map to `text()`.

3. **Booleans**:
   - Python: `Boolean` (`default=False` / `default=True`).
   - SQLite DDL: `INTEGER NOT NULL DEFAULT 0` (or `1`).
   - Drizzle ORM: `integer('is_banned', { mode: 'boolean' }).notNull().default(false)`.
   - In Drizzle, `{ mode: 'boolean' }` handles transparent bidirectional conversion (`true` <-> `1`, `false` <-> `0`) at both the TypeScript and runtime JSON serialization levels.

4. **DateTimes**:
   - Python: `DateTime` (`default=datetime.utcnow`).
   - SQLite DDL: `TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)`.
   - Drizzle ORM: `text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`)`.
   - Text ISO 8601 strings (`YYYY-MM-DD HH:MM:SS` or `YYYY-MM-DDTHH:MM:SS.sssZ`) serialize natively as strings in JSON payloads (matching Pydantic output), can be parsed directly in browsers (`new Date(...)`), and support SQLite date functions (`date()`, `strftime()`).

5. **Integers**:
   - Python: `Integer` (prices, counts, durations, order indexes).
   - SQLite DDL: `INTEGER NOT NULL DEFAULT 0`.
   - Drizzle ORM: `integer('column_name').notNull().default(0)`.

6. **Enums**:
   - Python: 5 `enum.Enum` subclasses.
   - SQLite DDL: `TEXT NOT NULL DEFAULT '...'`.
   - Drizzle ORM: `text('role', { enum: roles }).notNull().default('student')`.
   - Provides strict TypeScript compile-time union checking while remaining standard SQLite TEXT in D1.

### 2.2 Snake-Case Property Discipline for Direct JSON Serialization
- Standard Drizzle definitions often use camelCase keys in TypeScript (e.g. `fullName: text('full_name')`).
- However, the Nabd/Kiur API requires 100% `snake_case` payloads to maintain compatibility with `nabd-home-quiz-prototype.html` and `nabd-admin-dashboard.html`.
- By defining schema properties in `snake_case` (e.g. `full_name: text('full_name').notNull()`, `is_banned: integer('is_banned', { mode: 'boolean' })`), query results from `db.select().from(users)` or `db.query.users.findMany()` are *already* in the exact snake_case format expected by `CurrentUser`, `CurrentSession`, and all route handlers.
- This eliminates runtime mapping layers, reducing CPU isolate execution time to near zero.

### 2.3 Strict Topological Ordering for D1 SQL Migrations
In SQLite, foreign keys cannot be created if they reference circular dependencies, and table creation order must satisfy foreign key dependencies. The 30 tables form a clean Directed Acyclic Graph (DAG):
1. Level 0 (Base Catalog): `sections`
2. Level 1 (Universities): `universities` (FK -> `sections`)
3. Level 2 (Stages): `stages` (FK -> `universities`)
4. Level 3 (Subjects): `subjects` (FK -> `stages`)
5. Level 4 (Users): `users` (FK -> `universities`, `stages`, `sections`)
6. Level 5 (Sessions & Profiles): `user_sessions` (FK -> `users`), `professor_profiles` (FK -> `users`, `subjects`)
7. Level 6 (Professor Content): `booklets` (FK -> `professor_profiles`), `questions` (FK -> `subjects`, `professor_profiles`), `exams` (FK -> `subjects`, `professor_profiles`), `courses` (FK -> `subjects`, `professor_profiles`)
8. Level 7 (Sub-units & Choices): `choices` (FK -> `questions`), `lectures` (FK -> `courses`)
9. Level 8 (Student Interactions): `student_answers` (FK -> `users`, `questions`, `choices`), `recent_views` (FK -> `users`), `lecture_progress` (FK -> `users`, `lectures`), `user_skills` (FK -> `users`), `saved_questions` (FK -> `users`, `questions`)
10. Level 9 (Store & Commerce): `products` (FK -> `subjects`), `orders` (FK -> `users`), `order_items` (FK -> `orders`, `products`), `activation_codes` (FK -> `subjects`, `users`, `orders`)
11. Level 10 (Admin, Safety & Notifications): `ban_records` (FK -> `users`), `activity_logs` (FK -> `users`), `media_files` (FK -> `users`), `notifications` (FK -> `users`), `notification_reads` (FK -> `notifications`, `users`), `clinical_pearls` (FK -> `users`)
12. Level 11 (Exam Attempts): `exam_attempts` (FK -> `exams`, `users`), `exam_attempt_questions` (FK -> `exam_attempts`, `questions`, `choices`)

Executing `migrations/0000_initial_schema.sql` in this exact sequence guarantees 0 foreign key dependency resolution errors.

---

## 3. Caveats

1. **SQLite PRAGMA foreign_keys in Workers**:
   - In Cloudflare D1, foreign key checks are enforced by the engine runtime. However, to safeguard against soft cascading failures during manual bulk deletes, the application-layer delete cascades (e.g., deleting choices when questions are deleted, deleting lecture progress when lectures are deleted) should be maintained in route service logic.
2. **Date String Formats**:
   - Default timestamp generates `YYYY-MM-DD HH:MM:SS` (from SQLite's `(CURRENT_TIMESTAMP)`). When JavaScript code creates dates (e.g. `new Date().toISOString()`), it produces ISO strings with `'T'` and `'Z'`. SQLite's `date()` and `strftime()` functions natively support both formats.
3. **Multi-byte Unicode / Arabic Text Searching**:
   - SQLite `LIKE` is case-insensitive only for ASCII characters (`A-Z`). Since Arabic script does not have case distinctions, `LIKE` works as expected. For bilingual searches (e.g. search by full name with English characters), `sql` template with `lower()` should be used when necessary.
4. **No Alembic Backporting Needed**:
   - The production codebase had no Alembic version tracking. Applying the single clean initial DDL creates a fully normalized D1 database directly.

---

## 4. Conclusion & Recommended Architecture

The database migration from SQLAlchemy to Cloudflare D1 / Drizzle ORM is 100% architecturally verified. The complete implementation specifications are detailed below.

### 4.1 Schema Specifications

#### File 1: `src/db/schema.ts`
Complete, production-ready Drizzle ORM schema specification covering all 30 tables, 5 enums, 12-character hex ID generation, cascades, unique constraints, 58 indexes, and bidirectional Drizzle relations:

```typescript
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { relations, sql, type InferSelectModel, type InferInsertModel } from 'drizzle-orm';

/**
 * 12-character hex ID generator matching Python backend's uuid.uuid4().hex[:12]
 */
export function genId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

// ============================================================================
// ENUMS (TypeScript Union Types matching Python SQLAlchemy Enums)
// ============================================================================
export const roles = ['student', 'professor', 'admin', 'reseller'] as const;
export type Role = (typeof roles)[number];

export const productTypes = ['digital', 'physical', 'course'] as const;
export type ProductType = (typeof productTypes)[number];

export const orderStatuses = ['pending', 'paid', 'fulfilled', 'cancelled'] as const;
export type OrderStatus = (typeof orderStatuses)[number];

export const banStatuses = ['active', 'appealed', 'lifted'] as const;
export type BanStatus = (typeof banStatuses)[number];

export const codeStatuses = ['idle', 'active', 'expired'] as const;
export type CodeStatus = (typeof codeStatuses)[number];

// ============================================================================
// 1. SECTIONS
// ============================================================================
export const sections = sqliteTable('sections', {
  id: text('id').primaryKey().$defaultFn(genId),
  name: text('name').notNull(),
});

export type Section = InferSelectModel<typeof sections>;
export type NewSection = InferInsertModel<typeof sections>;

// ============================================================================
// 2. UNIVERSITIES
// ============================================================================
export const universities = sqliteTable('universities', {
  id: text('id').primaryKey().$defaultFn(genId),
  name: text('name').notNull(),
  section_id: text('section_id').notNull().references(() => sections.id),
}, (table) => ({
  section_id_idx: index('universities_section_id_idx').on(table.section_id),
}));

export type University = InferSelectModel<typeof universities>;
export type NewUniversity = InferInsertModel<typeof universities>;

// ============================================================================
// 3. STAGES
// ============================================================================
export const stages = sqliteTable('stages', {
  id: text('id').primaryKey().$defaultFn(genId),
  name: text('name').notNull(),
  university_id: text('university_id').notNull().references(() => universities.id),
}, (table) => ({
  university_id_idx: index('stages_university_id_idx').on(table.university_id),
}));

export type Stage = InferSelectModel<typeof stages>;
export type NewStage = InferInsertModel<typeof stages>;

// ============================================================================
// 4. SUBJECTS
// ============================================================================
export const subjects = sqliteTable('subjects', {
  id: text('id').primaryKey().$defaultFn(genId),
  name: text('name').notNull(),
  stage_id: text('stage_id').notNull().references(() => stages.id),
}, (table) => ({
  stage_id_idx: index('subjects_stage_id_idx').on(table.stage_id),
}));

export type Subject = InferSelectModel<typeof subjects>;
export type NewSubject = InferInsertModel<typeof subjects>;

// ============================================================================
// 5. USERS
// ============================================================================
export const users = sqliteTable('users', {
  id: text('id').primaryKey().$defaultFn(genId),
  email: text('email').notNull(),
  full_name: text('full_name').notNull(),
  google_sub: text('google_sub'),
  password_hash: text('password_hash'),
  role: text('role', { enum: roles }).notNull().default('student'),
  university_id: text('university_id').references(() => universities.id),
  stage_id: text('stage_id').references(() => stages.id),
  section_id: text('section_id').references(() => sections.id),
  phone: text('phone'),
  is_graduate: integer('is_graduate', { mode: 'boolean' }),
  is_banned: integer('is_banned', { mode: 'boolean' }).notNull().default(false),
  totp_secret: text('totp_secret'),
  totp_enabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
  photo_url: text('photo_url'),
  caption: text('caption'),
  failed_login_attempts: integer('failed_login_attempts').notNull().default(0),
  locked_until: text('locked_until'),
  failed_redeem_attempts: integer('failed_redeem_attempts').notNull().default(0),
  reset_token_hash: text('reset_token_hash'),
  reset_token_expires_at: text('reset_token_expires_at'),
  reset_requested_at: text('reset_requested_at'),
  password_changed_at: text('password_changed_at'),
  redeem_locked_until: text('redeem_locked_until'),
  theme: text('theme').notNull().default('light'),
  language: text('language').notNull().default('ar'),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  email_idx: uniqueIndex('users_email_idx').on(table.email),
  google_sub_idx: uniqueIndex('users_google_sub_idx').on(table.google_sub),
  university_id_idx: index('users_university_id_idx').on(table.university_id),
  stage_id_idx: index('users_stage_id_idx').on(table.stage_id),
  section_id_idx: index('users_section_id_idx').on(table.section_id),
}));

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

// ============================================================================
// 6. USER SESSIONS (Anti-Piracy Single Active Session)
// ============================================================================
export const userSessions = sqliteTable('user_sessions', {
  id: text('id').primaryKey().$defaultFn(genId),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  device_label: text('device_label').notNull().default('جهاز غير معروف'),
  is_active: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  user_id_idx: index('user_sessions_user_id_idx').on(table.user_id),
  user_active_idx: index('user_sessions_user_active_idx').on(table.user_id, table.is_active),
}));

export type UserSession = InferSelectModel<typeof userSessions>;
export type NewUserSession = InferInsertModel<typeof userSessions>;

// ============================================================================
// 7. PROFESSOR PROFILES
// ============================================================================
export const professorProfiles = sqliteTable('professor_profiles', {
  id: text('id').primaryKey().$defaultFn(genId),
  user_id: text('user_id').notNull().references(() => users.id),
  title: text('title').notNull().default('أستاذ مساعد'),
  subject_id: text('subject_id').notNull().references(() => subjects.id),
  bio: text('bio').notNull().default(''),
  photo_url: text('photo_url'),
}, (table) => ({
  user_id_idx: index('professor_profiles_user_id_idx').on(table.user_id),
  subject_id_idx: index('professor_profiles_subject_id_idx').on(table.subject_id),
}));

export type ProfessorProfile = InferSelectModel<typeof professorProfiles>;
export type NewProfessorProfile = InferInsertModel<typeof professorProfiles>;

// ============================================================================
// 8. BOOKLETS
// ============================================================================
export const booklets = sqliteTable('booklets', {
  id: text('id').primaryKey().$defaultFn(genId),
  professor_id: text('professor_id').notNull().references(() => professorProfiles.id),
  title: text('title').notNull(),
  file_url: text('file_url').notNull().default(''),
  pages: integer('pages').notNull().default(0),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  professor_id_idx: index('booklets_professor_id_idx').on(table.professor_id),
}));

export type Booklet = InferSelectModel<typeof booklets>;
export type NewBooklet = InferInsertModel<typeof booklets>;

// ============================================================================
// 9. QUESTIONS
// ============================================================================
export const questions = sqliteTable('questions', {
  id: text('id').primaryKey().$defaultFn(genId),
  subject_id: text('subject_id').notNull().references(() => subjects.id),
  professor_id: text('professor_id').references(() => professorProfiles.id),
  text: text('text').notNull(),
  image_url: text('image_url'),
  rationale: text('rationale').notNull().default(''),
  eyebrow: text('eyebrow').notNull().default(''),
}, (table) => ({
  subject_id_idx: index('questions_subject_id_idx').on(table.subject_id),
  professor_id_idx: index('questions_professor_id_idx').on(table.professor_id),
}));

export type Question = InferSelectModel<typeof questions>;
export type NewQuestion = InferInsertModel<typeof questions>;

// ============================================================================
// 10. CHOICES
// ============================================================================
export const choices = sqliteTable('choices', {
  id: text('id').primaryKey().$defaultFn(genId),
  question_id: text('question_id').notNull().references(() => questions.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  is_correct: integer('is_correct', { mode: 'boolean' }).notNull().default(false),
  order_index: integer('order_index').notNull().default(0),
}, (table) => ({
  question_id_idx: index('choices_question_id_idx').on(table.question_id),
}));

export type Choice = InferSelectModel<typeof choices>;
export type NewChoice = InferInsertModel<typeof choices>;

// ============================================================================
// 11. STUDENT ANSWERS
// ============================================================================
export const studentAnswers = sqliteTable('student_answers', {
  id: text('id').primaryKey().$defaultFn(genId),
  user_id: text('user_id').notNull().references(() => users.id),
  question_id: text('question_id').notNull().references(() => questions.id),
  choice_id: text('choice_id').notNull().references(() => choices.id),
  is_correct: integer('is_correct', { mode: 'boolean' }).notNull(),
  answered_at: text('answered_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  user_id_idx: index('student_answers_user_id_idx').on(table.user_id),
  question_id_idx: index('student_answers_question_id_idx').on(table.question_id),
  user_answered_idx: index('student_answers_user_answered_idx').on(table.user_id, table.answered_at),
}));

export type StudentAnswer = InferSelectModel<typeof studentAnswers>;
export type NewStudentAnswer = InferInsertModel<typeof studentAnswers>;

// ============================================================================
// 12. EXAMS
// ============================================================================
export const exams = sqliteTable('exams', {
  id: text('id').primaryKey().$defaultFn(genId),
  subject_id: text('subject_id').notNull().references(() => subjects.id),
  professor_id: text('professor_id').references(() => professorProfiles.id),
  title: text('title').notNull(),
  question_count: integer('question_count').notNull().default(0),
  duration_minutes: integer('duration_minutes').notNull().default(30),
}, (table) => ({
  subject_id_idx: index('exams_subject_id_idx').on(table.subject_id),
  professor_id_idx: index('exams_professor_id_idx').on(table.professor_id),
}));

export type Exam = InferSelectModel<typeof exams>;
export type NewExam = InferInsertModel<typeof exams>;

// ============================================================================
// 13. COURSES
// ============================================================================
export const courses = sqliteTable('courses', {
  id: text('id').primaryKey().$defaultFn(genId),
  subject_id: text('subject_id').notNull().references(() => subjects.id),
  professor_id: text('professor_id').references(() => professorProfiles.id),
  title: text('title').notNull(),
}, (table) => ({
  subject_id_idx: index('courses_subject_id_idx').on(table.subject_id),
  professor_id_idx: index('courses_professor_id_idx').on(table.professor_id),
}));

export type Course = InferSelectModel<typeof courses>;
export type NewCourse = InferInsertModel<typeof courses>;

// ============================================================================
// 14. LECTURES
// ============================================================================
export const lectures = sqliteTable('lectures', {
  id: text('id').primaryKey().$defaultFn(genId),
  course_id: text('course_id').notNull().references(() => courses.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  duration_seconds: integer('duration_seconds').notNull().default(0),
  order_index: integer('order_index').notNull().default(0),
  video_url: text('video_url').notNull().default(''),
}, (table) => ({
  course_id_idx: index('lectures_course_id_idx').on(table.course_id),
}));

export type Lecture = InferSelectModel<typeof lectures>;
export type NewLecture = InferInsertModel<typeof lectures>;

// ============================================================================
// 15. RECENT VIEWS
// ============================================================================
export const recentViews = sqliteTable('recent_views', {
  id: text('id').primaryKey().$defaultFn(genId),
  user_id: text('user_id').notNull().references(() => users.id),
  content_type: text('content_type').notNull(), // 'booklet' | 'lecture'
  content_id: text('content_id').notNull(),
  viewed_at: text('viewed_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  user_id_idx: index('recent_views_user_id_idx').on(table.user_id),
  user_content_idx: uniqueIndex('recent_views_user_content_idx').on(table.user_id, table.content_type, table.content_id),
}));

export type RecentView = InferSelectModel<typeof recentViews>;
export type NewRecentView = InferInsertModel<typeof recentViews>;

// ============================================================================
// 16. LECTURE PROGRESS
// ============================================================================
export const lectureProgress = sqliteTable('lecture_progress', {
  id: text('id').primaryKey().$defaultFn(genId),
  user_id: text('user_id').notNull().references(() => users.id),
  lecture_id: text('lecture_id').notNull().references(() => lectures.id),
  completed_at: text('completed_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  user_id_idx: index('lecture_progress_user_id_idx').on(table.user_id),
  user_lecture_idx: uniqueIndex('lecture_progress_user_lecture_idx').on(table.user_id, table.lecture_id),
}));

export type LectureProgress = InferSelectModel<typeof lectureProgress>;
export type NewLectureProgress = InferInsertModel<typeof lectureProgress>;

// ============================================================================
// 17. PRODUCTS
// ============================================================================
export const products = sqliteTable('products', {
  id: text('id').primaryKey().$defaultFn(genId),
  name: text('name').notNull(),
  price: integer('price').notNull(),
  type: text('type', { enum: productTypes }).notNull(),
  is_activation_code: integer('is_activation_code', { mode: 'boolean' }).notNull().default(false),
  grants_subject_id: text('grants_subject_id').references(() => subjects.id),
}, (table) => ({
  grants_subject_id_idx: index('products_grants_subject_id_idx').on(table.grants_subject_id),
}));

export type Product = InferSelectModel<typeof products>;
export type NewProduct = InferInsertModel<typeof products>;

// ============================================================================
// 18. ORDERS
// ============================================================================
export const orders = sqliteTable('orders', {
  id: text('id').primaryKey().$defaultFn(genId),
  user_id: text('user_id').notNull().references(() => users.id),
  total: integer('total').notNull().default(0),
  payment_method: text('payment_method').notNull().default('zaincash'),
  status: text('status', { enum: orderStatuses }).notNull().default('pending'),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  delivery_name: text('delivery_name'),
  delivery_phone: text('delivery_phone'),
  delivery_address: text('delivery_address'),
}, (table) => ({
  user_id_idx: index('orders_user_id_idx').on(table.user_id),
  status_idx: index('orders_status_idx').on(table.status),
}));

export type Order = InferSelectModel<typeof orders>;
export type NewOrder = InferInsertModel<typeof orders>;

// ============================================================================
// 19. ORDER ITEMS
// ============================================================================
export const orderItems = sqliteTable('order_items', {
  id: text('id').primaryKey().$defaultFn(genId),
  order_id: text('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  product_id: text('product_id').notNull().references(() => products.id),
  qty: integer('qty').notNull().default(1),
  price: integer('price').notNull(),
}, (table) => ({
  order_id_idx: index('order_items_order_id_idx').on(table.order_id),
  product_id_idx: index('order_items_product_id_idx').on(table.product_id),
}));

export type OrderItem = InferSelectModel<typeof orderItems>;
export type NewOrderItem = InferInsertModel<typeof orderItems>;

// ============================================================================
// 20. ACTIVATION CODES
// ============================================================================
export const activationCodes = sqliteTable('activation_codes', {
  id: text('id').primaryKey().$defaultFn(genId),
  code: text('code').notNull(),
  subject_id: text('subject_id').references(() => subjects.id),
  status: text('status', { enum: codeStatuses }).notNull().default('idle'),
  activated_by_user_id: text('activated_by_user_id').references(() => users.id),
  activated_at: text('activated_at'),
  expires_at: text('expires_at'),
  reseller_id: text('reseller_id').references(() => users.id),
  sold_at: text('sold_at'),
  order_id: text('order_id').references(() => orders.id),
}, (table) => ({
  code_idx: uniqueIndex('activation_codes_code_idx').on(table.code),
  subject_id_idx: index('activation_codes_subject_id_idx').on(table.subject_id),
  reseller_id_idx: index('activation_codes_reseller_id_idx').on(table.reseller_id),
  order_id_idx: index('activation_codes_order_id_idx').on(table.order_id),
}));

export type ActivationCode = InferSelectModel<typeof activationCodes>;
export type NewActivationCode = InferInsertModel<typeof activationCodes>;

// ============================================================================
// 21. BAN RECORDS
// ============================================================================
export const banRecords = sqliteTable('ban_records', {
  id: text('id').primaryKey().$defaultFn(genId),
  user_id: text('user_id').notNull().references(() => users.id),
  reason: text('reason').notNull(),
  status: text('status', { enum: banStatuses }).notNull().default('active'),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  appeal_message: text('appeal_message'),
  appealed_at: text('appealed_at'),
}, (table) => ({
  user_id_idx: index('ban_records_user_id_idx').on(table.user_id),
  status_idx: index('ban_records_status_idx').on(table.status),
}));

export type BanRecord = InferSelectModel<typeof banRecords>;
export type NewBanRecord = InferInsertModel<typeof banRecords>;

// ============================================================================
// 22. ACTIVITY LOGS
// ============================================================================
export const activityLogs = sqliteTable('activity_logs', {
  id: text('id').primaryKey().$defaultFn(genId),
  user_id: text('user_id').references(() => users.id),
  action: text('action').notNull(),
  ip_address: text('ip_address').notNull().default(''),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  user_id_idx: index('activity_logs_user_id_idx').on(table.user_id),
  created_at_idx: index('activity_logs_created_at_idx').on(table.created_at),
}));

export type ActivityLog = InferSelectModel<typeof activityLogs>;
export type NewActivityLog = InferInsertModel<typeof activityLogs>;

// ============================================================================
// 23. MEDIA FILES
// ============================================================================
export const mediaFiles = sqliteTable('media_files', {
  id: text('id').primaryKey().$defaultFn(genId),
  filename: text('filename').notNull(),
  url: text('url').notNull(),
  content_type: text('content_type').notNull().default(''),
  size_bytes: integer('size_bytes').notNull().default(0),
  uploaded_by: text('uploaded_by').references(() => users.id),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  filename_idx: uniqueIndex('media_files_filename_idx').on(table.filename),
  uploaded_by_idx: index('media_files_uploaded_by_idx').on(table.uploaded_by),
}));

export type MediaFile = InferSelectModel<typeof mediaFiles>;
export type NewMediaFile = InferInsertModel<typeof mediaFiles>;

// ============================================================================
// 24. EXAM ATTEMPTS
// ============================================================================
export const examAttempts = sqliteTable('exam_attempts', {
  id: text('id').primaryKey().$defaultFn(genId),
  exam_id: text('exam_id').notNull().references(() => exams.id),
  user_id: text('user_id').notNull().references(() => users.id),
  started_at: text('started_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  finished_at: text('finished_at'),
  score: integer('score').notNull().default(0),
  total: integer('total').notNull().default(0),
}, (table) => ({
  exam_id_idx: index('exam_attempts_exam_id_idx').on(table.exam_id),
  user_id_idx: index('exam_attempts_user_id_idx').on(table.user_id),
}));

export type ExamAttempt = InferSelectModel<typeof examAttempts>;
export type NewExamAttempt = InferInsertModel<typeof examAttempts>;

// ============================================================================
// 25. EXAM ATTEMPT QUESTIONS
// ============================================================================
export const examAttemptQuestions = sqliteTable('exam_attempt_questions', {
  id: text('id').primaryKey().$defaultFn(genId),
  attempt_id: text('attempt_id').notNull().references(() => examAttempts.id, { onDelete: 'cascade' }),
  question_id: text('question_id').notNull().references(() => questions.id),
  order_index: integer('order_index').notNull().default(0),
  choice_id: text('choice_id').references(() => choices.id),
  is_correct: integer('is_correct', { mode: 'boolean' }),
  answered_at: text('answered_at'),
}, (table) => ({
  attempt_id_idx: index('exam_attempt_questions_attempt_id_idx').on(table.attempt_id),
  question_id_idx: index('exam_attempt_questions_question_id_idx').on(table.question_id),
}));

export type ExamAttemptQuestion = InferSelectModel<typeof examAttemptQuestions>;
export type NewExamAttemptQuestion = InferInsertModel<typeof examAttemptQuestions>;

// ============================================================================
// 26. USER SKILLS
// ============================================================================
export const userSkills = sqliteTable('user_skills', {
  id: text('id').primaryKey().$defaultFn(genId),
  user_id: text('user_id').notNull().references(() => users.id),
  text: text('text').notNull(),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  user_id_idx: index('user_skills_user_id_idx').on(table.user_id),
}));

export type UserSkill = InferSelectModel<typeof userSkills>;
export type NewUserSkill = InferInsertModel<typeof userSkills>;

// ============================================================================
// 27. SAVED QUESTIONS
// ============================================================================
export const savedQuestions = sqliteTable('saved_questions', {
  id: text('id').primaryKey().$defaultFn(genId),
  user_id: text('user_id').notNull().references(() => users.id),
  question_id: text('question_id').notNull().references(() => questions.id),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  user_id_idx: index('saved_questions_user_id_idx').on(table.user_id),
  question_id_idx: index('saved_questions_question_id_idx').on(table.question_id),
  user_question_idx: uniqueIndex('saved_questions_user_question_idx').on(table.user_id, table.question_id),
}));

export type SavedQuestion = InferSelectModel<typeof savedQuestions>;
export type NewSavedQuestion = InferInsertModel<typeof savedQuestions>;

// ============================================================================
// 28. NOTIFICATIONS
// ============================================================================
export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey().$defaultFn(genId),
  user_id: text('user_id').references(() => users.id), // null = broadcast
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  created_by: text('created_by').references(() => users.id),
  content_type: text('content_type'), // 'booklet' | 'exam' | 'course'
  content_id: text('content_id'),
}, (table) => ({
  user_id_idx: index('notifications_user_id_idx').on(table.user_id),
  created_at_idx: index('notifications_created_at_idx').on(table.created_at),
}));

export type Notification = InferSelectModel<typeof notifications>;
export type NewNotification = InferInsertModel<typeof notifications>;

// ============================================================================
// 29. NOTIFICATION READS
// ============================================================================
export const notificationReads = sqliteTable('notification_reads', {
  id: text('id').primaryKey().$defaultFn(genId),
  notification_id: text('notification_id').notNull().references(() => notifications.id, { onDelete: 'cascade' }),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  read_at: text('read_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  notification_id_idx: index('notification_reads_notification_id_idx').on(table.notification_id),
  user_id_idx: index('notification_reads_user_id_idx').on(table.user_id),
  notif_user_idx: uniqueIndex('notification_reads_notif_user_idx').on(table.notification_id, table.user_id),
}));

export type NotificationRead = InferSelectModel<typeof notificationReads>;
export type NewNotificationRead = InferInsertModel<typeof notificationReads>;

// ============================================================================
// 30. CLINICAL PEARLS
// ============================================================================
export const clinicalPearls = sqliteTable('clinical_pearls', {
  id: text('id').primaryKey().$defaultFn(genId),
  tag: text('tag').notNull().default(''),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  created_by: text('created_by').references(() => users.id),
}, (table) => ({
  created_at_idx: index('clinical_pearls_created_at_idx').on(table.created_at),
  created_by_idx: index('clinical_pearls_created_by_idx').on(table.created_by),
}));

export type ClinicalPearl = InferSelectModel<typeof clinicalPearls>;
export type NewClinicalPearl = InferInsertModel<typeof clinicalPearls>;

// ============================================================================
// DRIZZLE RELATIONS (For Type-Safe Relational Queries)
// ============================================================================

export const usersRelations = relations(users, ({ one, many }) => ({
  university: one(universities, { fields: [users.university_id], references: [universities.id] }),
  stage: one(stages, { fields: [users.stage_id], references: [stages.id] }),
  section: one(sections, { fields: [users.section_id], references: [sections.id] }),
  sessions: many(userSessions),
  professor_profile: one(professorProfiles, { fields: [users.id], references: [professorProfiles.user_id] }),
  student_answers: many(studentAnswers),
  skills: many(userSkills),
  saved_questions: many(savedQuestions),
  orders: many(orders),
  exam_attempts: many(examAttempts),
  recent_views: many(recentViews),
  lecture_progress: many(lectureProgress),
  ban_records: many(banRecords),
  activity_logs: many(activityLogs),
  media_files: many(mediaFiles),
}));

export const userSessionsRelations = relations(userSessions, ({ one }) => ({
  user: one(users, { fields: [userSessions.user_id], references: [users.id] }),
}));

export const sectionsRelations = relations(sections, ({ many }) => ({
  universities: many(universities),
  users: many(users),
}));

export const universitiesRelations = relations(universities, ({ one, many }) => ({
  section: one(sections, { fields: [universities.section_id], references: [sections.id] }),
  stages: many(stages),
  users: many(users),
}));

export const stagesRelations = relations(stages, ({ one, many }) => ({
  university: one(universities, { fields: [stages.university_id], references: [universities.id] }),
  subjects: many(subjects),
  users: many(users),
}));

export const subjectsRelations = relations(subjects, ({ one, many }) => ({
  stage: one(stages, { fields: [subjects.stage_id], references: [stages.id] }),
  professors: many(professorProfiles),
  questions: many(questions),
  exams: many(exams),
  courses: many(courses),
  activation_codes: many(activationCodes),
  products: many(products),
}));

export const professorProfilesRelations = relations(professorProfiles, ({ one, many }) => ({
  user: one(users, { fields: [professorProfiles.user_id], references: [users.id] }),
  subject: one(subjects, { fields: [professorProfiles.subject_id], references: [subjects.id] }),
  booklets: many(booklets),
  questions: many(questions),
  exams: many(exams),
  courses: many(courses),
}));

export const bookletsRelations = relations(booklets, ({ one }) => ({
  professor: one(professorProfiles, { fields: [booklets.professor_id], references: [professorProfiles.id] }),
}));

export const questionsRelations = relations(questions, ({ one, many }) => ({
  subject: one(subjects, { fields: [questions.subject_id], references: [subjects.id] }),
  professor: one(professorProfiles, { fields: [questions.professor_id], references: [professorProfiles.id] }),
  choices: many(choices),
  student_answers: many(studentAnswers),
  saved_questions: many(savedQuestions),
  exam_attempt_questions: many(examAttemptQuestions),
}));

export const choicesRelations = relations(choices, ({ one, many }) => ({
  question: one(questions, { fields: [choices.question_id], references: [questions.id] }),
  student_answers: many(studentAnswers),
}));

export const studentAnswersRelations = relations(studentAnswers, ({ one }) => ({
  user: one(users, { fields: [studentAnswers.user_id], references: [users.id] }),
  question: one(questions, { fields: [studentAnswers.question_id], references: [questions.id] }),
  choice: one(choices, { fields: [studentAnswers.choice_id], references: [choices.id] }),
}));

export const examsRelations = relations(exams, ({ one, many }) => ({
  subject: one(subjects, { fields: [exams.subject_id], references: [subjects.id] }),
  professor: one(professorProfiles, { fields: [exams.professor_id], references: [professorProfiles.id] }),
  attempts: many(examAttempts),
}));

export const coursesRelations = relations(courses, ({ one, many }) => ({
  subject: one(subjects, { fields: [courses.subject_id], references: [subjects.id] }),
  professor: one(professorProfiles, { fields: [courses.professor_id], references: [professorProfiles.id] }),
  lectures: many(lectures),
}));

export const lecturesRelations = relations(lectures, ({ one, many }) => ({
  course: one(courses, { fields: [lectures.course_id], references: [courses.id] }),
  progress: many(lectureProgress),
}));

export const recentViewsRelations = relations(recentViews, ({ one }) => ({
  user: one(users, { fields: [recentViews.user_id], references: [users.id] }),
}));

export const lectureProgressRelations = relations(lectureProgress, ({ one }) => ({
  user: one(users, { fields: [lectureProgress.user_id], references: [users.id] }),
  lecture: one(lectures, { fields: [lectureProgress.lecture_id], references: [lectures.id] }),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  grants_subject: one(subjects, { fields: [products.grants_subject_id], references: [subjects.id] }),
  order_items: many(orderItems),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  user: one(users, { fields: [orders.user_id], references: [users.id] }),
  items: many(orderItems),
  activation_codes: many(activationCodes),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.order_id], references: [orders.id] }),
  product: one(products, { fields: [orderItems.product_id], references: [products.id] }),
}));

export const activationCodesRelations = relations(activationCodes, ({ one }) => ({
  subject: one(subjects, { fields: [activationCodes.subject_id], references: [subjects.id] }),
  activated_by_user: one(users, { fields: [activationCodes.activated_by_user_id], references: [users.id] }),
  reseller: one(users, { fields: [activationCodes.reseller_id], references: [users.id] }),
  order: one(orders, { fields: [activationCodes.order_id], references: [orders.id] }),
}));

export const banRecordsRelations = relations(banRecords, ({ one }) => ({
  user: one(users, { fields: [banRecords.user_id], references: [users.id] }),
}));

export const activityLogsRelations = relations(activityLogs, ({ one }) => ({
  user: one(users, { fields: [activityLogs.user_id], references: [users.id] }),
}));

export const mediaFilesRelations = relations(mediaFiles, ({ one }) => ({
  uploader: one(users, { fields: [mediaFiles.uploaded_by], references: [users.id] }),
}));

export const examAttemptsRelations = relations(examAttempts, ({ one, many }) => ({
  exam: one(exams, { fields: [examAttempts.exam_id], references: [exams.id] }),
  user: one(users, { fields: [examAttempts.user_id], references: [users.id] }),
  items: many(examAttemptQuestions),
}));

export const examAttemptQuestionsRelations = relations(examAttemptQuestions, ({ one }) => ({
  attempt: one(examAttempts, { fields: [examAttemptQuestions.attempt_id], references: [examAttempts.id] }),
  question: one(questions, { fields: [examAttemptQuestions.question_id], references: [questions.id] }),
  choice: one(choices, { fields: [examAttemptQuestions.choice_id], references: [choices.id] }),
}));

export const userSkillsRelations = relations(userSkills, ({ one }) => ({
  user: one(users, { fields: [userSkills.user_id], references: [users.id] }),
}));

export const savedQuestionsRelations = relations(savedQuestions, ({ one }) => ({
  user: one(users, { fields: [savedQuestions.user_id], references: [users.id] }),
  question: one(questions, { fields: [savedQuestions.question_id], references: [questions.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one, many }) => ({
  user: one(users, { fields: [notifications.user_id], references: [users.id] }),
  creator: one(users, { fields: [notifications.created_by], references: [users.id] }),
  reads: many(notificationReads),
}));

export const notificationReadsRelations = relations(notificationReads, ({ one }) => ({
  notification: one(notifications, { fields: [notificationReads.notification_id], references: [notifications.id] }),
  user: one(users, { fields: [notificationReads.user_id], references: [users.id] }),
}));

export const clinicalPearlsRelations = relations(clinicalPearls, ({ one }) => ({
  creator: one(users, { fields: [clinicalPearls.created_by], references: [users.id] }),
}));
```

---

#### File 2: `src/db/index.ts`
Database client factory initializing Drizzle with the Cloudflare D1 binding and schema definition:

```typescript
import { drizzle, DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema';

/**
 * Creates a type-safe Drizzle ORM client connected to Cloudflare D1.
 * Passes the complete schema so that relational queries (`db.query.*`) are fully typed.
 * 
 * @param d1 - The Cloudflare D1 database binding (e.g. `c.env.DB`)
 * @returns Fully typed Drizzle D1 database instance
 */
export function createDb(d1: D1Database): DrizzleD1Database<typeof schema> {
  return drizzle(d1, { schema });
}

export type Database = DrizzleD1Database<typeof schema>;
```

---

#### File 3: `migrations/0000_initial_schema.sql`
Raw SQLite DDL ready for deployment to Cloudflare D1. Structured in strict topological order with all foreign keys, cascades, unique constraints, and 58 performance indexes:

```sql
-- ============================================================================
-- Migration: 0000_initial_schema.sql
-- Description: Initial schema creation for Nabd/Kiur platform (Cloudflare D1 / SQLite)
-- Created for Milestone 1: Foundation & Database Layer
-- Covers all 30 tables, 5 enums, primary keys, foreign keys, cascades, and indexes
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------------------------
-- 1. SECTIONS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sections (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL
);

-- ----------------------------------------------------------------------------
-- 2. UNIVERSITIES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS universities (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    section_id TEXT NOT NULL REFERENCES sections(id)
);
CREATE INDEX IF NOT EXISTS universities_section_id_idx ON universities(section_id);

-- ----------------------------------------------------------------------------
-- 3. STAGES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stages (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    university_id TEXT NOT NULL REFERENCES universities(id)
);
CREATE INDEX IF NOT EXISTS stages_university_id_idx ON stages(university_id);

-- ----------------------------------------------------------------------------
-- 4. SUBJECTS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    stage_id TEXT NOT NULL REFERENCES stages(id)
);
CREATE INDEX IF NOT EXISTS subjects_stage_id_idx ON subjects(stage_id);

-- ----------------------------------------------------------------------------
-- 5. USERS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL,
    full_name TEXT NOT NULL,
    google_sub TEXT,
    password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'student',
    university_id TEXT REFERENCES universities(id),
    stage_id TEXT REFERENCES stages(id),
    section_id TEXT REFERENCES sections(id),
    phone TEXT,
    is_graduate INTEGER,
    is_banned INTEGER NOT NULL DEFAULT 0,
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    photo_url TEXT,
    caption TEXT,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    failed_redeem_attempts INTEGER NOT NULL DEFAULT 0,
    reset_token_hash TEXT,
    reset_token_expires_at TEXT,
    reset_requested_at TEXT,
    password_changed_at TEXT,
    redeem_locked_until TEXT,
    theme TEXT NOT NULL DEFAULT 'light',
    language TEXT NOT NULL DEFAULT 'ar',
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx ON users(google_sub);
CREATE INDEX IF NOT EXISTS users_university_id_idx ON users(university_id);
CREATE INDEX IF NOT EXISTS users_stage_id_idx ON users(stage_id);
CREATE INDEX IF NOT EXISTS users_section_id_idx ON users(section_id);

-- ----------------------------------------------------------------------------
-- 6. USER SESSIONS (Anti-Piracy Single Active Session)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_label TEXT NOT NULL DEFAULT 'جهاز غير معروف',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS user_sessions_user_active_idx ON user_sessions(user_id, is_active);

-- ----------------------------------------------------------------------------
-- 7. PROFESSOR PROFILES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS professor_profiles (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL DEFAULT 'أستاذ مساعد',
    subject_id TEXT NOT NULL REFERENCES subjects(id),
    bio TEXT NOT NULL DEFAULT '',
    photo_url TEXT
);
CREATE INDEX IF NOT EXISTS professor_profiles_user_id_idx ON professor_profiles(user_id);
CREATE INDEX IF NOT EXISTS professor_profiles_subject_id_idx ON professor_profiles(subject_id);

-- ----------------------------------------------------------------------------
-- 8. BOOKLETS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booklets (
    id TEXT PRIMARY KEY NOT NULL,
    professor_id TEXT NOT NULL REFERENCES professor_profiles(id),
    title TEXT NOT NULL,
    file_url TEXT NOT NULL DEFAULT '',
    pages INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS booklets_professor_id_idx ON booklets(professor_id);

-- ----------------------------------------------------------------------------
-- 9. QUESTIONS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY NOT NULL,
    subject_id TEXT NOT NULL REFERENCES subjects(id),
    professor_id TEXT REFERENCES professor_profiles(id),
    text TEXT NOT NULL,
    image_url TEXT,
    rationale TEXT NOT NULL DEFAULT '',
    eyebrow TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS questions_subject_id_idx ON questions(subject_id);
CREATE INDEX IF NOT EXISTS questions_professor_id_idx ON questions(professor_id);

-- ----------------------------------------------------------------------------
-- 10. CHOICES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS choices (
    id TEXT PRIMARY KEY NOT NULL,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    is_correct INTEGER NOT NULL DEFAULT 0,
    order_index INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS choices_question_id_idx ON choices(question_id);

-- ----------------------------------------------------------------------------
-- 11. STUDENT ANSWERS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_answers (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    question_id TEXT NOT NULL REFERENCES questions(id),
    choice_id TEXT NOT NULL REFERENCES choices(id),
    is_correct INTEGER NOT NULL,
    answered_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS student_answers_user_id_idx ON student_answers(user_id);
CREATE INDEX IF NOT EXISTS student_answers_question_id_idx ON student_answers(question_id);
CREATE INDEX IF NOT EXISTS student_answers_user_answered_idx ON student_answers(user_id, answered_at);

-- ----------------------------------------------------------------------------
-- 12. EXAMS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exams (
    id TEXT PRIMARY KEY NOT NULL,
    subject_id TEXT NOT NULL REFERENCES subjects(id),
    professor_id TEXT REFERENCES professor_profiles(id),
    title TEXT NOT NULL,
    question_count INTEGER NOT NULL DEFAULT 0,
    duration_minutes INTEGER NOT NULL DEFAULT 30
);
CREATE INDEX IF NOT EXISTS exams_subject_id_idx ON exams(subject_id);
CREATE INDEX IF NOT EXISTS exams_professor_id_idx ON exams(professor_id);

-- ----------------------------------------------------------------------------
-- 13. COURSES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY NOT NULL,
    subject_id TEXT NOT NULL REFERENCES subjects(id),
    professor_id TEXT REFERENCES professor_profiles(id),
    title TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS courses_subject_id_idx ON courses(subject_id);
CREATE INDEX IF NOT EXISTS courses_professor_id_idx ON courses(professor_id);

-- ----------------------------------------------------------------------------
-- 14. LECTURES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lectures (
    id TEXT PRIMARY KEY NOT NULL,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    order_index INTEGER NOT NULL DEFAULT 0,
    video_url TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS lectures_course_id_idx ON lectures(course_id);

-- ----------------------------------------------------------------------------
-- 15. RECENT VIEWS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recent_views (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    content_type TEXT NOT NULL,
    content_id TEXT NOT NULL,
    viewed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS recent_views_user_id_idx ON recent_views(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS recent_views_user_content_idx ON recent_views(user_id, content_type, content_id);

-- ----------------------------------------------------------------------------
-- 16. LECTURE PROGRESS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lecture_progress (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    lecture_id TEXT NOT NULL REFERENCES lectures(id),
    completed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS lecture_progress_user_id_idx ON lecture_progress(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS lecture_progress_user_lecture_idx ON lecture_progress(user_id, lecture_id);

-- ----------------------------------------------------------------------------
-- 17. PRODUCTS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    type TEXT NOT NULL,
    is_activation_code INTEGER NOT NULL DEFAULT 0,
    grants_subject_id TEXT REFERENCES subjects(id)
);
CREATE INDEX IF NOT EXISTS products_grants_subject_id_idx ON products(grants_subject_id);

-- ----------------------------------------------------------------------------
-- 18. ORDERS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    total INTEGER NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT 'zaincash',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    delivery_name TEXT,
    delivery_phone TEXT,
    delivery_address TEXT
);
CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders(user_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);

-- ----------------------------------------------------------------------------
-- 19. ORDER ITEMS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY NOT NULL,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id),
    qty INTEGER NOT NULL DEFAULT 1,
    price INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON order_items(order_id);
CREATE INDEX IF NOT EXISTS order_items_product_id_idx ON order_items(product_id);

-- ----------------------------------------------------------------------------
-- 20. ACTIVATION CODES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activation_codes (
    id TEXT PRIMARY KEY NOT NULL,
    code TEXT NOT NULL,
    subject_id TEXT REFERENCES subjects(id),
    status TEXT NOT NULL DEFAULT 'idle',
    activated_by_user_id TEXT REFERENCES users(id),
    activated_at TEXT,
    expires_at TEXT,
    reseller_id TEXT REFERENCES users(id),
    sold_at TEXT,
    order_id TEXT REFERENCES orders(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS activation_codes_code_idx ON activation_codes(code);
CREATE INDEX IF NOT EXISTS activation_codes_subject_id_idx ON activation_codes(subject_id);
CREATE INDEX IF NOT EXISTS activation_codes_reseller_id_idx ON activation_codes(reseller_id);
CREATE INDEX IF NOT EXISTS activation_codes_order_id_idx ON activation_codes(order_id);

-- ----------------------------------------------------------------------------
-- 21. BAN RECORDS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ban_records (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    appeal_message TEXT,
    appealed_at TEXT
);
CREATE INDEX IF NOT EXISTS ban_records_user_id_idx ON ban_records(user_id);
CREATE INDEX IF NOT EXISTS ban_records_status_idx ON ban_records(status);

-- ----------------------------------------------------------------------------
-- 22. ACTIVITY LOGS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT REFERENCES users(id),
    action TEXT NOT NULL,
    ip_address TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS activity_logs_user_id_idx ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS activity_logs_created_at_idx ON activity_logs(created_at);

-- ----------------------------------------------------------------------------
-- 23. MEDIA FILES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_files (
    id TEXT PRIMARY KEY NOT NULL,
    filename TEXT NOT NULL,
    url TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    uploaded_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS media_files_filename_idx ON media_files(filename);
CREATE INDEX IF NOT EXISTS media_files_uploaded_by_idx ON media_files(uploaded_by);

-- ----------------------------------------------------------------------------
-- 24. EXAM ATTEMPTS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exam_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    exam_id TEXT NOT NULL REFERENCES exams(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    started_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    finished_at TEXT,
    score INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS exam_attempts_exam_id_idx ON exam_attempts(exam_id);
CREATE INDEX IF NOT EXISTS exam_attempts_user_id_idx ON exam_attempts(user_id);

-- ----------------------------------------------------------------------------
-- 25. EXAM ATTEMPT QUESTIONS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exam_attempt_questions (
    id TEXT PRIMARY KEY NOT NULL,
    attempt_id TEXT NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES questions(id),
    order_index INTEGER NOT NULL DEFAULT 0,
    choice_id TEXT REFERENCES choices(id),
    is_correct INTEGER,
    answered_at TEXT
);
CREATE INDEX IF NOT EXISTS exam_attempt_questions_attempt_id_idx ON exam_attempt_questions(attempt_id);
CREATE INDEX IF NOT EXISTS exam_attempt_questions_question_id_idx ON exam_attempt_questions(question_id);

-- ----------------------------------------------------------------------------
-- 26. USER SKILLS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_skills (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS user_skills_user_id_idx ON user_skills(user_id);

-- ----------------------------------------------------------------------------
-- 27. SAVED QUESTIONS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_questions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    question_id TEXT NOT NULL REFERENCES questions(id),
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS saved_questions_user_id_idx ON saved_questions(user_id);
CREATE INDEX IF NOT EXISTS saved_questions_question_id_idx ON saved_questions(question_id);
CREATE UNIQUE INDEX IF NOT EXISTS saved_questions_user_question_idx ON saved_questions(user_id, question_id);

-- ----------------------------------------------------------------------------
-- 28. NOTIFICATIONS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT REFERENCES users(id),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    created_by TEXT REFERENCES users(id),
    content_type TEXT,
    content_id TEXT
);
CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON notifications(user_id);
CREATE INDEX IF NOT EXISTS notifications_created_at_idx ON notifications(created_at);

-- ----------------------------------------------------------------------------
-- 29. NOTIFICATION READS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_reads (
    id TEXT PRIMARY KEY NOT NULL,
    notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS notification_reads_notification_id_idx ON notification_reads(notification_id);
CREATE INDEX IF NOT EXISTS notification_reads_user_id_idx ON notification_reads(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS notification_reads_notif_user_idx ON notification_reads(notification_id, user_id);

-- ----------------------------------------------------------------------------
-- 30. CLINICAL PEARLS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinical_pearls (
    id TEXT PRIMARY KEY NOT NULL,
    tag TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    created_by TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS clinical_pearls_created_at_idx ON clinical_pearls(created_at);
CREATE INDEX IF NOT EXISTS clinical_pearls_created_by_idx ON clinical_pearls(created_by);
```

---

## 5. Verification Method

### 5.1 Independent Verification Command
The entire raw SQLite DDL migration script was executed and verified against an in-memory SQLite database using Node.js (`node:sqlite`).

Execute the verification script:
```powershell
node .agents/teamwork_preview_explorer_m1_2/test_ddl.mjs
```

**Verifiable Output**:
```
Total tables created: 30
Tables: ["sections","universities","stages","subjects","users","user_sessions","professor_profiles","booklets","questions","choices","student_answers","exams","courses","lectures","recent_views","lecture_progress","products","orders","order_items","activation_codes","ban_records","activity_logs","media_files","exam_attempts","exam_attempt_questions","user_skills","saved_questions","notifications","notification_reads","clinical_pearls"]
Total indexes created: 58
Foreign key integrity check errors: 0
Session created: true
Session cascade-deleted after user deletion: true
ALL DDL TESTS PASSED PERFECTLY!
```

### 5.2 Direct SQL File Execution Check
```powershell
node -e "import('node:sqlite').then(s => { const fs = require('fs'); const sql = fs.readFileSync('.agents/teamwork_preview_explorer_m1_2/proposed_0000_initial_schema.sql', 'utf8'); const db = new s.DatabaseSync(':memory:'); db.exec(sql); const tables = db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name NOT LIKE \'sqlite_%\'').all(); console.log('Parsed tables from proposed_0000_initial_schema.sql:', tables.length); });"
```
**Expected Output**: `Parsed tables from proposed_0000_initial_schema.sql: 30`

### 5.3 Downstream Implementation Mapping
When the implementation agent scaffolds Milestone 1:
1. Copy `.agents/teamwork_preview_explorer_m1_2/proposed_schema.ts` to `src/db/schema.ts`.
2. Copy `.agents/teamwork_preview_explorer_m1_2/proposed_db_index.ts` to `src/db/index.ts`.
3. Copy `.agents/teamwork_preview_explorer_m1_2/proposed_0000_initial_schema.sql` to `migrations/0000_initial_schema.sql`.
4. Apply the migration locally via Wrangler:
   ```bash
   npx wrangler d1 execute DB --local --file=migrations/0000_initial_schema.sql
   ```
