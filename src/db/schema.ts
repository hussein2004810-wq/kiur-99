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

export const universityTypes = ['government', 'private'] as const;
export type UniversityType = (typeof universityTypes)[number];

export const studySystems = ['modular', 'traditional'] as const;
export type StudySystem = (typeof studySystems)[number];

export const subjectTerms = ['annual', 'semester_1', 'semester_2', 'modular_block'] as const;
export type SubjectTerm = (typeof subjectTerms)[number];

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
// 2. UNIVERSITIES (الجامعات العراقية)
// ============================================================================
export const universities = sqliteTable('universities', {
  id: text('id').primaryKey().$defaultFn(genId),
  name: text('name').notNull(),
  type: text('type', { enum: universityTypes }).notNull().default('government'),
  province: text('province'),
  logo_url: text('logo_url'),
  section_id: text('section_id').references(() => sections.id),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  section_id_idx: index('universities_section_id_idx').on(table.section_id),
  type_idx: index('universities_type_idx').on(table.type),
  province_idx: index('universities_province_idx').on(table.province),
}));

export type University = InferSelectModel<typeof universities>;
export type NewUniversity = InferInsertModel<typeof universities>;

// ============================================================================
// 2b. COLLEGES (كليات المجموعة الطبية)
// ============================================================================
export const colleges = sqliteTable('colleges', {
  id: text('id').primaryKey().$defaultFn(genId),
  name: text('name').notNull(),
  code: text('code'),
  default_stages: integer('default_stages').notNull().default(6),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export type College = InferSelectModel<typeof colleges>;
export type NewCollege = InferInsertModel<typeof colleges>;

// ============================================================================
// 2c. COLLEGE PROGRAMS (ربط الجامعة بالكلية والنظام الدراسي)
// ============================================================================
export const collegePrograms = sqliteTable('college_programs', {
  id: text('id').primaryKey().$defaultFn(genId),
  university_id: text('university_id').notNull().references(() => universities.id, { onDelete: 'cascade' }),
  college_id: text('college_id').notNull().references(() => colleges.id, { onDelete: 'cascade' }),
  system_type: text('system_type', { enum: studySystems }).notNull().default('traditional'),
  total_stages: integer('total_stages').notNull().default(6),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  uni_college_idx: uniqueIndex('college_programs_uni_college_idx').on(table.university_id, table.college_id),
  university_id_idx: index('college_programs_university_id_idx').on(table.university_id),
  college_id_idx: index('college_programs_college_id_idx').on(table.college_id),
}));

export type CollegeProgram = InferSelectModel<typeof collegePrograms>;
export type NewCollegeProgram = InferInsertModel<typeof collegePrograms>;

// ============================================================================
// 2d. DEPARTMENTS (الأقسام الطبية والعلمية داخل الكلية)
// ============================================================================
export const departments = sqliteTable('departments', {
  id: text('id').primaryKey().$defaultFn(genId),
  college_id: text('college_id').notNull().references(() => colleges.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  code: text('code'),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  college_id_idx: index('departments_college_id_idx').on(table.college_id),
}));

export type Department = InferSelectModel<typeof departments>;
export type NewDepartment = InferInsertModel<typeof departments>;

// ============================================================================
// 3. STAGES (المراحل الدراسية)
// ============================================================================
export const stages = sqliteTable('stages', {
  id: text('id').primaryKey().$defaultFn(genId),
  name: text('name').notNull(),
  stage_number: integer('stage_number'),
  university_id: text('university_id').references(() => universities.id),
  program_id: text('program_id').references(() => collegePrograms.id),
  college_id: text('college_id').references(() => colleges.id),
  department_id: text('department_id').references(() => departments.id, { onDelete: 'cascade' }),
}, (table) => ({
  university_id_idx: index('stages_university_id_idx').on(table.university_id),
  program_id_idx: index('stages_program_id_idx').on(table.program_id),
  college_id_idx: index('stages_college_id_idx').on(table.college_id),
  department_id_idx: index('stages_department_id_idx').on(table.department_id),
}));

export type Stage = InferSelectModel<typeof stages>;
export type NewStage = InferInsertModel<typeof stages>;

// ============================================================================
// 3b. STUDY SECTIONS (الشعب والمجموعات الدراسية داخل المرحلة)
// ============================================================================
export const studySections = sqliteTable('study_sections', {
  id: text('id').primaryKey().$defaultFn(genId),
  stage_id: text('stage_id').notNull().references(() => stages.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  stage_id_idx: index('study_sections_stage_id_idx').on(table.stage_id),
}));

export type StudySection = InferSelectModel<typeof studySections>;
export type NewStudySection = InferInsertModel<typeof studySections>;

// ============================================================================
// 4. SUBJECTS (المواد والموديولات)
// ============================================================================
export const subjects = sqliteTable('subjects', {
  id: text('id').primaryKey().$defaultFn(genId),
  name: text('name').notNull(),
  code: text('code'),
  stage_id: text('stage_id').notNull().references(() => stages.id),
  term: text('term', { enum: subjectTerms }).notNull().default('annual'),
  is_ministerial: integer('is_ministerial', { mode: 'boolean' }).notNull().default(false),
  has_practical: integer('has_practical', { mode: 'boolean' }).notNull().default(false),
  is_deleted: integer('is_deleted', { mode: 'boolean' }).notNull().default(false),
  deleted_at: text('deleted_at'),
}, (table) => ({
  stage_id_idx: index('subjects_stage_id_idx').on(table.stage_id),
  is_ministerial_idx: index('subjects_is_ministerial_idx').on(table.is_ministerial),
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
  college_id: text('college_id').references(() => colleges.id),
  department_id: text('department_id').references(() => departments.id),
  stage_id: text('stage_id').references(() => stages.id),
  study_section_id: text('study_section_id').references(() => studySections.id),
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
  firebase_uid: text('firebase_uid'),
  email_verified_at: text('email_verified_at'),
  session_epoch: integer('session_epoch').notNull().default(1),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  email_idx: uniqueIndex('users_email_idx').on(table.email),
  google_sub_idx: uniqueIndex('users_google_sub_idx').on(table.google_sub),
  firebase_uid_idx: uniqueIndex('users_firebase_uid_idx').on(table.firebase_uid),
  email_verified_idx: index('users_email_verified_idx').on(table.email_verified_at),
  university_id_idx: index('users_university_id_idx').on(table.university_id),
  college_id_idx: index('users_college_id_idx').on(table.college_id),
  department_id_idx: index('users_department_id_idx').on(table.department_id),
  stage_id_idx: index('users_stage_id_idx').on(table.stage_id),
  study_section_id_idx: index('users_study_section_id_idx').on(table.study_section_id),
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
// 6b. OAUTH HANDOFFS (one-time browser redirect exchange)
// ============================================================================
export const oauthHandoffs = sqliteTable('oauth_handoffs', {
  id: text('id').primaryKey().$defaultFn(genId),
  token_hash: text('token_hash').notNull().unique(),
  session_id: text('session_id').references(() => userSessions.id, { onDelete: 'cascade' }),
  user_id: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  redirect_origin: text('redirect_origin').notNull(),
  expires_at: text('expires_at').notNull(),
  consumed_at: text('consumed_at'),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  expires_at_idx: index('oauth_handoffs_expires_at_idx').on(table.expires_at),
}));

export type OAuthHandoff = InferSelectModel<typeof oauthHandoffs>;
export type NewOAuthHandoff = InferInsertModel<typeof oauthHandoffs>;

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
  is_deleted: integer('is_deleted', { mode: 'boolean' }).notNull().default(false),
  deleted_at: text('deleted_at'),
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
  is_deleted: integer('is_deleted', { mode: 'boolean' }).notNull().default(false),
  deleted_at: text('deleted_at'),
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
  is_deleted: integer('is_deleted', { mode: 'boolean' }).notNull().default(false),
  deleted_at: text('deleted_at'),
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
  is_deleted: integer('is_deleted', { mode: 'boolean' }).notNull().default(false),
  deleted_at: text('deleted_at'),
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
  revision: integer('revision').notNull().default(1),
  start_idempotency_key: text('start_idempotency_key'),
  finish_idempotency_key: text('finish_idempotency_key'),
}, (table) => ({
  exam_id_idx: index('exam_attempts_exam_id_idx').on(table.exam_id),
  user_id_idx: index('exam_attempts_user_id_idx').on(table.user_id),
  open_attempt_idx: uniqueIndex('exam_attempts_one_open_user_exam_idx').on(table.exam_id, table.user_id).where(sql`finished_at IS NULL`),
  start_idempotency_idx: uniqueIndex('exam_attempts_start_idempotency_idx').on(table.user_id, table.exam_id, table.start_idempotency_key).where(sql`start_idempotency_key IS NOT NULL`),
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
  question_snapshot: text('question_snapshot'),
  choices_snapshot: text('choices_snapshot'),
}, (table) => ({
  attempt_id_idx: index('exam_attempt_questions_attempt_id_idx').on(table.attempt_id),
  question_id_idx: index('exam_attempt_questions_question_id_idx').on(table.question_id),
  attempt_question_idx: uniqueIndex('exam_attempt_questions_attempt_question_idx').on(table.attempt_id, table.question_id),
  attempt_order_idx: uniqueIndex('exam_attempt_questions_attempt_order_idx').on(table.attempt_id, table.order_index),
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
// 31. EMAIL VERIFICATIONS
// ============================================================================
export const emailVerifications = sqliteTable('email_verifications', {
  id: text('id').primaryKey().$defaultFn(genId),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token_hash: text('token_hash').notNull(),
  expires_at: text('expires_at').notNull(),
  verified_at: text('verified_at'),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  user_id_idx: index('email_verifications_user_idx').on(table.user_id),
  token_hash_idx: index('email_verifications_token_idx').on(table.token_hash),
}));

export type EmailVerification = InferSelectModel<typeof emailVerifications>;
export type NewEmailVerification = InferInsertModel<typeof emailVerifications>;

// ============================================================================
// 32. ACCOUNT EVENTS (Security & Audit Trail)
// ============================================================================
export const accountEvents = sqliteTable('account_events', {
  id: text('id').primaryKey().$defaultFn(genId),
  user_id: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  email_hash: text('email_hash'),
  event_type: text('event_type').notNull(),
  outcome: text('outcome').notNull(), // 'success' | 'failure'
  device_hash: text('device_hash').notNull(),
  ip_hash: text('ip_hash').notNull(),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  details_json: text('details_json'),
}, (table) => ({
  user_id_idx: index('account_events_user_idx').on(table.user_id, table.created_at),
  recent_idx: index('account_events_recent_idx').on(table.created_at),
}));

export type AccountEvent = InferSelectModel<typeof accountEvents>;
export type NewAccountEvent = InferInsertModel<typeof accountEvents>;

// ============================================================================
// 33. ACADEMIC CHANGE REQUESTS
// ============================================================================
export const academicChangeRequests = sqliteTable('academic_change_requests', {
  id: text('id').primaryKey().$defaultFn(genId),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  current_section_id: text('current_section_id'),
  current_university_id: text('current_university_id'),
  current_stage_id: text('current_stage_id'),
  target_section_id: text('target_section_id').references(() => sections.id),
  target_university_id: text('target_university_id').references(() => universities.id),
  target_stage_id: text('target_stage_id').references(() => stages.id),
  reason: text('reason').notNull(),
  status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'rejected'
  reviewer_id: text('reviewer_id').references(() => users.id),
  reviewer_notes: text('reviewer_notes'),
  reviewed_at: text('reviewed_at'),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  user_id_idx: index('academic_change_user_idx').on(table.user_id),
  status_idx: index('academic_change_status_idx').on(table.status),
}));

export type AcademicChangeRequest = InferSelectModel<typeof academicChangeRequests>;
export type NewAcademicChangeRequest = InferInsertModel<typeof academicChangeRequests>;

// ============================================================================
// 34. CERTIFICATES
// ============================================================================
export const certificates = sqliteTable('certificates', {
  id: text('id').primaryKey().$defaultFn(genId),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  exam_id: text('exam_id').notNull().references(() => exams.id),
  certificate_code: text('certificate_code').notNull().unique(),
  student_name: text('student_name').notNull(),
  exam_title: text('exam_title').notNull(),
  score_percentage: integer('score_percentage').notNull(),
  issued_at: text('issued_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  is_revoked: integer('is_revoked', { mode: 'boolean' }).notNull().default(false),
  revoked_at: text('revoked_at'),
  revocation_reason: text('revocation_reason'),
}, (table) => ({
  code_idx: uniqueIndex('certificates_code_idx').on(table.certificate_code),
  user_id_idx: index('certificates_user_idx').on(table.user_id),
}));

export type Certificate = InferSelectModel<typeof certificates>;
export type NewCertificate = InferInsertModel<typeof certificates>;

// ============================================================================
// 35. STUDENT REVIEWS (Spaced Repetition Queue)
// ============================================================================
export const studentReviews = sqliteTable('student_reviews', {
  id: text('id').primaryKey().$defaultFn(genId),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  question_id: text('question_id').notNull().references(() => questions.id, { onDelete: 'cascade' }),
  ease_factor: text('ease_factor').notNull().default('2.5'),
  interval_days: integer('interval_days').notNull().default(1),
  repetition_count: integer('repetition_count').notNull().default(0),
  next_review_at: text('next_review_at').notNull(),
  last_reviewed_at: text('last_reviewed_at'),
  last_score: integer('last_score'),
}, (table) => ({
  user_id_idx: index('student_reviews_user_idx').on(table.user_id, table.next_review_at),
  user_q_idx: uniqueIndex('student_reviews_user_q_idx').on(table.user_id, table.question_id),
}));

export type StudentReview = InferSelectModel<typeof studentReviews>;
export type NewStudentReview = InferInsertModel<typeof studentReviews>;

// ============================================================================
// DRIZZLE RELATIONS (For Type-Safe Relational Queries)
// ============================================================================

export const usersRelations = relations(users, ({ one, many }) => ({
  university: one(universities, { fields: [users.university_id], references: [universities.id] }),
  college: one(colleges, { fields: [users.college_id], references: [colleges.id] }),
  department: one(departments, { fields: [users.department_id], references: [departments.id] }),
  stage: one(stages, { fields: [users.stage_id], references: [stages.id] }),
  study_section: one(studySections, { fields: [users.study_section_id], references: [studySections.id] }),
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

export const collegesRelations = relations(colleges, ({ many }) => ({
  programs: many(collegePrograms),
  departments: many(departments),
  stages: many(stages),
  users: many(users),
}));

export const departmentsRelations = relations(departments, ({ one, many }) => ({
  college: one(colleges, { fields: [departments.college_id], references: [colleges.id] }),
  stages: many(stages),
  users: many(users),
}));

export const collegeProgramsRelations = relations(collegePrograms, ({ one, many }) => ({
  university: one(universities, { fields: [collegePrograms.university_id], references: [universities.id] }),
  college: one(colleges, { fields: [collegePrograms.college_id], references: [colleges.id] }),
  stages: many(stages),
}));

export const universitiesRelations = relations(universities, ({ one, many }) => ({
  section: one(sections, { fields: [universities.section_id], references: [sections.id] }),
  programs: many(collegePrograms),
  stages: many(stages),
  users: many(users),
}));

export const stagesRelations = relations(stages, ({ one, many }) => ({
  university: one(universities, { fields: [stages.university_id], references: [universities.id] }),
  program: one(collegePrograms, { fields: [stages.program_id], references: [collegePrograms.id] }),
  college: one(colleges, { fields: [stages.college_id], references: [colleges.id] }),
  department: one(departments, { fields: [stages.department_id], references: [departments.id] }),
  study_sections: many(studySections),
  subjects: many(subjects),
  users: many(users),
}));

export const studySectionsRelations = relations(studySections, ({ one, many }) => ({
  stage: one(stages, { fields: [studySections.stage_id], references: [stages.id] }),
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

// ============================================================================
// 36. CLINICAL GLIMPSES (اللمحات السريرية)
// ============================================================================
export const clinicalGlimpseStatuses = ['draft', 'in_review', 'approved', 'published', 'archived'] as const;
export type ClinicalGlimpseStatus = (typeof clinicalGlimpseStatuses)[number];

export const clinicalGlimpseActions = [
  'create',
  'update',
  'submit_review',
  'return_draft',
  'approve',
  'publish',
  'archive',
  'restore',
  'delete_forever',
] as const;
export type ClinicalGlimpseAction = (typeof clinicalGlimpseActions)[number];

export const clinicalGlimpses = sqliteTable('clinical_glimpses', {
  id: text('id').primaryKey().$defaultFn(genId),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  clinical_point: text('clinical_point').notNull(),
  warning: text('warning'),
  image_id: text('image_id').references(() => mediaFiles.id),
  reference_text: text('reference_text'),
  publish_at: text('publish_at'),
  status: text('status', { enum: clinicalGlimpseStatuses }).notNull().default('draft'),
  audience_all: integer('audience_all', { mode: 'boolean' }).notNull().default(true),
  created_by: text('created_by').notNull().references(() => users.id),
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updated_by: text('updated_by').notNull().references(() => users.id),
  updated_at: text('updated_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  reviewed_by: text('reviewed_by').references(() => users.id),
  reviewed_at: text('reviewed_at'),
  approved_by: text('approved_by').references(() => users.id),
  approved_at: text('approved_at'),
  published_by: text('published_by').references(() => users.id),
  published_at: text('published_at'),
  deleted_at: text('deleted_at'),
  deleted_by: text('deleted_by').references(() => users.id),
}, (table) => ({
  status_idx: index('clinical_glimpses_status_idx').on(table.status),
  publish_at_idx: index('clinical_glimpses_publish_at_idx').on(table.publish_at),
  created_by_idx: index('clinical_glimpses_created_by_idx').on(table.created_by),
  deleted_at_idx: index('clinical_glimpses_deleted_at_idx').on(table.deleted_at),
}));

export type ClinicalGlimpse = InferSelectModel<typeof clinicalGlimpses>;
export type NewClinicalGlimpse = InferInsertModel<typeof clinicalGlimpses>;

// ============================================================================
// 37. CLINICAL GLIMPSE TARGETS
// ============================================================================
export const clinicalGlimpseTargets = sqliteTable('clinical_glimpse_targets', {
  id: text('id').primaryKey().$defaultFn(genId),
  glimpse_id: text('glimpse_id').notNull().references(() => clinicalGlimpses.id, { onDelete: 'cascade' }),
  university_id: text('university_id').references(() => universities.id),
  college_id: text('college_id'),
  department_id: text('department_id'),
  phase_id: text('phase_id'),
  stage_id: text('stage_id').references(() => stages.id),
}, (table) => ({
  glimpse_id_idx: index('clinical_glimpse_targets_glimpse_id_idx').on(table.glimpse_id),
  scope_idx: index('clinical_glimpse_targets_scope_idx').on(table.university_id, table.college_id, table.department_id, table.phase_id, table.glimpse_id),
}));

export type ClinicalGlimpseTarget = InferSelectModel<typeof clinicalGlimpseTargets>;
export type NewClinicalGlimpseTarget = InferInsertModel<typeof clinicalGlimpseTargets>;

// ============================================================================
// 38. CLINICAL GLIMPSE LOGS
// ============================================================================
export const clinicalGlimpseLogs = sqliteTable('clinical_glimpse_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  glimpse_id: text('glimpse_id').notNull(),
  action: text('action', { enum: clinicalGlimpseActions }).notNull(),
  by_user_id: text('by_user_id').notNull().references(() => users.id),
  at: text('at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  details_json: text('details_json'),
}, (table) => ({
  glimpse_id_idx: index('clinical_glimpse_logs_glimpse_id_idx').on(table.glimpse_id),
  at_idx: index('clinical_glimpse_logs_at_idx').on(table.at),
}));

export type ClinicalGlimpseLog = InferSelectModel<typeof clinicalGlimpseLogs>;
export type NewClinicalGlimpseLog = InferInsertModel<typeof clinicalGlimpseLogs>;

// ============================================================================
// DRIZZLE RELATIONS (For Type-Safe Relational Queries)
// ============================================================================

export const clinicalPearlsRelations = relations(clinicalPearls, ({ one }) => ({
  creator: one(users, { fields: [clinicalPearls.created_by], references: [users.id] }),
}));

export const clinicalGlimpsesRelations = relations(clinicalGlimpses, ({ one, many }) => ({
  creator: one(users, { fields: [clinicalGlimpses.created_by], references: [users.id] }),
  editor: one(users, { fields: [clinicalGlimpses.updated_by], references: [users.id] }),
  reviewer: one(users, { fields: [clinicalGlimpses.reviewed_by], references: [users.id] }),
  approver: one(users, { fields: [clinicalGlimpses.approved_by], references: [users.id] }),
  publisher: one(users, { fields: [clinicalGlimpses.published_by], references: [users.id] }),
  image: one(mediaFiles, { fields: [clinicalGlimpses.image_id], references: [mediaFiles.id] }),
  targets: many(clinicalGlimpseTargets),
}));

export const clinicalGlimpseTargetsRelations = relations(clinicalGlimpseTargets, ({ one }) => ({
  glimpse: one(clinicalGlimpses, { fields: [clinicalGlimpseTargets.glimpse_id], references: [clinicalGlimpses.id] }),
  university: one(universities, { fields: [clinicalGlimpseTargets.university_id], references: [universities.id] }),
  stage: one(stages, { fields: [clinicalGlimpseTargets.stage_id], references: [stages.id] }),
}));

export const clinicalGlimpseLogsRelations = relations(clinicalGlimpseLogs, ({ one }) => ({
  actor: one(users, { fields: [clinicalGlimpseLogs.by_user_id], references: [users.id] }),
}));
