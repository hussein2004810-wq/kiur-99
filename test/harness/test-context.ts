import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockD1Database } from './d1-mock';
import { MockR2Bucket } from './r2-mock';
import { hashPassword, signJwt } from './crypto-helpers';
import { resetRateLimitStore } from '../../src/middleware/rate-limit';

export interface TestFixtures {
  sectionId: string;
  universityId: string;
  stageId: string;
  subjectIds: {
    anatomy: string;
    physiology: string;
    histology: string;
    biochemistry: string;
  };
  users: {
    admin: { id: string; email: string; token: string; sessionId: string };
    professor: { id: string; email: string; token: string; profileId: string; sessionId: string };
    reseller: { id: string; email: string; token: string; sessionId: string };
    student: { id: string; email: string; token: string; sessionId: string };
    bannedStudent: { id: string; email: string; token: string; sessionId: string; banRecordId: string };
  };
  bookletId: string;
  examId: string;
  questionIds: string[];
  courseId: string;
  lectureIds: string[];
  productIds: {
    vipCode: string;
    subjectCode: string;
    physical: string;
  };
  activationCodes: {
    vipIdle: string;
    subjectIdle: string;
  };
  pearlIds: string[];
}

export interface TestContext {
  db: MockD1Database;
  r2: MockR2Bucket;
  bindings: {
    DB: any;
    R2_BUCKET: any;
    JWT_SECRET: string;
    DEBUG: string;
    CORS_ORIGINS: string;
    FIREBASE_AUTH_PROJECT_ID: string;
    FIREBASE_WEB_API_KEY: string;
  };
  fixtures: TestFixtures;
  createAuthToken: (userId: string, role?: string, sessionId?: string) => string;
  createSession: (userId: string, deviceLabel?: string) => Promise<{ id: string; token: string }>;
  cleanup: () => void;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JWT_SECRET = 'test-jwt-secret-key-32-chars-long!';

export async function createTestContext(): Promise<TestContext> {
  resetRateLimitStore();
  const db = new MockD1Database(true);
  const r2 = new MockR2Bucket();

  // 1. Read and apply schema
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  await db.exec(schemaSql);

  // 2. Seed Baseline Catalog
  const sectionId = 'sec_med';
  const universityId = 'uni_bgd';
  const stageId = 'stg_2';
  const anatomyId = 'sub_anat';
  const physioId = 'sub_phys';
  const histoId = 'sub_hist';
  const biochemId = 'sub_bio';

  await db.exec(`
    INSERT INTO sections (id, name) VALUES ('${sectionId}', 'طب بشري');
    INSERT INTO universities (id, name, section_id) VALUES ('${universityId}', 'جامعة بغداد', '${sectionId}');
    INSERT INTO stages (id, name, university_id) VALUES ('${stageId}', 'المرحلة الثانية', '${universityId}');
    INSERT INTO subjects (id, name, stage_id) VALUES
      ('${anatomyId}', 'التشريح', '${stageId}'),
      ('${physioId}', 'الفسلجة', '${stageId}'),
      ('${histoId}', 'الأنسجة', '${stageId}'),
      ('${biochemId}', 'الكيمياء الحيوية', '${stageId}');
  `);

  // 3. Seed Users
  const defaultHash = hashPassword('Nabd@2026');

  const adminId = 'usr_admin';
  const profUserId = 'usr_prof';
  const resellerId = 'usr_reseller';
  const studentId = 'usr_student';
  const bannedId = 'usr_banned';

  await db.exec(`
    INSERT INTO users (id, email, full_name, password_hash, role, email_verified_at)
    VALUES ('${adminId}', 'admin@nabd.app', 'مدير النظام', '${defaultHash}', 'admin', CURRENT_TIMESTAMP);

    INSERT INTO users (id, email, full_name, password_hash, role, email_verified_at)
    VALUES ('${profUserId}', 'prof@nabd.app', 'د. أحمد الجبوري', '${defaultHash}', 'professor', CURRENT_TIMESTAMP);

    INSERT INTO users (id, email, full_name, password_hash, role, email_verified_at)
    VALUES ('${resellerId}', 'reseller@nabd.app', 'وكيل بغداد', '${defaultHash}', 'reseller', CURRENT_TIMESTAMP);

    INSERT INTO users (id, email, full_name, password_hash, role, university_id, stage_id, section_id, email_verified_at)
    VALUES ('${studentId}', 'student@nabd.app', 'علي محمد', '${defaultHash}', 'student', '${universityId}', '${stageId}', '${sectionId}', CURRENT_TIMESTAMP);

    INSERT INTO users (id, email, full_name, password_hash, role, is_banned, email_verified_at)
    VALUES ('${bannedId}', 'banned@nabd.app', 'طالب محظور', '${defaultHash}', 'student', 1, CURRENT_TIMESTAMP);
  `);

  // Sessions for each user
  const adminSessionId = 'ses_admin';
  const profSessionId = 'ses_prof';
  const resellerSessionId = 'ses_reseller';
  const studentSessionId = 'ses_student';
  const bannedSessionId = 'ses_banned';

  await db.exec(`
    INSERT INTO user_sessions (id, user_id, device_label, is_active) VALUES
      ('${adminSessionId}', '${adminId}', 'Admin PC', 1),
      ('${profSessionId}', '${profUserId}', 'Prof Laptop', 1),
      ('${resellerSessionId}', '${resellerId}', 'Office Desktop', 1),
      ('${studentSessionId}', '${studentId}', 'iPhone 15', 1),
      ('${bannedSessionId}', '${bannedId}', 'Android Device', 1);
  `);

  // Professor profile
  const profProfileId = 'prof_1';
  await db.exec(`
    INSERT INTO professor_profiles (id, user_id, title, subject_id, bio)
    VALUES ('${profProfileId}', '${profUserId}', 'أستاذ مساعد', '${anatomyId}', 'أستاذ تشريح سريري');
  `);

  // Booklet
  const bookletId = 'bkl_1';
  await db.exec(`
    INSERT INTO booklets (id, professor_id, title, pages, file_url)
    VALUES ('${bookletId}', '${profProfileId}', 'محاضرة التشريح 1: مقدمة', 25, 'https://storage.nabd.app/bkl_1.pdf');
  `);

  // Questions and Choices (5 questions)
  const questionIds: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const qId = `qst_${i}`;
    questionIds.push(qId);
    await db.exec(`
      INSERT INTO questions (id, subject_id, professor_id, text, rationale, eyebrow)
      VALUES ('${qId}', '${anatomyId}', '${profProfileId}', 'سؤال اختباري رقم ${i} في مادة التشريح', 'توضيح الإجابة الصحيحة ${i}', 'تشريح عام');

      INSERT INTO choices (id, question_id, text, is_correct, order_index) VALUES
        ('cho_${i}_1', '${qId}', 'الخيار الأول (صحيح)', 1, 0),
        ('cho_${i}_2', '${qId}', 'الخيار الثاني (خطأ)', 0, 1),
        ('cho_${i}_3', '${qId}', 'الخيار الثالث (خطأ)', 0, 2),
        ('cho_${i}_4', '${qId}', 'الخيار الرابع (خطأ)', 0, 3);
    `);
  }

  // Exam
  const examId = 'exm_1';
  await db.exec(`
    INSERT INTO exams (id, subject_id, professor_id, title, question_count, duration_minutes)
    VALUES ('${examId}', '${anatomyId}', '${profProfileId}', 'امتحان تشريح نصفي', 5, 30);
  `);

  // Course & Lectures
  const courseId = 'crs_1';
  const lec1 = 'lec_1';
  const lec2 = 'lec_2';
  const lec3 = 'lec_3';
  await db.exec(`
    INSERT INTO courses (id, subject_id, professor_id, title)
    VALUES ('${courseId}', '${anatomyId}', '${profProfileId}', 'كورس التشريح الشامل');

    INSERT INTO lectures (id, course_id, title, duration_seconds, order_index, video_url) VALUES
      ('${lec1}', '${courseId}', 'المحاضرة الأولى: مقدمة', 1200, 0, 'https://storage.nabd.app/lec_1.mp4'),
      ('${lec2}', '${courseId}', 'المحاضرة الثانية: عظام الصدر', 1800, 1, 'https://storage.nabd.app/lec_2.mp4'),
      ('${lec3}', '${courseId}', 'المحاضرة الثالثة: الجهاز العضلي', 2100, 2, 'https://storage.nabd.app/lec_3.mp4');
  `);

  // Store Products
  const prodVip = 'prd_vip';
  const prodSub = 'prd_sub';
  const prodPhys = 'prd_phys';
  await db.exec(`
    INSERT INTO products (id, name, price, type, is_activation_code, grants_subject_id) VALUES
      ('${prodVip}', 'كود VIP شامل سنوي', 50000, 'digital', 1, NULL),
      ('${prodSub}', 'كود تفعيل مادة التشريح', 15000, 'digital', 1, '${anatomyId}'),
      ('${prodPhys}', 'سماعة طبية احترافية', 35000, 'physical', 0, NULL);
  `);

  // Activation Codes
  const codeVip = 'NBD-VIP-7X29';
  const codeSub = 'NBD-ANAT-1234';
  await db.exec(`
    INSERT INTO activation_codes (id, code, subject_id, status) VALUES
      ('act_vip_1', '${codeVip}', NULL, 'idle'),
      ('act_sub_1', '${codeSub}', '${anatomyId}', 'idle');
  `);

  // Banned record
  const banRecordId = 'ban_rec_1';
  await db.exec(`
    INSERT INTO ban_records (id, user_id, reason, status)
    VALUES ('${banRecordId}', '${bannedId}', 'مشاركة غير مصرح بها للحساب', 'active');
  `);

  // Clinical Pearls
  const pearl1 = 'prl_1';
  const pearl2 = 'prl_2';
  const pearl3 = 'prl_3';
  await db.exec(`
    INSERT INTO clinical_pearls (id, tag, title, body) VALUES
      ('${pearl1}', 'طوارئ', 'حالة ضيق تنفس حاد', 'تفاصيل الحالة السريرية لضيق التنفس الحاد والعلاج الفوري بالهيبارين والمراقبة.'),
      ('${pearl2}', 'تشخيص', 'ألم صدري صدغي', 'تشخيص متلازمة الشريان التاجي وتخطيط القلب الكهربائي خلال أول 10 دقائق.'),
      ('${pearl3}', 'أطفال', 'حمى وطفح جلدي عند الأطفال', 'التمييز بين داء كاوازاكي والتهابات فيروسية ومتابعة الشرايين التاجية.');
  `);

  // Helpers
  const createAuthToken = (userId: string, role = 'student', sessionId = 'ses_temp') => {
    return signJwt({ sub: userId, role, sid: sessionId }, JWT_SECRET);
  };

  const createSession = async (userId: string, deviceLabel = 'Test Device') => {
    const sId = 'ses_' + Math.random().toString(36).substring(2, 10);
    // Invalidate existing sessions
    await db.exec(`UPDATE user_sessions SET is_active = 0 WHERE user_id = '${userId}';`);
    await db.exec(`
      INSERT INTO user_sessions (id, user_id, device_label, is_active)
      VALUES ('${sId}', '${userId}', '${deviceLabel}', 1);
    `);
    const token = createAuthToken(userId, 'student', sId);
    return { id: sId, token };
  };

  const adminToken = createAuthToken(adminId, 'admin', adminSessionId);
  const profToken = createAuthToken(profUserId, 'professor', profSessionId);
  const resellerToken = createAuthToken(resellerId, 'reseller', resellerSessionId);
  const studentToken = createAuthToken(studentId, 'student', studentSessionId);
  const bannedToken = createAuthToken(bannedId, 'student', bannedSessionId);

  return {
    db,
    r2,
    bindings: {
      DB: db,
      R2_BUCKET: r2,
      JWT_SECRET,
      DEBUG: 'true',
      CORS_ORIGINS: '*',
      FIREBASE_AUTH_PROJECT_ID: 'kiur-medical-exams-2026',
      FIREBASE_WEB_API_KEY: 'test-firebase-web-api-key',
    },
    fixtures: {
      sectionId,
      universityId,
      stageId,
      subjectIds: {
        anatomy: anatomyId,
        physiology: physioId,
        histology: histoId,
        biochemistry: biochemId,
      },
      users: {
        admin: { id: adminId, email: 'admin@nabd.app', token: adminToken, sessionId: adminSessionId },
        professor: { id: profUserId, email: 'prof@nabd.app', token: profToken, profileId: profProfileId, sessionId: profSessionId },
        reseller: { id: resellerId, email: 'reseller@nabd.app', token: resellerToken, sessionId: resellerSessionId },
        student: { id: studentId, email: 'student@nabd.app', token: studentToken, sessionId: studentSessionId },
        bannedStudent: { id: bannedId, email: 'banned@nabd.app', token: bannedToken, sessionId: bannedSessionId, banRecordId },
      },
      bookletId,
      examId,
      questionIds,
      courseId,
      lectureIds: [lec1, lec2, lec3],
      productIds: {
        vipCode: prodVip,
        subjectCode: prodSub,
        physical: prodPhys,
      },
      activationCodes: {
        vipIdle: codeVip,
        subjectIdle: codeSub,
      },
      pearlIds: [pearl1, pearl2, pearl3],
    },
    createAuthToken,
    createSession,
    cleanup: () => {
      db.close();
      resetRateLimitStore();
    },
  };
}
