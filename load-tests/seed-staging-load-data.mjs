import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Generates disposable, synthetic data only for the isolated staging database.
// The generated SQL and credentials are ignored by Git.
const students = 600;
const password = 'StagingLoadOnly-2026!';
const root = fileURLToPath(new URL('..', import.meta.url));
const seedPath = join(root, 'load-tests', 'staging-seed.sql');
const credentialsPath = join(root, 'load-tests', 'staging-credentials.json');
const salt = randomBytes(16).toString('hex');
const passwordHash = `${salt}$${pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString('hex')}`;

const sql = `
PRAGMA foreign_keys = ON;
INSERT OR IGNORE INTO sections (id, name) VALUES ('load_section', 'Staging Load Section');
INSERT OR IGNORE INTO universities (id, name, section_id) VALUES ('load_university', 'Staging Load University', 'load_section');
INSERT OR IGNORE INTO stages (id, name, university_id, stage_number) VALUES ('load_stage', 'Staging Load Stage', 'load_university', 1);
INSERT OR IGNORE INTO subjects (id, name, stage_id, code) VALUES ('load_subject', 'Staging Load Subject', 'load_stage', 'LOAD-101');
INSERT OR IGNORE INTO exams (id, subject_id, title, question_count, duration_minutes) VALUES ('load_exam_600', 'load_subject', 'Staging Load Exam', 50, 30);
WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${students})
INSERT OR IGNORE INTO users (id, email, full_name, password_hash, role, university_id, stage_id, section_id, email_verified_at)
SELECT 'load_user_' || printf('%03d', x), 'load-student-' || printf('%03d', x) || '@staging.invalid', 'Load Student ' || x, '${passwordHash}', 'student', 'load_university', 'load_stage', 'load_section', CURRENT_TIMESTAMP FROM n;
UPDATE users SET password_hash = '${passwordHash}', failed_login_attempts = 0, locked_until = NULL WHERE id LIKE 'load_user_%';
WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 50)
INSERT OR IGNORE INTO questions (id, subject_id, text) SELECT 'load_question_' || printf('%03d', x), 'load_subject', 'Synthetic load question ' || x FROM n;
WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 50), c(y) AS (SELECT 1 UNION ALL SELECT y + 1 FROM c WHERE y < 4)
INSERT OR IGNORE INTO choices (id, question_id, text, is_correct, order_index)
SELECT 'load_choice_' || printf('%03d', x) || '_' || y, 'load_question_' || printf('%03d', x), 'Choice ' || y, CASE WHEN y = 1 THEN 1 ELSE 0 END, y - 1 FROM n CROSS JOIN c;
`;

const credentials = Array.from({ length: students }, (_, index) => ({
  email: `load-student-${String(index + 1).padStart(3, '0')}@staging.invalid`,
  password,
}));

writeFileSync(seedPath, sql.trimStart(), 'utf8');
writeFileSync(credentialsPath, JSON.stringify(credentials), 'utf8');
console.log(`Prepared ${students} synthetic staging accounts and a 50-question exam in ${seedPath}.`);
