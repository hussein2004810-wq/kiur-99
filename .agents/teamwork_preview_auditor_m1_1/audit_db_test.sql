-- Audit SQL Test: Verification of Real SQLite Constraints
PRAGMA foreign_keys = ON;

-- 1. Verify valid insertion
INSERT INTO sections (id, name) VALUES ('aud_sec_01', 'الطب العام');
INSERT INTO universities (id, name, section_id) VALUES ('aud_uni_01', 'جامعة بغداد', 'aud_sec_01');
INSERT INTO stages (id, name, university_id) VALUES ('aud_stg_01', 'المرحلة الرابعة', 'aud_uni_01');
INSERT INTO subjects (id, name, stage_id) VALUES ('aud_sub_01', 'الجراحة العامة', 'aud_stg_01');

-- 2. Verify query
SELECT u.name AS uni, s.name AS sec, st.name AS stage, sub.name AS subject
FROM universities u
JOIN sections s ON u.section_id = s.id
JOIN stages st ON st.university_id = u.id
JOIN subjects sub ON sub.stage_id = st.id
WHERE u.id = 'aud_uni_01';

-- 3. Cleanup audit test records
DELETE FROM subjects WHERE id = 'aud_sub_01';
DELETE FROM stages WHERE id = 'aud_stg_01';
DELETE FROM universities WHERE id = 'aud_uni_01';
DELETE FROM sections WHERE id = 'aud_sec_01';
