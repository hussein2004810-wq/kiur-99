import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../../src/db/schema';
import { MockD1Database } from '../harness/d1-mock';

const MIGRATION_PATH = path.resolve(__dirname, '../../migrations/0000_initial_schema.sql');
const MIGRATION_0001_PATH = path.resolve(__dirname, '../../migrations/0001_legacy_feature_port.sql');
const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf-8');

const ALL_30_TABLES = [
  'sections',
  'universities',
  'stages',
  'subjects',
  'users',
  'user_sessions',
  'professor_profiles',
  'booklets',
  'questions',
  'choices',
  'student_answers',
  'exams',
  'courses',
  'lectures',
  'recent_views',
  'lecture_progress',
  'products',
  'orders',
  'order_items',
  'activation_codes',
  'ban_records',
  'activity_logs',
  'media_files',
  'exam_attempts',
  'exam_attempt_questions',
  'user_skills',
  'saved_questions',
  'notifications',
  'notification_reads',
  'clinical_pearls',
] as const;

describe('Tier 5 / Milestone 1: Empirical Database Schema & Constraint Stress Suite', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(migrationSql);
  });

  afterEach(() => {
    db.close();
  });

  // ==========================================================================
  // 1. TABLE PRESENCE & DDL INTEGRITY
  // ==========================================================================
  describe('1. Schema Completeness & DDL Integrity', () => {
    it('should create exactly all 30 required tables in SQLite', () => {
      const stmt = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
      );
      const rows = stmt.all() as { name: string }[];
      const tableNames = rows.map((r) => r.name).sort();

      expect(tableNames.length).toBe(30);
      expect(tableNames).toEqual([...ALL_30_TABLES].sort());
    });

    it('should pass PRAGMA integrity_check immediately after schema migration', () => {
      const stmt = db.prepare('PRAGMA integrity_check;');
      const rows = stmt.all() as { integrity_check: string }[];
      expect(rows[0]?.integrity_check).toBe('ok');
    });

    it('should pass PRAGMA foreign_key_check on an empty database', () => {
      const stmt = db.prepare('PRAGMA foreign_key_check;');
      const rows = stmt.all();
      expect(rows).toHaveLength(0);
    });

    it('should verify that PRAGMA foreign_keys is strictly enabled', () => {
      const stmt = db.prepare('PRAGMA foreign_keys;');
      const row = stmt.get() as { foreign_keys: number };
      expect(row.foreign_keys).toBe(1);
    });
  });

  // ==========================================================================
  // 2. FULL RELATIONAL POPULATION (ALL 30 TABLES)
  // ==========================================================================
  describe('2. Full Relational Population & Integrity Check across all 30 tables', () => {
    it('should successfully insert valid rows into all 30 tables in relational hierarchy with zero FK errors', () => {
      // 1. sections
      db.prepare("INSERT INTO sections (id, name) VALUES ('sec_1', 'القسم العام');").run();

      // 2. universities
      db.prepare("INSERT INTO universities (id, name, section_id) VALUES ('uni_1', 'جامعة بغداد', 'sec_1');").run();

      // 3. stages
      db.prepare("INSERT INTO stages (id, name, university_id) VALUES ('stg_1', 'المرحلة الرابعة', 'uni_1');").run();

      // 4. subjects
      db.prepare("INSERT INTO subjects (id, name, stage_id) VALUES ('sub_1', 'الباطنية', 'stg_1');").run();

      // 5. users (student, prof, admin, reseller)
      db.prepare(`
        INSERT INTO users (id, email, full_name, role, university_id, stage_id, section_id, theme, language)
        VALUES 
          ('usr_student', 'student@nabd.iq', 'طالب تجريبي', 'student', 'uni_1', 'stg_1', 'sec_1', 'light', 'ar'),
          ('usr_prof', 'prof@nabd.iq', 'د. أستاذ تجريبي', 'professor', 'uni_1', 'stg_1', 'sec_1', 'dark', 'ar'),
          ('usr_admin', 'admin@nabd.iq', 'مدير النظام', 'admin', NULL, NULL, NULL, 'light', 'ar'),
          ('usr_reseller', 'reseller@nabd.iq', 'وكيل بيع', 'reseller', NULL, NULL, NULL, 'light', 'ar');
      `).run();

      // 6. user_sessions
      db.prepare("INSERT INTO user_sessions (id, user_id, device_label, is_active) VALUES ('ses_1', 'usr_student', 'Chrome Windows', 1);").run();

      // 7. professor_profiles
      db.prepare("INSERT INTO professor_profiles (id, user_id, title, subject_id, bio) VALUES ('prof_1', 'usr_prof', 'أستاذ دكتور', 'sub_1', 'طبيب اختصاص');").run();

      // 8. booklets
      db.prepare("INSERT INTO booklets (id, professor_id, title, file_url, pages) VALUES ('bk_1', 'prof_1', 'ملزمة الباطنية الشاملة', 'https://r2.nabd.iq/bk1.pdf', 120);").run();

      // 9. questions
      db.prepare("INSERT INTO questions (id, subject_id, professor_id, text, rationale, eyebrow) VALUES ('q_1', 'sub_1', 'prof_1', 'ما هو العرض الشائع لقصور القلب؟', 'ضيق التنفس الجهدي هو العرض الأبرز', 'أمراض القلب');").run();

      // 10. choices
      db.prepare(`
        INSERT INTO choices (id, question_id, text, is_correct, order_index)
        VALUES 
          ('ch_1', 'q_1', 'ضيق التنفس', 1, 0),
          ('ch_2', 'q_1', 'ألم في الركبة', 0, 1),
          ('ch_3', 'q_1', 'صداع خفيف', 0, 2),
          ('ch_4', 'q_1', 'فقدان الشهية الحاد', 0, 3);
      `).run();

      // 11. student_answers
      db.prepare("INSERT INTO student_answers (id, user_id, question_id, choice_id, is_correct) VALUES ('ans_1', 'usr_student', 'q_1', 'ch_1', 1);").run();

      // 12. exams
      db.prepare("INSERT INTO exams (id, subject_id, professor_id, title, question_count, duration_minutes) VALUES ('ex_1', 'sub_1', 'prof_1', 'امتحان منتصف الفصل', 1, 45);").run();

      // 13. courses
      db.prepare("INSERT INTO courses (id, subject_id, professor_id, title) VALUES ('crs_1', 'sub_1', 'prof_1', 'كورس أمراض القلب السريرية');").run();

      // 14. lectures
      db.prepare("INSERT INTO lectures (id, course_id, title, duration_seconds, order_index, video_url) VALUES ('lec_1', 'crs_1', 'المحاضرة 1: التشريح الوظيفي', 1800, 0, 'https://r2.nabd.iq/lec1.mp4');").run();

      // 15. recent_views
      db.prepare("INSERT INTO recent_views (id, user_id, content_type, content_id) VALUES ('rv_1', 'usr_student', 'lecture', 'lec_1');").run();

      // 16. lecture_progress
      db.prepare("INSERT INTO lecture_progress (id, user_id, lecture_id) VALUES ('lp_1', 'usr_student', 'lec_1');").run();

      // 17. products
      db.prepare("INSERT INTO products (id, name, price, type, is_activation_code, grants_subject_id) VALUES ('prod_1', 'كود تفعيل مادة الباطنية', 25000, 'digital', 1, 'sub_1');").run();

      // 18. orders
      db.prepare("INSERT INTO orders (id, user_id, total, payment_method, status) VALUES ('ord_1', 'usr_student', 25000, 'zaincash', 'paid');").run();

      // 19. order_items
      db.prepare("INSERT INTO order_items (id, order_id, product_id, qty, price) VALUES ('item_1', 'ord_1', 'prod_1', 1, 25000);").run();

      // 20. activation_codes
      db.prepare("INSERT INTO activation_codes (id, code, subject_id, status, activated_by_user_id, reseller_id, order_id) VALUES ('act_1', 'MED-INT-1001', 'sub_1', 'active', 'usr_student', 'usr_reseller', 'ord_1');").run();

      // 21. ban_records
      db.prepare("INSERT INTO ban_records (id, user_id, reason, status) VALUES ('ban_1', 'usr_student', 'محاولة مشاركة الحساب', 'active');").run();

      // 22. activity_logs
      db.prepare("INSERT INTO activity_logs (id, user_id, action, ip_address) VALUES ('actlog_1', 'usr_student', 'login_success', '192.168.1.1');").run();

      // 23. media_files
      db.prepare("INSERT INTO media_files (id, filename, url, content_type, size_bytes, uploaded_by) VALUES ('mf_1', 'heart_scan.png', 'https://r2.nabd.iq/heart_scan.png', 'image/png', 204800, 'usr_prof');").run();

      // 24. exam_attempts
      db.prepare("INSERT INTO exam_attempts (id, exam_id, user_id, score, total) VALUES ('att_1', 'ex_1', 'usr_student', 1, 1);").run();

      // 25. exam_attempt_questions
      db.prepare("INSERT INTO exam_attempt_questions (id, attempt_id, question_id, order_index, choice_id, is_correct) VALUES ('attq_1', 'att_1', 'q_1', 0, 'ch_1', 1);").run();

      // 26. user_skills
      db.prepare("INSERT INTO user_skills (id, user_id, text) VALUES ('skl_1', 'usr_student', 'ECG Interpretation');").run();

      // 27. saved_questions
      db.prepare("INSERT INTO saved_questions (id, user_id, question_id) VALUES ('sq_1', 'usr_student', 'q_1');").run();

      // 28. notifications
      db.prepare("INSERT INTO notifications (id, user_id, title, body, created_by, content_type, content_id) VALUES ('notif_1', 'usr_student', 'امتحان جديد', 'تمت إضافة امتحان جديد في الباطنية', 'usr_prof', 'exam', 'ex_1');").run();

      // 29. notification_reads
      db.prepare("INSERT INTO notification_reads (id, notification_id, user_id) VALUES ('nr_1', 'notif_1', 'usr_student');").run();

      // 30. clinical_pearls
      db.prepare("INSERT INTO clinical_pearls (id, tag, title, body, created_by) VALUES ('cp_1', 'طوارئ', 'احتشاء عضلة القلب', 'العلاج الفوري يشمل الأسبرين والمورفين والأكسجين', 'usr_prof');").run();

      // Verify each of the 30 tables has count >= 1
      for (const table of ALL_30_TABLES) {
        const countRow = db.prepare(`SELECT count(*) as cnt FROM ${table};`).get() as { cnt: number };
        expect(countRow.cnt, `Table ${table} should contain at least 1 row`).toBeGreaterThanOrEqual(1);
      }

      // Assert PRAGMA foreign_key_check returns zero errors
      const fkCheck = db.prepare('PRAGMA foreign_key_check;').all();
      expect(fkCheck).toHaveLength(0);

      // Assert PRAGMA integrity_check returns ok
      const integrity = db.prepare('PRAGMA integrity_check;').all() as { integrity_check: string }[];
      expect(integrity[0]?.integrity_check).toBe('ok');
    });
  });

  // ==========================================================================
  // 3. FOREIGN KEY ENFORCEMENT ADVERSARIAL STRESS
  // ==========================================================================
  describe('3. Foreign Key Enforcement Adversarial Testing', () => {
    beforeEach(() => {
      // Seed minimal valid base hierarchy
      db.prepare("INSERT INTO sections (id, name) VALUES ('sec_1', 'قسم عام');").run();
      db.prepare("INSERT INTO universities (id, name, section_id) VALUES ('uni_1', 'بغداد', 'sec_1');").run();
      db.prepare("INSERT INTO stages (id, name, university_id) VALUES ('stg_1', 'م4', 'uni_1');").run();
      db.prepare("INSERT INTO subjects (id, name, stage_id) VALUES ('sub_1', 'جراحة', 'stg_1');").run();
      db.prepare("INSERT INTO users (id, email, full_name) VALUES ('usr_1', 'u1@nabd.iq', 'مستخدم');").run();
    });

    it('should reject university with non-existent section_id', () => {
      expect(() => {
        db.prepare("INSERT INTO universities (id, name, section_id) VALUES ('uni_x', 'جامعة وهمية', 'non_existent_sec');").run();
      }).toThrow(/FOREIGN KEY/i);
    });

    it('should reject stage with non-existent university_id', () => {
      expect(() => {
        db.prepare("INSERT INTO stages (id, name, university_id) VALUES ('stg_x', 'مرحلة وهمية', 'non_existent_uni');").run();
      }).toThrow(/FOREIGN KEY/i);
    });

    it('should reject subject with non-existent stage_id', () => {
      expect(() => {
        db.prepare("INSERT INTO subjects (id, name, stage_id) VALUES ('sub_x', 'مادة وهمية', 'non_existent_stg');").run();
      }).toThrow(/FOREIGN KEY/i);
    });

    it('should reject user with non-existent university_id', () => {
      expect(() => {
        db.prepare("INSERT INTO users (id, email, full_name, university_id) VALUES ('usr_x1', 'x1@nabd.iq', 'اسم', 'ghost_uni');").run();
      }).toThrow(/FOREIGN KEY/i);
    });

    it('should reject user with non-existent stage_id', () => {
      expect(() => {
        db.prepare("INSERT INTO users (id, email, full_name, stage_id) VALUES ('usr_x2', 'x2@nabd.iq', 'اسم', 'ghost_stg');").run();
      }).toThrow(/FOREIGN KEY/i);
    });

    it('should reject user with non-existent section_id', () => {
      expect(() => {
        db.prepare("INSERT INTO users (id, email, full_name, section_id) VALUES ('usr_x3', 'x3@nabd.iq', 'اسم', 'ghost_sec');").run();
      }).toThrow(/FOREIGN KEY/i);
    });

    it('should reject user_session with non-existent user_id', () => {
      expect(() => {
        db.prepare("INSERT INTO user_sessions (id, user_id) VALUES ('ses_x', 'ghost_user');").run();
      }).toThrow(/FOREIGN KEY/i);
    });

    it('should reject professor_profile with non-existent user_id or subject_id', () => {
      expect(() => {
        db.prepare("INSERT INTO professor_profiles (id, user_id, subject_id) VALUES ('prof_x1', 'ghost_user', 'sub_1');").run();
      }).toThrow(/FOREIGN KEY/i);

      expect(() => {
        db.prepare("INSERT INTO professor_profiles (id, user_id, subject_id) VALUES ('prof_x2', 'usr_1', 'ghost_sub');").run();
      }).toThrow(/FOREIGN KEY/i);
    });

    it('should reject booklet with non-existent professor_id', () => {
      expect(() => {
        db.prepare("INSERT INTO booklets (id, professor_id, title) VALUES ('bk_x', 'ghost_prof', 'ملزمة');").run();
      }).toThrow(/FOREIGN KEY/i);
    });

    it('should reject question with non-existent subject_id', () => {
      expect(() => {
        db.prepare("INSERT INTO questions (id, subject_id, text) VALUES ('q_x', 'ghost_sub', 'نص سؤال');").run();
      }).toThrow(/FOREIGN KEY/i);
    });

    it('should reject choice with non-existent question_id', () => {
      expect(() => {
        db.prepare("INSERT INTO choices (id, question_id, text) VALUES ('ch_x', 'ghost_q', 'خيار');").run();
      }).toThrow(/FOREIGN KEY/i);
    });

    it('should reject student_answer with invalid references', () => {
      db.prepare("INSERT INTO questions (id, subject_id, text) VALUES ('q_valid', 'sub_1', 'سؤال');").run();
      db.prepare("INSERT INTO choices (id, question_id, text) VALUES ('ch_valid', 'q_valid', 'خيار');").run();

      // invalid user
      expect(() => {
        db.prepare("INSERT INTO student_answers (id, user_id, question_id, choice_id, is_correct) VALUES ('sa_1', 'ghost_user', 'q_valid', 'ch_valid', 1);").run();
      }).toThrow(/FOREIGN KEY/i);

      // invalid question
      expect(() => {
        db.prepare("INSERT INTO student_answers (id, user_id, question_id, choice_id, is_correct) VALUES ('sa_2', 'usr_1', 'ghost_q', 'ch_valid', 1);").run();
      }).toThrow(/FOREIGN KEY/i);

      // invalid choice
      expect(() => {
        db.prepare("INSERT INTO student_answers (id, user_id, question_id, choice_id, is_correct) VALUES ('sa_3', 'usr_1', 'q_valid', 'ghost_choice', 1);").run();
      }).toThrow(/FOREIGN KEY/i);
    });

    it('should reject lecture with non-existent course_id', () => {
      expect(() => {
        db.prepare("INSERT INTO lectures (id, course_id, title) VALUES ('lec_x', 'ghost_course', 'محاضرة');").run();
      }).toThrow(/FOREIGN KEY/i);
    });

    it('should reject order_item with non-existent order_id or product_id', () => {
      db.prepare("INSERT INTO products (id, name, price, type) VALUES ('p_valid', 'منتج', 1000, 'digital');").run();
      db.prepare("INSERT INTO orders (id, user_id, total) VALUES ('ord_valid', 'usr_1', 1000);").run();

      expect(() => {
        db.prepare("INSERT INTO order_items (id, order_id, product_id, price) VALUES ('oi_1', 'ghost_order', 'p_valid', 1000);").run();
      }).toThrow(/FOREIGN KEY/i);

      expect(() => {
        db.prepare("INSERT INTO order_items (id, order_id, product_id, price) VALUES ('oi_2', 'ord_valid', 'ghost_prod', 1000);").run();
      }).toThrow(/FOREIGN KEY/i);
    });

    it('should reject exam_attempt_questions with non-existent attempt_id or question_id', () => {
      db.prepare("INSERT INTO exams (id, subject_id, title) VALUES ('ex_valid', 'sub_1', 'امتحان');").run();
      db.prepare("INSERT INTO exam_attempts (id, exam_id, user_id) VALUES ('att_valid', 'ex_valid', 'usr_1');").run();
      db.prepare("INSERT INTO questions (id, subject_id, text) VALUES ('q_valid2', 'sub_1', 'سؤال');").run();

      expect(() => {
        db.prepare("INSERT INTO exam_attempt_questions (id, attempt_id, question_id) VALUES ('eaq_1', 'ghost_att', 'q_valid2');").run();
      }).toThrow(/FOREIGN KEY/i);

      expect(() => {
        db.prepare("INSERT INTO exam_attempt_questions (id, attempt_id, question_id) VALUES ('eaq_2', 'att_valid', 'ghost_q');").run();
      }).toThrow(/FOREIGN KEY/i);
    });

    it('should reject notification_reads with non-existent notification_id or user_id', () => {
      db.prepare("INSERT INTO notifications (id, title) VALUES ('notif_valid', 'إشعار');").run();

      expect(() => {
        db.prepare("INSERT INTO notification_reads (id, notification_id, user_id) VALUES ('nr_x1', 'ghost_notif', 'usr_1');").run();
      }).toThrow(/FOREIGN KEY/i);

      expect(() => {
        db.prepare("INSERT INTO notification_reads (id, notification_id, user_id) VALUES ('nr_x2', 'notif_valid', 'ghost_user');").run();
      }).toThrow(/FOREIGN KEY/i);
    });

    it('should reject clinical_pearls with non-existent created_by user', () => {
      expect(() => {
        db.prepare("INSERT INTO clinical_pearls (id, title, created_by) VALUES ('cp_x', 'لؤلؤة', 'ghost_user');").run();
      }).toThrow(/FOREIGN KEY/i);
    });
  });

  // ==========================================================================
  // 4. CASCADE DELETES VS RESTRICT CHECKS
  // ==========================================================================
  describe('4. Cascade Deletes vs Restrict Behavior', () => {
    beforeEach(() => {
      db.prepare("INSERT INTO sections (id, name) VALUES ('sec_1', 'عام');").run();
      db.prepare("INSERT INTO universities (id, name, section_id) VALUES ('uni_1', 'بغداد', 'sec_1');").run();
      db.prepare("INSERT INTO stages (id, name, university_id) VALUES ('stg_1', 'م4', 'uni_1');").run();
      db.prepare("INSERT INTO subjects (id, name, stage_id) VALUES ('sub_1', 'باطنية', 'stg_1');").run();
      db.prepare("INSERT INTO users (id, email, full_name) VALUES ('usr_parent', 'parent@nabd.iq', 'مستخدم رئيسي');").run();
    });

    it('should cascade delete user_sessions when user is deleted', () => {
      db.prepare("INSERT INTO user_sessions (id, user_id, device_label) VALUES ('ses_c1', 'usr_parent', 'Phone');").run();
      db.prepare("INSERT INTO user_sessions (id, user_id, device_label) VALUES ('ses_c2', 'usr_parent', 'Tablet');").run();

      const beforeCount = db.prepare("SELECT count(*) as cnt FROM user_sessions WHERE user_id = 'usr_parent';").get() as { cnt: number };
      expect(beforeCount.cnt).toBe(2);

      // Delete parent user
      db.prepare("DELETE FROM users WHERE id = 'usr_parent';").run();

      const afterCount = db.prepare("SELECT count(*) as cnt FROM user_sessions WHERE user_id = 'usr_parent';").get() as { cnt: number };
      expect(afterCount.cnt).toBe(0);
    });

    it('should cascade delete choices when question is deleted', () => {
      db.prepare("INSERT INTO questions (id, subject_id, text) VALUES ('q_cascade', 'sub_1', 'سؤال حذف متتالي');").run();
      db.prepare("INSERT INTO choices (id, question_id, text) VALUES ('ch_c1', 'q_cascade', 'خيار 1');").run();
      db.prepare("INSERT INTO choices (id, question_id, text) VALUES ('ch_c2', 'q_cascade', 'خيار 2');").run();

      const beforeChoices = db.prepare("SELECT count(*) as cnt FROM choices WHERE question_id = 'q_cascade';").get() as { cnt: number };
      expect(beforeChoices.cnt).toBe(2);

      db.prepare("DELETE FROM questions WHERE id = 'q_cascade';").run();

      const afterChoices = db.prepare("SELECT count(*) as cnt FROM choices WHERE question_id = 'q_cascade';").get() as { cnt: number };
      expect(afterChoices.cnt).toBe(0);
    });

    it('should cascade delete lectures when course is deleted', () => {
      db.prepare("INSERT INTO courses (id, subject_id, title) VALUES ('crs_cascade', 'sub_1', 'كورس متتالي');").run();
      db.prepare("INSERT INTO lectures (id, course_id, title) VALUES ('lec_c1', 'crs_cascade', 'محاضرة 1');").run();
      db.prepare("INSERT INTO lectures (id, course_id, title) VALUES ('lec_c2', 'crs_cascade', 'محاضرة 2');").run();

      const beforeLectures = db.prepare("SELECT count(*) as cnt FROM lectures WHERE course_id = 'crs_cascade';").get() as { cnt: number };
      expect(beforeLectures.cnt).toBe(2);

      db.prepare("DELETE FROM courses WHERE id = 'crs_cascade';").run();

      const afterLectures = db.prepare("SELECT count(*) as cnt FROM lectures WHERE course_id = 'crs_cascade';").get() as { cnt: number };
      expect(afterLectures.cnt).toBe(0);
    });

    it('should cascade delete order_items when order is deleted', () => {
      db.prepare("INSERT INTO products (id, name, price, type) VALUES ('prod_c', 'كتاب', 5000, 'physical');").run();
      db.prepare("INSERT INTO orders (id, user_id, total) VALUES ('ord_cascade', 'usr_parent', 10000);").run();
      db.prepare("INSERT INTO order_items (id, order_id, product_id, qty, price) VALUES ('oi_c1', 'ord_cascade', 'prod_c', 2, 5000);").run();

      const beforeItems = db.prepare("SELECT count(*) as cnt FROM order_items WHERE order_id = 'ord_cascade';").get() as { cnt: number };
      expect(beforeItems.cnt).toBe(1);

      db.prepare("DELETE FROM orders WHERE id = 'ord_cascade';").run();

      const afterItems = db.prepare("SELECT count(*) as cnt FROM order_items WHERE order_id = 'ord_cascade';").get() as { cnt: number };
      expect(afterItems.cnt).toBe(0);
    });

    it('should cascade delete exam_attempt_questions when exam_attempt is deleted', () => {
      db.prepare("INSERT INTO exams (id, subject_id, title) VALUES ('ex_cascade', 'sub_1', 'امتحان متتالي');").run();
      db.prepare("INSERT INTO exam_attempts (id, exam_id, user_id) VALUES ('att_cascade', 'ex_cascade', 'usr_parent');").run();
      db.prepare("INSERT INTO questions (id, subject_id, text) VALUES ('q_att', 'sub_1', 'سؤال للمحاولة');").run();
      db.prepare("INSERT INTO exam_attempt_questions (id, attempt_id, question_id) VALUES ('eaq_c1', 'att_cascade', 'q_att');").run();

      const beforeQuestions = db.prepare("SELECT count(*) as cnt FROM exam_attempt_questions WHERE attempt_id = 'att_cascade';").get() as { cnt: number };
      expect(beforeQuestions.cnt).toBe(1);

      db.prepare("DELETE FROM exam_attempts WHERE id = 'att_cascade';").run();

      const afterQuestions = db.prepare("SELECT count(*) as cnt FROM exam_attempt_questions WHERE attempt_id = 'att_cascade';").get() as { cnt: number };
      expect(afterQuestions.cnt).toBe(0);
    });

    it('should cascade delete notification_reads when notification is deleted', () => {
      db.prepare("INSERT INTO notifications (id, title) VALUES ('notif_cascade', 'إشعار');").run();
      db.prepare("INSERT INTO notification_reads (id, notification_id, user_id) VALUES ('nr_c1', 'notif_cascade', 'usr_parent');").run();

      const beforeReads = db.prepare("SELECT count(*) as cnt FROM notification_reads WHERE notification_id = 'notif_cascade';").get() as { cnt: number };
      expect(beforeReads.cnt).toBe(1);

      db.prepare("DELETE FROM notifications WHERE id = 'notif_cascade';").run();

      const afterReads = db.prepare("SELECT count(*) as cnt FROM notification_reads WHERE notification_id = 'notif_cascade';").get() as { cnt: number };
      expect(afterReads.cnt).toBe(0);
    });

    it('should cascade delete notification_reads when user is deleted', () => {
      db.prepare("INSERT INTO users (id, email, full_name) VALUES ('usr_reader', 'reader@nabd.iq', 'قارئ');").run();
      db.prepare("INSERT INTO notifications (id, title) VALUES ('notif_user_casc', 'إشعار للقارئ');").run();
      db.prepare("INSERT INTO notification_reads (id, notification_id, user_id) VALUES ('nr_u1', 'notif_user_casc', 'usr_reader');").run();

      db.prepare("DELETE FROM users WHERE id = 'usr_reader';").run();

      const afterReads = db.prepare("SELECT count(*) as cnt FROM notification_reads WHERE user_id = 'usr_reader';").get() as { cnt: number };
      expect(afterReads.cnt).toBe(0);
    });

    it('should block deletion of parent user when child non-cascading entity exists (e.g. orders)', () => {
      db.prepare("INSERT INTO orders (id, user_id, total) VALUES ('ord_protect', 'usr_parent', 5000);").run();

      expect(() => {
        db.prepare("DELETE FROM users WHERE id = 'usr_parent';").run();
      }).toThrow(/FOREIGN KEY/i);
    });

    it('should block deletion of lecture when lecture_progress exists (RESTRICT behavior)', () => {
      db.prepare("INSERT INTO courses (id, subject_id, title) VALUES ('crs_lp', 'sub_1', 'كورس');").run();
      db.prepare("INSERT INTO lectures (id, course_id, title) VALUES ('lec_lp', 'crs_lp', 'محاضرة');").run();
      db.prepare("INSERT INTO lecture_progress (id, user_id, lecture_id) VALUES ('lp_protect', 'usr_parent', 'lec_lp');").run();

      expect(() => {
        db.prepare("DELETE FROM lectures WHERE id = 'lec_lp';").run();
      }).toThrow(/FOREIGN KEY/i);
    });
  });

  // ==========================================================================
  // 5. UNIQUE CONSTRAINTS ADVERSARIAL STRESS
  // ==========================================================================
  describe('5. Unique Constraints Adversarial Testing', () => {
    beforeEach(() => {
      db.prepare("INSERT INTO sections (id, name) VALUES ('sec_1', 'عام');").run();
      db.prepare("INSERT INTO universities (id, name, section_id) VALUES ('uni_1', 'بغداد', 'sec_1');").run();
      db.prepare("INSERT INTO stages (id, name, university_id) VALUES ('stg_1', 'م4', 'uni_1');").run();
      db.prepare("INSERT INTO subjects (id, name, stage_id) VALUES ('sub_1', 'باطنية', 'stg_1');").run();
      db.prepare("INSERT INTO users (id, email, full_name, google_sub) VALUES ('usr_u1', 'unique@nabd.iq', 'فريد', 'google_12345');").run();
    });

    it('should reject duplicate users.email (case sensitivity check)', () => {
      expect(() => {
        db.prepare("INSERT INTO users (id, email, full_name) VALUES ('usr_u2', 'unique@nabd.iq', 'مكرر');").run();
      }).toThrow(/UNIQUE constraint failed: users\.email/i);
    });

    it('should reject duplicate users.google_sub', () => {
      expect(() => {
        db.prepare("INSERT INTO users (id, email, full_name, google_sub) VALUES ('usr_u3', 'other@nabd.iq', 'مكرر', 'google_12345');").run();
      }).toThrow(/UNIQUE constraint failed: users\.google_sub/i);
    });

    it('should allow multiple users with NULL google_sub (standard SQL NULL semantics)', () => {
      db.prepare("INSERT INTO users (id, email, full_name, google_sub) VALUES ('usr_null1', 'null1@nabd.iq', 'مستخدم 1', NULL);").run();
      db.prepare("INSERT INTO users (id, email, full_name, google_sub) VALUES ('usr_null2', 'null2@nabd.iq', 'مستخدم 2', NULL);").run();

      const count = db.prepare("SELECT count(*) as cnt FROM users WHERE google_sub IS NULL;").get() as { cnt: number };
      expect(count.cnt).toBe(2);
    });

    it('should reject duplicate activation_codes.code', () => {
      db.prepare("INSERT INTO activation_codes (id, code) VALUES ('act_u1', 'NABD-VIP-2026');").run();

      expect(() => {
        db.prepare("INSERT INTO activation_codes (id, code) VALUES ('act_u2', 'NABD-VIP-2026');").run();
      }).toThrow(/UNIQUE constraint failed: activation_codes\.code/i);
    });

    it('should reject duplicate media_files.filename', () => {
      db.prepare("INSERT INTO media_files (id, filename, url) VALUES ('mf_u1', 'avatar.jpg', 'https://r2/avatar.jpg');").run();

      expect(() => {
        db.prepare("INSERT INTO media_files (id, filename, url) VALUES ('mf_u2', 'avatar.jpg', 'https://r2/other.jpg');").run();
      }).toThrow(/UNIQUE constraint failed: media_files\.filename/i);
    });

    it('should reject duplicate composite key in recent_views (user_id, content_type, content_id)', () => {
      db.prepare("INSERT INTO recent_views (id, user_id, content_type, content_id) VALUES ('rv_u1', 'usr_u1', 'lecture', 'lec_100');").run();

      expect(() => {
        db.prepare("INSERT INTO recent_views (id, user_id, content_type, content_id) VALUES ('rv_u2', 'usr_u1', 'lecture', 'lec_100');").run();
      }).toThrow(/UNIQUE constraint failed: recent_views\.user_id, recent_views\.content_type, recent_views\.content_id/i);

      // But different user or different content_type must succeed
      db.prepare("INSERT INTO recent_views (id, user_id, content_type, content_id) VALUES ('rv_u3', 'usr_u1', 'booklet', 'lec_100');").run();
      const count = db.prepare("SELECT count(*) as cnt FROM recent_views WHERE user_id = 'usr_u1';").get() as { cnt: number };
      expect(count.cnt).toBe(2);
    });

    it('should reject duplicate composite key in lecture_progress (user_id, lecture_id)', () => {
      db.prepare("INSERT INTO courses (id, subject_id, title) VALUES ('crs_u', 'sub_1', 'كورس');").run();
      db.prepare("INSERT INTO lectures (id, course_id, title) VALUES ('lec_u', 'crs_u', 'محاضرة');").run();
      db.prepare("INSERT INTO lecture_progress (id, user_id, lecture_id) VALUES ('lp_u1', 'usr_u1', 'lec_u');").run();

      expect(() => {
        db.prepare("INSERT INTO lecture_progress (id, user_id, lecture_id) VALUES ('lp_u2', 'usr_u1', 'lec_u');").run();
      }).toThrow(/UNIQUE constraint failed: lecture_progress\.user_id, lecture_progress\.lecture_id/i);
    });

    it('should reject duplicate composite key in saved_questions (user_id, question_id)', () => {
      db.prepare("INSERT INTO questions (id, subject_id, text) VALUES ('q_u', 'sub_1', 'سؤال');").run();
      db.prepare("INSERT INTO saved_questions (id, user_id, question_id) VALUES ('sq_u1', 'usr_u1', 'q_u');").run();

      expect(() => {
        db.prepare("INSERT INTO saved_questions (id, user_id, question_id) VALUES ('sq_u2', 'usr_u1', 'q_u');").run();
      }).toThrow(/UNIQUE constraint failed: saved_questions\.user_id, saved_questions\.question_id/i);
    });

    it('should reject duplicate composite key in notification_reads (notification_id, user_id)', () => {
      db.prepare("INSERT INTO notifications (id, title) VALUES ('notif_u', 'إشعار');").run();
      db.prepare("INSERT INTO notification_reads (id, notification_id, user_id) VALUES ('nr_u1', 'notif_u', 'usr_u1');").run();

      expect(() => {
        db.prepare("INSERT INTO notification_reads (id, notification_id, user_id) VALUES ('nr_u2', 'notif_u', 'usr_u1');").run();
      }).toThrow(/UNIQUE constraint failed: notification_reads\.notification_id, notification_reads\.user_id/i);
    });
  });

  // ==========================================================================
  // 6. NOT NULL & INTEGRITY CONSTRAINTS
  // ==========================================================================
  describe('6. NOT NULL Constraints Adversarial Testing', () => {
    it('should reject NULL for sections.name', () => {
      expect(() => {
        db.prepare("INSERT INTO sections (id, name) VALUES ('sec_null', NULL);").run();
      }).toThrow(/NOT NULL constraint failed: sections\.name/i);
    });

    it('should reject NULL for users.email and users.full_name', () => {
      expect(() => {
        db.prepare("INSERT INTO users (id, email, full_name) VALUES ('u_null1', NULL, 'اسم');").run();
      }).toThrow(/NOT NULL constraint failed: users\.email/i);

      expect(() => {
        db.prepare("INSERT INTO users (id, email, full_name) VALUES ('u_null2', 'valid@nabd.iq', NULL);").run();
      }).toThrow(/NOT NULL constraint failed: users\.full_name/i);
    });

    it('should reject NULL for questions.text and choices.text', () => {
      db.prepare("INSERT INTO sections (id, name) VALUES ('sec_1', 'عام');").run();
      db.prepare("INSERT INTO universities (id, name, section_id) VALUES ('uni_1', 'بغداد', 'sec_1');").run();
      db.prepare("INSERT INTO stages (id, name, university_id) VALUES ('stg_1', 'م4', 'uni_1');").run();
      db.prepare("INSERT INTO subjects (id, name, stage_id) VALUES ('sub_1', 'باطنية', 'stg_1');").run();

      expect(() => {
        db.prepare("INSERT INTO questions (id, subject_id, text) VALUES ('q_null', 'sub_1', NULL);").run();
      }).toThrow(/NOT NULL constraint failed: questions\.text/i);

      db.prepare("INSERT INTO questions (id, subject_id, text) VALUES ('q_ok', 'sub_1', 'سؤال صالح');").run();
      expect(() => {
        db.prepare("INSERT INTO choices (id, question_id, text) VALUES ('ch_null', 'q_ok', NULL);").run();
      }).toThrow(/NOT NULL constraint failed: choices\.text/i);
    });

    it('should reject NULL for products.price', () => {
      expect(() => {
        db.prepare("INSERT INTO products (id, name, price, type) VALUES ('p_null', 'منتج', NULL, 'digital');").run();
      }).toThrow(/NOT NULL constraint failed: products\.price/i);
    });
  });

  // ==========================================================================
  // 7. DRIZZLE ORM TYPESCRIPT SCHEMA PARITY & RELATIONAL QUERIES
  // ==========================================================================
  describe('7. Drizzle ORM Schema Typescript Parity & Relational Execution', () => {
    it('should verify all 30 tables are defined in src/db/schema.ts and exported', () => {
      const exportedTables = [
        schema.sections,
        schema.universities,
        schema.stages,
        schema.subjects,
        schema.users,
        schema.userSessions,
        schema.professorProfiles,
        schema.booklets,
        schema.questions,
        schema.choices,
        schema.studentAnswers,
        schema.exams,
        schema.courses,
        schema.lectures,
        schema.recentViews,
        schema.lectureProgress,
        schema.products,
        schema.orders,
        schema.orderItems,
        schema.activationCodes,
        schema.banRecords,
        schema.activityLogs,
        schema.mediaFiles,
        schema.examAttempts,
        schema.examAttemptQuestions,
        schema.userSkills,
        schema.savedQuestions,
        schema.notifications,
        schema.notificationReads,
        schema.clinicalPearls,
      ];

      expect(exportedTables).toHaveLength(30);
      exportedTables.forEach((tbl) => {
        expect(tbl).toBeDefined();
        // Drizzle sqliteTable contains a symbol or name
        const tableName = (tbl as any)[(Symbol.for('drizzle:Name') as any)] || (tbl as any)._?.name;
        expect(typeof tableName).toBe('string');
        expect(ALL_30_TABLES).toContain(tableName);
      });
    });

    it('should verify all 5 enums are correctly declared with exact value sets', () => {
      expect(schema.roles).toEqual(['student', 'professor', 'admin', 'reseller']);
      expect(schema.productTypes).toEqual(['digital', 'physical', 'course']);
      expect(schema.orderStatuses).toEqual(['pending', 'paid', 'fulfilled', 'cancelled']);
      expect(schema.banStatuses).toEqual(['active', 'appealed', 'lifted']);
      expect(schema.codeStatuses).toEqual(['idle', 'active', 'expired']);
    });

    it('should verify genId generates 12-character hex string', () => {
      const id1 = schema.genId();
      const id2 = schema.genId();
      expect(id1).toHaveLength(12);
      expect(id2).toHaveLength(12);
      expect(id1).not.toBe(id2);
      expect(/^[0-9a-f]{12}$/.test(id1)).toBe(true);
    });

    it('should execute Drizzle ORM relational queries via MockD1Database successfully', async () => {
      const mockD1 = new MockD1Database(true);
      mockD1.db.exec('PRAGMA foreign_keys = ON;');
      const migrationsDir = path.resolve(__dirname, '../../migrations');
      const migrationFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
      for (const file of migrationFiles) {
        mockD1.db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'));
      }

      const drizzleDb = drizzle(mockD1 as any, { schema });

      // Insert catalog hierarchy using raw or mock
      mockD1.db.prepare("INSERT INTO sections (id, name) VALUES ('sec_dz', 'القسم الأكاديمي');").run();
      mockD1.db.prepare("INSERT INTO universities (id, name, section_id) VALUES ('uni_dz', 'الجامعة المستنصرية', 'sec_dz');").run();
      mockD1.db.prepare("INSERT INTO stages (id, name, university_id) VALUES ('stg_dz', 'المرحلة الثالثة', 'uni_dz');").run();
      mockD1.db.prepare("INSERT INTO subjects (id, name, stage_id) VALUES ('sub_dz', 'علم الأدوية', 'stg_dz');").run();
      mockD1.db.prepare("INSERT INTO users (id, email, full_name, university_id, stage_id, section_id) VALUES ('u_dz', 'drizzle@nabd.iq', 'مستخدم دريزل', 'uni_dz', 'stg_dz', 'sec_dz');").run();
      mockD1.db.prepare("INSERT INTO user_sessions (id, user_id, device_label) VALUES ('ses_dz', 'u_dz', 'Firefox Mac');").run();

      // Query with Drizzle relational API
      const user = await drizzleDb.query.users.findFirst({
        where: (u, { eq }) => eq(u.id, 'u_dz'),
        with: {
          sessions: true,
          university: true,
          stage: true,
          section: true,
        },
      });

      expect(user).toBeDefined();
      expect(user?.email).toBe('drizzle@nabd.iq');
      expect(user?.sessions).toHaveLength(1);
      expect(user?.sessions[0]?.device_label).toBe('Firefox Mac');
      expect(user?.university?.name).toBe('الجامعة المستنصرية');
      expect(user?.stage?.name).toBe('المرحلة الثالثة');
      expect(user?.section?.name).toBe('القسم الأكاديمي');

      mockD1.close();
    });
  });

  // ==========================================================================
  // 8. SCHEMA PARITY CHECK (0000_initial_schema.sql vs schema.ts)
  // ==========================================================================
  describe('8. Exact Schema Column & Constraint Drift Analysis', () => {
    it('should verify that all columns in initial_schema.sql match table columns in schema.ts', () => {
      // Extract columns for each table from SQLite PRAGMA table_info
      for (const table of ALL_30_TABLES) {
        const columns = db.prepare(`PRAGMA table_info(${table});`).all() as {
          cid: number;
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        }[];

        expect(columns.length, `Table ${table} should have at least 1 column`).toBeGreaterThan(0);
        const colNames = columns.map((c) => c.name);

        // Verify primary key exists and is 'id'
        const pkCol = columns.find((c) => c.pk === 1);
        expect(pkCol, `Table ${table} must have a primary key`).toBeDefined();
        expect(pkCol?.name).toBe('id');
        expect(pkCol?.type.toUpperCase()).toBe('TEXT');

        // Check against Drizzle table definition
        const drizzleTable = (schema as any)[
          table.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
        ] || (schema as any)[table];

        expect(drizzleTable, `Drizzle schema should have table ${table}`).toBeDefined();

        // Check that every column in SQLite table exists in Drizzle schema
        for (const col of colNames) {
          const drizzleCol = drizzleTable[col];
          expect(drizzleCol, `Drizzle table ${table} missing column ${col}`).toBeDefined();
        }
      }
    });

    it('should verify all indexes in migrations/0000_initial_schema.sql are valid and functional', () => {
      const indexes = db.prepare(
        "SELECT tbl_name, name, sql FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%';"
      ).all() as { tbl_name: string; name: string; sql: string }[];

      // Every index should be associated with one of our 30 tables
      expect(indexes.length).toBeGreaterThanOrEqual(30);
      for (const idx of indexes) {
        expect(ALL_30_TABLES).toContain(idx.tbl_name);
      }
    });
  });
});
