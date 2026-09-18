-- ============================================================================
-- 0003_academic_hierarchy.sql
-- Iraqi Medical Group Academic Hierarchy (Universities, Colleges, Programs, Stages, Subjects)
-- ============================================================================

-- 1. Enhance universities table
ALTER TABLE universities ADD COLUMN type TEXT NOT NULL DEFAULT 'government';
ALTER TABLE universities ADD COLUMN province TEXT;
ALTER TABLE universities ADD COLUMN logo_url TEXT;
ALTER TABLE universities ADD COLUMN created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP);

CREATE INDEX IF NOT EXISTS universities_type_idx ON universities(type);
CREATE INDEX IF NOT EXISTS universities_province_idx ON universities(province);

-- 2. Create colleges table
CREATE TABLE IF NOT EXISTS colleges (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    code TEXT,
    default_stages INTEGER NOT NULL DEFAULT 6,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- 3. Create college_programs table (Linking University to College with Study System)
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

-- 4. Enhance stages table
ALTER TABLE stages ADD COLUMN stage_number INTEGER;
ALTER TABLE stages ADD COLUMN program_id TEXT REFERENCES college_programs(id);
ALTER TABLE stages ADD COLUMN college_id TEXT REFERENCES colleges(id);

CREATE INDEX IF NOT EXISTS stages_program_id_idx ON stages(program_id);
CREATE INDEX IF NOT EXISTS stages_college_id_idx ON stages(college_id);

-- 5. Enhance subjects table
ALTER TABLE subjects ADD COLUMN code TEXT;
ALTER TABLE subjects ADD COLUMN term TEXT NOT NULL DEFAULT 'annual';
ALTER TABLE subjects ADD COLUMN is_ministerial INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subjects ADD COLUMN has_practical INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS subjects_is_ministerial_idx ON subjects(is_ministerial);
