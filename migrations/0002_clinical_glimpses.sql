-- ============================================================================
-- 0002_clinical_glimpses.sql
-- KIUR-99 Clinical Glimpses (اللمحات السريرية), Targets, and Governance Logs
-- ============================================================================

-- 1. CLINICAL GLIMPSES TABLE
CREATE TABLE IF NOT EXISTS clinical_glimpses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  clinical_point TEXT NOT NULL,
  warning TEXT,
  image_id TEXT REFERENCES media_files(id),
  reference_text TEXT,
  publish_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft', 'in_review', 'approved', 'published', 'archived')),
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

-- 2. CLINICAL GLIMPSE TARGETS TABLE
CREATE TABLE IF NOT EXISTS clinical_glimpse_targets (
  id TEXT PRIMARY KEY,
  glimpse_id TEXT NOT NULL REFERENCES clinical_glimpses(id) ON DELETE CASCADE,
  university_id TEXT REFERENCES universities(id),
  college_id TEXT,
  department_id TEXT,
  phase_id TEXT,
  stage_id TEXT REFERENCES stages(id),
  UNIQUE(glimpse_id, university_id, college_id, department_id, phase_id)
);

-- 3. CLINICAL GLIMPSE LOGS TABLE
CREATE TABLE IF NOT EXISTS clinical_glimpse_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  glimpse_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('create', 'update', 'submit_review', 'return_draft', 'approve', 'publish', 'archive', 'restore', 'delete_forever')),
  by_user_id TEXT NOT NULL REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  details_json TEXT
);

-- 4. PERFORMANCE & GOVERNANCE INDEXES
CREATE INDEX IF NOT EXISTS idx_glimpses_public
ON clinical_glimpses(status, publish_at, published_at DESC)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_glimpse_targets_scope
ON clinical_glimpse_targets(university_id, college_id, department_id, phase_id, glimpse_id);

CREATE INDEX IF NOT EXISTS idx_glimpse_logs_recent
ON clinical_glimpse_logs(glimpse_id, at DESC);
