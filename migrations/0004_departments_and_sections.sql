-- ============================================================================
-- 0004_departments_and_sections.sql
-- Academic Departments (أقسام طبية) & Study Sections/Classes (شعب دراسية)
-- ============================================================================

-- 1. Create departments table (الأقسام الطبية والعلمية داخل الكليات)
CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY NOT NULL,
    college_id TEXT NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS departments_college_id_idx ON departments(college_id);

-- 2. Enhance stages table with department_id
ALTER TABLE stages ADD COLUMN department_id TEXT REFERENCES departments(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS stages_department_id_idx ON stages(department_id);

-- 3. Create study_sections table (الشعب والمجموعات الدراسية داخل كل مرحلة)
CREATE TABLE IF NOT EXISTS study_sections (
    id TEXT PRIMARY KEY NOT NULL,
    stage_id TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS study_sections_stage_id_idx ON study_sections(stage_id);

-- 4. Enhance users table with academic profile references
ALTER TABLE users ADD COLUMN college_id TEXT REFERENCES colleges(id);
ALTER TABLE users ADD COLUMN department_id TEXT REFERENCES departments(id);
ALTER TABLE users ADD COLUMN study_section_id TEXT REFERENCES study_sections(id);

CREATE INDEX IF NOT EXISTS users_college_id_idx ON users(college_id);
CREATE INDEX IF NOT EXISTS users_department_id_idx ON users(department_id);
CREATE INDEX IF NOT EXISTS users_study_section_id_idx ON users(study_section_id);
