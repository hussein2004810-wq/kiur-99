-- Migration 0001: Legacy Feature Port & Operational Capabilities
-- Compatible with Cloudflare D1 / SQLite

-- 1. Users Table Extensions
ALTER TABLE users ADD COLUMN firebase_uid TEXT;
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS users_firebase_uid_idx ON users(firebase_uid) WHERE firebase_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_email_verified_idx ON users(email_verified_at) WHERE email_verified_at IS NOT NULL;

-- 2. Email Verifications
CREATE TABLE IF NOT EXISTS email_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS email_verifications_user_idx ON email_verifications(user_id);
CREATE INDEX IF NOT EXISTS email_verifications_token_idx ON email_verifications(token_hash);

-- 3. Account Events (Security & Audit Trail)
CREATE TABLE IF NOT EXISTS account_events (
  id TEXT PRIMARY KEY,
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

-- 4. Academic Change Requests
CREATE TABLE IF NOT EXISTS academic_change_requests (
  id TEXT PRIMARY KEY,
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

-- 5. Certificates
CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY,
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

-- 6. Spaced Repetition / Student Reviews
CREATE TABLE IF NOT EXISTS student_reviews (
  id TEXT PRIMARY KEY,
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

-- 7. Soft Delete Columns for Catalog & Media
ALTER TABLE subjects ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subjects ADD COLUMN deleted_at TEXT;

ALTER TABLE courses ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE courses ADD COLUMN deleted_at TEXT;

ALTER TABLE lectures ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lectures ADD COLUMN deleted_at TEXT;

ALTER TABLE questions ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE questions ADD COLUMN deleted_at TEXT;

ALTER TABLE media_files ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media_files ADD COLUMN deleted_at TEXT;

