PRAGMA foreign_keys = ON;

-- 1. sections
CREATE TABLE IF NOT EXISTS sections (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL
);

-- 2. universities
CREATE TABLE IF NOT EXISTS universities (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'government',
    province TEXT,
    logo_url TEXT,
    section_id TEXT REFERENCES sections(id),
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS universities_section_id_idx ON universities(section_id);
CREATE INDEX IF NOT EXISTS universities_type_idx ON universities(type);
CREATE INDEX IF NOT EXISTS universities_province_idx ON universities(province);

-- 2b. colleges
CREATE TABLE IF NOT EXISTS colleges (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    code TEXT,
    default_stages INTEGER NOT NULL DEFAULT 6,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- 2c. college_programs
CREATE TABLE IF NOT EXISTS college_programs (
    id TEXT PRIMARY KEY NOT NULL,
    university_id TEXT NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
    college_id TEXT NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
    system_type TEXT NOT NULL DEFAULT 'traditional',
    total_stages INTEGER NOT NULL DEFAULT 6,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS college_programs_uni_college_idx ON college_programs(university_id, college_id);
CREATE INDEX IF NOT EXISTS college_programs_university_id_idx ON college_programs(university_id);
CREATE INDEX IF NOT EXISTS college_programs_college_id_idx ON college_programs(college_id);

-- 3. stages
CREATE TABLE IF NOT EXISTS stages (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    stage_number INTEGER,
    university_id TEXT REFERENCES universities(id),
    program_id TEXT REFERENCES college_programs(id),
    college_id TEXT REFERENCES colleges(id)
);
CREATE INDEX IF NOT EXISTS stages_university_id_idx ON stages(university_id);
CREATE INDEX IF NOT EXISTS stages_program_id_idx ON stages(program_id);
CREATE INDEX IF NOT EXISTS stages_college_id_idx ON stages(college_id);

-- 4. subjects
CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    code TEXT,
    stage_id TEXT NOT NULL REFERENCES stages(id),
    term TEXT NOT NULL DEFAULT 'annual',
    is_ministerial INTEGER NOT NULL DEFAULT 0,
    has_practical INTEGER NOT NULL DEFAULT 0,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS subjects_stage_id_idx ON subjects(stage_id);
CREATE INDEX IF NOT EXISTS subjects_is_ministerial_idx ON subjects(is_ministerial);

-- 5. users
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
    firebase_uid TEXT,
    email_verified_at TEXT,
    session_epoch INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx ON users(google_sub);
CREATE UNIQUE INDEX IF NOT EXISTS users_firebase_uid_idx ON users(firebase_uid);
CREATE INDEX IF NOT EXISTS users_email_verified_idx ON users(email_verified_at);
CREATE INDEX IF NOT EXISTS users_university_id_idx ON users(university_id);
CREATE INDEX IF NOT EXISTS users_stage_id_idx ON users(stage_id);
CREATE INDEX IF NOT EXISTS users_section_id_idx ON users(section_id);

-- 6. user_sessions
CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_label TEXT NOT NULL DEFAULT 'جهاز غير معروف',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS user_sessions_user_active_idx ON user_sessions(user_id, is_active);

-- 7. professor_profiles
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

-- 8. booklets
CREATE TABLE IF NOT EXISTS booklets (
    id TEXT PRIMARY KEY NOT NULL,
    professor_id TEXT NOT NULL REFERENCES professor_profiles(id),
    title TEXT NOT NULL,
    file_url TEXT NOT NULL DEFAULT '',
    pages INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS booklets_professor_id_idx ON booklets(professor_id);

-- 9. questions
CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY NOT NULL,
    subject_id TEXT NOT NULL REFERENCES subjects(id),
    professor_id TEXT REFERENCES professor_profiles(id),
    text TEXT NOT NULL,
    image_url TEXT,
    rationale TEXT NOT NULL DEFAULT '',
    eyebrow TEXT NOT NULL DEFAULT '',
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS questions_subject_id_idx ON questions(subject_id);
CREATE INDEX IF NOT EXISTS questions_professor_id_idx ON questions(professor_id);

-- 10. choices
CREATE TABLE IF NOT EXISTS choices (
    id TEXT PRIMARY KEY NOT NULL,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    is_correct INTEGER NOT NULL DEFAULT 0,
    order_index INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS choices_question_id_idx ON choices(question_id);

-- 11. student_answers
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

-- 12. exams
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

-- 13. courses
CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY NOT NULL,
    subject_id TEXT NOT NULL REFERENCES subjects(id),
    professor_id TEXT REFERENCES professor_profiles(id),
    title TEXT NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS courses_subject_id_idx ON courses(subject_id);
CREATE INDEX IF NOT EXISTS courses_professor_id_idx ON courses(professor_id);

-- 14. lectures
CREATE TABLE IF NOT EXISTS lectures (
    id TEXT PRIMARY KEY NOT NULL,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    order_index INTEGER NOT NULL DEFAULT 0,
    video_url TEXT NOT NULL DEFAULT '',
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS lectures_course_id_idx ON lectures(course_id);

-- 15. recent_views
CREATE TABLE IF NOT EXISTS recent_views (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    content_type TEXT NOT NULL,
    content_id TEXT NOT NULL,
    viewed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS recent_views_user_id_idx ON recent_views(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS recent_views_user_content_idx ON recent_views(user_id, content_type, content_id);

-- 16. lecture_progress
CREATE TABLE IF NOT EXISTS lecture_progress (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    lecture_id TEXT NOT NULL REFERENCES lectures(id),
    completed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS lecture_progress_user_id_idx ON lecture_progress(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS lecture_progress_user_lecture_idx ON lecture_progress(user_id, lecture_id);

-- 17. products
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    type TEXT NOT NULL,
    is_activation_code INTEGER NOT NULL DEFAULT 0,
    grants_subject_id TEXT REFERENCES subjects(id)
);
CREATE INDEX IF NOT EXISTS products_grants_subject_id_idx ON products(grants_subject_id);

-- 18. orders
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

-- 19. order_items
CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY NOT NULL,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id),
    qty INTEGER NOT NULL DEFAULT 1,
    price INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON order_items(order_id);
CREATE INDEX IF NOT EXISTS order_items_product_id_idx ON order_items(product_id);

-- 20. activation_codes
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

-- 21. ban_records
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

-- 22. activity_logs
CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT REFERENCES users(id),
    action TEXT NOT NULL,
    ip_address TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS activity_logs_user_id_idx ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS activity_logs_created_at_idx ON activity_logs(created_at);

-- 23. media_files
CREATE TABLE IF NOT EXISTS media_files (
    id TEXT PRIMARY KEY NOT NULL,
    filename TEXT NOT NULL,
    url TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    uploaded_by TEXT REFERENCES users(id),
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS media_files_filename_idx ON media_files(filename);
CREATE INDEX IF NOT EXISTS media_files_uploaded_by_idx ON media_files(uploaded_by);

-- 24. exam_attempts
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

-- 25. exam_attempt_questions
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

-- 26. user_skills
CREATE TABLE IF NOT EXISTS user_skills (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS user_skills_user_id_idx ON user_skills(user_id);

-- 27. saved_questions
CREATE TABLE IF NOT EXISTS saved_questions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    question_id TEXT NOT NULL REFERENCES questions(id),
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS saved_questions_user_id_idx ON saved_questions(user_id);
CREATE INDEX IF NOT EXISTS saved_questions_question_id_idx ON saved_questions(question_id);
CREATE UNIQUE INDEX IF NOT EXISTS saved_questions_user_question_idx ON saved_questions(user_id, question_id);

-- 28. notifications
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

-- 29. notification_reads
CREATE TABLE IF NOT EXISTS notification_reads (
    id TEXT PRIMARY KEY NOT NULL,
    notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS notification_reads_notification_id_idx ON notification_reads(notification_id);
CREATE INDEX IF NOT EXISTS notification_reads_user_id_idx ON notification_reads(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS notification_reads_notif_user_idx ON notification_reads(notification_id, user_id);

-- 30. clinical_pearls
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

-- 31. email_verifications
CREATE TABLE IF NOT EXISTS email_verifications (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS email_verifications_user_idx ON email_verifications(user_id);
CREATE INDEX IF NOT EXISTS email_verifications_token_idx ON email_verifications(token_hash);

-- 32. account_events
CREATE TABLE IF NOT EXISTS account_events (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    email_hash TEXT,
    event_type TEXT NOT NULL,
    outcome TEXT NOT NULL,
    device_hash TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    details_json TEXT
);
CREATE INDEX IF NOT EXISTS account_events_user_idx ON account_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_events_recent_idx ON account_events(created_at DESC);

-- 33. academic_change_requests
CREATE TABLE IF NOT EXISTS academic_change_requests (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    current_section_id TEXT,
    current_university_id TEXT,
    current_stage_id TEXT,
    target_section_id TEXT REFERENCES sections(id),
    target_university_id TEXT REFERENCES universities(id),
    target_stage_id TEXT REFERENCES stages(id),
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    reviewer_id TEXT REFERENCES users(id),
    reviewer_notes TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS academic_change_user_idx ON academic_change_requests(user_id);
CREATE INDEX IF NOT EXISTS academic_change_status_idx ON academic_change_requests(status);

-- 34. certificates
CREATE TABLE IF NOT EXISTS certificates (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exam_id TEXT NOT NULL REFERENCES exams(id),
    certificate_code TEXT NOT NULL UNIQUE,
    student_name TEXT NOT NULL,
    exam_title TEXT NOT NULL,
    score_percentage INTEGER NOT NULL,
    issued_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    is_revoked INTEGER NOT NULL DEFAULT 0,
    revoked_at TEXT,
    revocation_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS certificates_code_idx ON certificates(certificate_code);
CREATE INDEX IF NOT EXISTS certificates_user_idx ON certificates(user_id);

-- 35. student_reviews
CREATE TABLE IF NOT EXISTS student_reviews (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    ease_factor REAL NOT NULL DEFAULT 2.5,
    interval_days INTEGER NOT NULL DEFAULT 1,
    repetition_count INTEGER NOT NULL DEFAULT 0,
    next_review_at TEXT NOT NULL,
    last_reviewed_at TEXT,
    last_score INTEGER
);
CREATE INDEX IF NOT EXISTS student_reviews_user_idx ON student_reviews(user_id, next_review_at);
CREATE UNIQUE INDEX IF NOT EXISTS student_reviews_user_q_idx ON student_reviews(user_id, question_id);

-- 36. clinical_glimpses
CREATE TABLE IF NOT EXISTS clinical_glimpses (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    clinical_point TEXT NOT NULL,
    warning TEXT,
    image_id TEXT REFERENCES media_files(id),
    reference_text TEXT,
    publish_at TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'in_review', 'approved', 'published', 'archived')),
    audience_all INTEGER NOT NULL DEFAULT 1 CHECK(audience_all IN (0, 1)),
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_by TEXT NOT NULL REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    reviewed_by TEXT REFERENCES users(id),
    reviewed_at TEXT,
    approved_by TEXT REFERENCES users(id),
    approved_at TEXT,
    published_by TEXT REFERENCES users(id),
    published_at TEXT,
    deleted_at TEXT,
    deleted_by TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_glimpses_public ON clinical_glimpses(status, publish_at, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_glimpses_deleted ON clinical_glimpses(deleted_at);

-- 37. clinical_glimpse_targets
CREATE TABLE IF NOT EXISTS clinical_glimpse_targets (
    id TEXT PRIMARY KEY NOT NULL,
    glimpse_id TEXT NOT NULL REFERENCES clinical_glimpses(id) ON DELETE CASCADE,
    university_id TEXT REFERENCES universities(id),
    college_id TEXT,
    department_id TEXT,
    phase_id TEXT,
    stage_id TEXT REFERENCES stages(id),
    UNIQUE(glimpse_id, university_id, college_id, department_id, phase_id)
);
CREATE INDEX IF NOT EXISTS idx_glimpse_targets_scope ON clinical_glimpse_targets(university_id, college_id, department_id, phase_id, glimpse_id);

-- 38. clinical_glimpse_logs
CREATE TABLE IF NOT EXISTS clinical_glimpse_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    glimpse_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('create', 'update', 'submit_review', 'return_draft', 'approve', 'publish', 'archive', 'restore', 'delete_forever')),
    by_user_id TEXT NOT NULL REFERENCES users(id),
    at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    details_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_glimpse_logs_recent ON clinical_glimpse_logs(glimpse_id, at DESC);
