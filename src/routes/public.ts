/**
 * Public stats routes — mirrors Python app/routers/public.py
 * No authentication required.
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, count } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';

export const publicRouter = new Hono<AppEnv>();

// GET /api/public/stats
publicRouter.get('/stats', async (c) => {
  const db = drizzle(c.env.DB, { schema });

  const students = await c.env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'student'").first('c');
  const courses = await c.env.DB.prepare('SELECT COUNT(*) as c FROM courses').first('c');
  const exams = await c.env.DB.prepare('SELECT COUNT(*) as c FROM exams').first('c');

  const [questionsCount] = await db.select({ count: count() }).from(schema.questions);
  const [lecturesCount] = await db.select({ count: count() }).from(schema.lectures);
  const [pearlsCount] = await db.select({ count: count() }).from(schema.clinicalPearls);

  // Count professors (via professor profiles joined to non-banned users)
  const profProfiles = await db
    .select({ user_id: schema.professorProfiles.user_id })
    .from(schema.professorProfiles);

  let professorsCount = 0;
  if (profProfiles.length > 0) {
    const userIds = profProfiles.map((p) => p.user_id);
    let unbanned = 0;
    for (const userId of userIds) {
      const u = await db.select({ is_banned: schema.users.is_banned }).from(schema.users).where(eq(schema.users.id, userId)).get();
      if (u && !u.is_banned) unbanned++;
    }
    professorsCount = unbanned;
  }

  return c.json({
    total_students: Number(students ?? 0),
    total_courses: Number(courses ?? 0),
    total_exams: Number(exams ?? 0),
    questions: questionsCount?.count ?? 0,
    professors: professorsCount,
    lectures: lecturesCount?.count ?? 0,
    pearls: pearlsCount?.count ?? 0,
  });
});

// GET /api/public/professors
publicRouter.get('/professors', async (c) => {
  const res = await c.env.DB.prepare(`
    SELECT p.*, u.full_name, s.name as subject_name
    FROM professor_profiles p
    JOIN users u ON p.user_id = u.id
    LEFT JOIN subjects s ON p.subject_id = s.id
  `).all();
  return c.json(res.results ?? []);
});

// GET /api/public/certificates/:code (B6 - Rate limited verifiable certificates)
publicRouter.get('/certificates/:code', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const code = c.req.param('code').trim().toUpperCase();

  const cert = await db.select().from(schema.certificates).where(eq(schema.certificates.certificate_code, code)).get();
  if (!cert) {
    return c.json({ detail: 'الشهادة غير موجودة أو الرمز غير صالح', is_valid: false }, 404);
  }

  return c.json({
    is_valid: !cert.is_revoked,
    certificate_code: cert.certificate_code,
    student_name: cert.student_name,
    exam_title: cert.exam_title,
    score_percentage: cert.score_percentage,
    issued_at: cert.issued_at,
    is_revoked: cert.is_revoked,
    revocation_reason: cert.is_revoked ? cert.revocation_reason : null,
  });
});

// GET /api/public/share/exam/:id (B7 - Safe public sharing)
publicRouter.get('/share/exam/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const examId = c.req.param('id');

  const exam = await db.select().from(schema.exams).where(eq(schema.exams.id, examId)).get();
  if (!exam) {
    return c.json({ detail: 'الامتحان غير موجود' }, 404);
  }

  const subject = await db.select().from(schema.subjects).where(eq(schema.subjects.id, exam.subject_id)).get();
  if (subject?.is_deleted) {
    return c.json({ detail: 'الامتحان غير متاح' }, 404);
  }

  return c.json({
    id: exam.id,
    title: exam.title,
    question_count: exam.question_count,
    duration_minutes: exam.duration_minutes,
    subject_name: subject?.name ?? '—',
  });
});

// GET /api/public/share/course/:id (B7 - Safe public sharing)
publicRouter.get('/share/course/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const courseId = c.req.param('id');

  const course = await db.select().from(schema.courses).where(eq(schema.courses.id, courseId)).get();
  if (!course || course.is_deleted) {
    return c.json({ detail: 'الكورس غير موجود' }, 404);
  }

  const subject = await db.select().from(schema.subjects).where(eq(schema.subjects.id, course.subject_id)).get();
  if (subject?.is_deleted) {
    return c.json({ detail: 'الكورس غير متاح' }, 404);
  }

  const lecturesCount = (await db.select().from(schema.lectures).where(eq(schema.lectures.course_id, courseId))).length;

  return c.json({
    id: course.id,
    title: course.title,
    subject_name: subject?.name ?? '—',
    lectures_count: lecturesCount,
  });
});
