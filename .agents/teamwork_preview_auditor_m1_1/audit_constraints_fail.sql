-- Test duplicate primary key
INSERT INTO sections (id, name) VALUES ('dupe_id', 'القسم الأول');
INSERT INTO sections (id, name) VALUES ('dupe_id', 'القسم المكرر');
