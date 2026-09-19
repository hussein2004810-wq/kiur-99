/**
 * Professors routes — mirrors Python app/routers/professors.py
 * Covers professor listing, profiles, booklets, exams, courses, lectures, uploads.
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, inArray, asc } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { requireAuth } from '../middleware/auth';
import { createStorageService, safeUploadName, mediaUrl, validateFileSignature, IMAGE_EXTS, PDF_EXTS, VIDEO_EXTS, MAX_UPLOAD_BYTES } from '../services/storage';

const MAX_VIDEO_BYTES = 150 * 1024 * 1024; // 150 MB
const DOC_EXTS = [...PDF_EXTS, ...IMAGE_EXTS];

export const professorsRouter = new Hono<AppEnv>();
professorsRouter.use('*', requireAuth);

async function getProfessorOut(db: ReturnType<typeof drizzle>, profId: string) {
  const profile = await db.select().from(schema.professorProfiles).where(eq(schema.professorProfiles.id, profId)).get();
  if (!profile) return null;

  const profUser = await db.select().from(schema.users).where(eq(schema.users.id, profile.user_id)).get();
  const subject = profile.subject_id ? await db.select().from(schema.subjects).where(eq(schema.subjects.id, profile.subject_id)).get() : null;
  let universityName = '';
  if (subject?.stage_id) {
    const stage = await db.select().from(schema.stages).where(eq(schema.stages.id, subject.stage_id)).get();
    if (stage?.university_id) {
      const uni = await db.select().from(schema.universities).where(eq(schema.universities.id, stage.university_id)).get();
      universityName = uni?.name ?? '';
    }
  }
  const booklets = await db.select().from(schema.booklets).where(eq(schema.booklets.professor_id, profId));
  const exams = await db.select().from(schema.exams).where(eq(schema.exams.professor_id, profId));

  return {
    id: profile.id,
    title: profile.title,
    name: profUser?.full_name ?? '',
    subject_name: subject?.name ?? '',
    university_name: universityName,
    bio: profile.bio ?? '',
    photo_url: profile.photo_url,
    booklets: booklets.map((b) => ({ id: b.id, title: b.title, pages: b.pages, file_url: b.file_url ?? null })),
    exams: exams.map((e) => ({ id: e.id, title: e.title, question_count: e.question_count, duration_minutes: e.duration_minutes })),
  };
}

async function getOwnProfile(db: ReturnType<typeof drizzle>, userId: string, role: string) {
  if (role !== 'professor') return null;
  return db.select().from(schema.professorProfiles).where(eq(schema.professorProfiles.user_id, userId)).get();
}

// GET /api/professors
professorsRouter.get('/', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const profiles = await db.select().from(schema.professorProfiles);
  const result = await Promise.all(profiles.map((p) => getProfessorOut(db, p.id)));
  return c.json(result.filter(Boolean));
});

// GET /api/professors/booklets/latest
professorsRouter.get('/booklets/latest', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const booklet = await db.select().from(schema.booklets).orderBy(desc(schema.booklets.created_at)).get();
  if (!booklet) return c.json(null);

  let subjectName = '';
  if (booklet.professor_id) {
    const prof = await db.select().from(schema.professorProfiles).where(eq(schema.professorProfiles.id, booklet.professor_id)).get();
    if (prof?.subject_id) {
      const subject = await db.select().from(schema.subjects).where(eq(schema.subjects.id, prof.subject_id)).get();
      subjectName = subject?.name ?? '';
    }
  }
  return c.json({ id: booklet.id, title: booklet.title, pages: booklet.pages, file_url: booklet.file_url ?? null, subject_name: subjectName, professor_id: booklet.professor_id });
});

// GET /api/professors/:professor_id
professorsRouter.get('/:professor_id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const out = await getProfessorOut(db, c.req.param('professor_id'));
  if (!out) return c.json({ detail: 'الدكتور غير موجود' }, 404);
  return c.json(out);
});

// PUT /api/professors/me/profile
professorsRouter.put('/me/profile', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  const body = await c.req.json<{ title?: string; bio?: string; photo_url?: string | null }>();
  await db.update(schema.professorProfiles).set({
    title: body.title?.trim() || profile.title,
    bio: body.bio?.trim() ?? profile.bio,
    ...(body.photo_url !== undefined ? { photo_url: body.photo_url } : {}),
  }).where(eq(schema.professorProfiles.id, profile.id));

  return c.json(await getProfessorOut(db, profile.id));
});

// POST /api/professors/me/photo (file upload)
professorsRouter.post('/me/photo', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  if (!file) return c.json({ detail: 'الملف مطلوب' }, 400);

  const contents = await file.arrayBuffer();
  if (contents.byteLength > MAX_UPLOAD_BYTES) return c.json({ detail: 'الملف أكبر من الحد المسموح (20 ميغابايت)' }, 400);

  const sig = validateFileSignature(contents, IMAGE_EXTS);
  if (!sig.valid) {
    return c.json({ detail: 'توقيع الملف أو نوعه الداخلي غير صالح' }, 400);
  }

  const detectedExt = sig.detectedExt === 'jpg' ? 'jpeg' : (sig.detectedExt || 'jpeg');
  const mimeType = `image/${detectedExt}`;

  const storage = createStorageService(c.env.R2_BUCKET);
  const storedName = safeUploadName(file.name, IMAGE_EXTS, 'photo');
  await storage.save(storedName, contents, mimeType);

  const photoUrl = mediaUrl(storedName);
  try {
    await db.insert(schema.mediaFiles).values({
      id: schema.genId(),
      filename: storedName,
      url: photoUrl,
      content_type: mimeType,
      size_bytes: contents.byteLength,
      uploaded_by: user.id,
      is_deleted: false,
    });
  } catch (_) {}

  await db.update(schema.professorProfiles).set({ photo_url: photoUrl }).where(eq(schema.professorProfiles.id, profile.id));

  return c.json({ photo_url: photoUrl });
});

// GET /api/professors/me/dashboard
professorsRouter.get('/me/dashboard', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  const booklets = await db.select().from(schema.booklets).where(eq(schema.booklets.professor_id, profile.id));
  const exams = await db.select().from(schema.exams).where(eq(schema.exams.professor_id, profile.id));

  // Student activity
  let studentCount = 0;
  let avgScore: number | null = null;
  if (profile.subject_id) {
    const questionsInSubject = await db.select({ id: schema.questions.id }).from(schema.questions).where(eq(schema.questions.subject_id, profile.subject_id));
    const qIds = questionsInSubject.map((q) => q.id);
    if (qIds.length > 0) {
      const answers = await db.select().from(schema.studentAnswers).where(inArray(schema.studentAnswers.question_id, qIds));
      const studentIds = new Set(answers.map((a) => a.user_id));
      studentCount = studentIds.size;
      if (answers.length > 0) {
        avgScore = Math.round(100 * answers.filter((a) => a.is_correct).length / answers.length);
      }
    }
  }

  const subject = profile.subject_id ? await db.select().from(schema.subjects).where(eq(schema.subjects.id, profile.subject_id)).get() : null;

  return c.json({
    professor: { id: profile.id, name: user.full_name, title: profile.title, subject: subject?.name ?? '', bio: profile.bio ?? '', photo_url: profile.photo_url },
    booklet_count: booklets.length,
    exam_count: exams.length,
    student_count: studentCount,
    avg_student_score: avgScore,
    booklets: booklets.map((b) => ({ id: b.id, title: b.title, pages: b.pages, file_url: b.file_url ?? null })),
    exams: exams.map((e) => ({ id: e.id, title: e.title, question_count: e.question_count, duration_minutes: e.duration_minutes })),
  });
});

// GET /api/professors/me/students
professorsRouter.get('/me/students', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  if (!profile.subject_id) return c.json([]);

  const questionsInSubject = await db.select({ id: schema.questions.id }).from(schema.questions).where(eq(schema.questions.subject_id, profile.subject_id));
  const qIds = questionsInSubject.map((q) => q.id);
  if (qIds.length === 0) return c.json([]);

  const answers = await db.select().from(schema.studentAnswers).where(inArray(schema.studentAnswers.question_id, qIds));
  const byStudent: Record<string, typeof answers> = {};
  for (const a of answers) {
    byStudent[a.user_id] ??= [];
    byStudent[a.user_id].push(a);
  }

  const out = [];
  for (const [studentId, ans] of Object.entries(byStudent)) {
    const student = await db.select().from(schema.users).where(eq(schema.users.id, studentId)).get();
    if (!student) continue;
    const avg = Math.round(100 * ans.filter((a) => a.is_correct).length / ans.length);
    const lastAnswered = ans.map((a) => a.answered_at).sort().reverse()[0];
    out.push({ id: student.id, name: student.full_name, answered_count: ans.length, avg_score: avg, last_answered_at: lastAnswered });
  }
  out.sort((a, b) => (b.last_answered_at ?? '').localeCompare(a.last_answered_at ?? ''));
  return c.json(out);
});

// ── Booklets CRUD ──────────────────────────────────────────────────

professorsRouter.post('/me/booklets', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  const body = await c.req.json<{ title: string; pages?: number }>();
  const id = schema.genId();
  await db.insert(schema.booklets).values({ id, professor_id: profile.id, title: body.title, pages: body.pages });

  // Notify
  const subject = profile.subject_id ? await db.select().from(schema.subjects).where(eq(schema.subjects.id, profile.subject_id)).get() : null;
  await db.insert(schema.notifications).values({
    id: schema.genId(),
    title: `ملزمة جديدة: ${body.title}`,
    body: `أضاف ${user.full_name} ملزمة جديدة في مادة ${subject?.name ?? ''}`,
    content_type: 'booklet',
    content_id: id,
  });

  const booklet = await db.select().from(schema.booklets).where(eq(schema.booklets.id, id)).get();
  return c.json(booklet);
});

professorsRouter.put('/me/booklets/:booklet_id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  const bookletId = c.req.param('booklet_id');
  const booklet = await db.select().from(schema.booklets).where(eq(schema.booklets.id, bookletId)).get();
  if (!booklet || booklet.professor_id !== profile.id) return c.json({ detail: 'الملزمة غير موجودة' }, 404);

  const body = await c.req.json<{ title: string; pages?: number }>();
  await db.update(schema.booklets).set({ title: body.title, pages: body.pages }).where(eq(schema.booklets.id, bookletId));
  return c.json(await db.select().from(schema.booklets).where(eq(schema.booklets.id, bookletId)).get());
});

professorsRouter.delete('/me/booklets/:booklet_id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  const bookletId = c.req.param('booklet_id');
  const booklet = await db.select().from(schema.booklets).where(eq(schema.booklets.id, bookletId)).get();
  if (!booklet || booklet.professor_id !== profile.id) return c.json({ detail: 'الملزمة غير موجودة' }, 404);

  await db.delete(schema.booklets).where(eq(schema.booklets.id, bookletId));
  return c.json({ ok: true });
});

professorsRouter.post('/me/booklets/:booklet_id/file', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  const bookletId = c.req.param('booklet_id');
  const booklet = await db.select().from(schema.booklets).where(eq(schema.booklets.id, bookletId)).get();
  if (!booklet || booklet.professor_id !== profile.id) return c.json({ detail: 'الملزمة غير موجودة' }, 404);

  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  if (!file) return c.json({ detail: 'الملف مطلوب' }, 400);

  const contents = await file.arrayBuffer();
  if (contents.byteLength > MAX_UPLOAD_BYTES) return c.json({ detail: 'الملف أكبر من الحد المسموح (20 ميغابايت)' }, 400);

  const sig = validateFileSignature(contents, DOC_EXTS);
  if (!sig.valid) {
    return c.json({ detail: 'توقيع الملف أو نوعه الداخلي غير صالح' }, 400);
  }

  const detectedExt = sig.detectedExt === 'jpg' ? 'jpeg' : (sig.detectedExt || 'pdf');
  const mimeType = detectedExt === 'pdf' ? 'application/pdf' : `image/${detectedExt}`;

  const storage = createStorageService(c.env.R2_BUCKET);
  const storedName = safeUploadName(file.name, DOC_EXTS, 'booklet');
  await storage.save(storedName, contents, mimeType);

  const fileUrl = mediaUrl(storedName);
  try {
    await db.insert(schema.mediaFiles).values({
      id: schema.genId(),
      filename: storedName,
      url: fileUrl,
      content_type: mimeType,
      size_bytes: contents.byteLength,
      uploaded_by: user.id,
      is_deleted: false,
    });
  } catch (_) {}

  await db.update(schema.booklets).set({ file_url: fileUrl }).where(eq(schema.booklets.id, bookletId));
  return c.json(await db.select().from(schema.booklets).where(eq(schema.booklets.id, bookletId)).get());
});

// ── Exams CRUD ──────────────────────────────────────────────────────

professorsRouter.post('/me/exams', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  const body = await c.req.json<{ title: string; question_count?: number; duration_minutes?: number }>();
  const id = schema.genId();
  await db.insert(schema.exams).values({ id, subject_id: profile.subject_id, professor_id: profile.id, title: body.title, question_count: body.question_count, duration_minutes: body.duration_minutes });

  const subject = profile.subject_id ? await db.select().from(schema.subjects).where(eq(schema.subjects.id, profile.subject_id)).get() : null;
  await db.insert(schema.notifications).values({
    id: schema.genId(), title: `امتحان جديد: ${body.title}`,
    body: `أضاف ${user.full_name} امتحان جديد في مادة ${subject?.name ?? ''}`,
    content_type: 'exam', content_id: id,
  });

  return c.json(await db.select().from(schema.exams).where(eq(schema.exams.id, id)).get());
});

professorsRouter.put('/me/exams/:exam_id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  const examId = c.req.param('exam_id');
  const exam = await db.select().from(schema.exams).where(eq(schema.exams.id, examId)).get();
  if (!exam || exam.professor_id !== profile.id) return c.json({ detail: 'الامتحان غير موجود' }, 404);

  const body = await c.req.json<{ title: string; question_count?: number; duration_minutes?: number }>();
  await db.update(schema.exams).set({ title: body.title, question_count: body.question_count, duration_minutes: body.duration_minutes }).where(eq(schema.exams.id, examId));
  return c.json(await db.select().from(schema.exams).where(eq(schema.exams.id, examId)).get());
});

professorsRouter.delete('/me/exams/:exam_id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  const examId = c.req.param('exam_id');
  const exam = await db.select().from(schema.exams).where(eq(schema.exams.id, examId)).get();
  if (!exam || exam.professor_id !== profile.id) return c.json({ detail: 'الامتحان غير موجود' }, 404);

  await db.delete(schema.exams).where(eq(schema.exams.id, examId));
  return c.json({ ok: true });
});

// ── Courses & Lectures CRUD ─────────────────────────────────────────

professorsRouter.get('/me/courses', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  const courses = await db.select().from(schema.courses).where(eq(schema.courses.professor_id, profile.id));
  const result = await Promise.all(courses.map(async (course) => {
    const lectures = await db.select().from(schema.lectures).where(eq(schema.lectures.course_id, course.id)).orderBy(asc(schema.lectures.order_index));
    return {
      id: course.id, title: course.title,
      lectures: lectures.map((l) => ({ id: l.id, title: l.title, duration_seconds: l.duration_seconds, video_url: l.video_url ?? null })),
    };
  }));
  return c.json(result);
});

professorsRouter.post('/me/courses', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  const body = await c.req.json<{ title: string }>();
  const id = schema.genId();
  await db.insert(schema.courses).values({ id, subject_id: profile.subject_id, professor_id: profile.id, title: body.title });
  return c.json({ id, title: body.title, lectures: [] });
});

professorsRouter.put('/me/courses/:course_id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  const courseId = c.req.param('course_id');
  const course = await db.select().from(schema.courses).where(eq(schema.courses.id, courseId)).get();
  if (!course || course.professor_id !== profile.id) return c.json({ detail: 'الكورس غير موجود' }, 404);

  const body = await c.req.json<{ title: string }>();
  await db.update(schema.courses).set({ title: body.title }).where(eq(schema.courses.id, courseId));
  return c.json({ ok: true });
});

professorsRouter.delete('/me/courses/:course_id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  const courseId = c.req.param('course_id');
  const course = await db.select().from(schema.courses).where(eq(schema.courses.id, courseId)).get();
  if (!course || course.professor_id !== profile.id) return c.json({ detail: 'الكورس غير موجود' }, 404);

  const lectures = await db.select().from(schema.lectures).where(eq(schema.lectures.course_id, courseId));
  const lecIds = lectures.map((l) => l.id);
  if (lecIds.length > 0) {
    await db.delete(schema.lectureProgress).where(inArray(schema.lectureProgress.lecture_id, lecIds));
    await db.delete(schema.lectures).where(inArray(schema.lectures.id, lecIds));
  }
  await db.delete(schema.courses).where(eq(schema.courses.id, courseId));
  return c.json({ ok: true });
});

professorsRouter.post('/me/courses/:course_id/lectures', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  const courseId = c.req.param('course_id');
  const course = await db.select().from(schema.courses).where(eq(schema.courses.id, courseId)).get();
  if (!course || course.professor_id !== profile.id) return c.json({ detail: 'الكورس غير موجود' }, 404);

  const existing = await db.select().from(schema.lectures).where(eq(schema.lectures.course_id, courseId));
  const body = await c.req.json<{ title: string; duration_seconds?: number }>();
  const id = schema.genId();
  await db.insert(schema.lectures).values({ id, course_id: courseId, title: body.title, duration_seconds: body.duration_seconds, order_index: existing.length });
  return c.json({ id, title: body.title, duration_seconds: body.duration_seconds, video_url: null });
});

professorsRouter.put('/me/lectures/:lecture_id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  const lectureId = c.req.param('lecture_id');
  const lecture = await db.select().from(schema.lectures).where(eq(schema.lectures.id, lectureId)).get();
  if (!lecture) return c.json({ detail: 'المحاضرة غير موجودة' }, 404);

  const course = await db.select().from(schema.courses).where(eq(schema.courses.id, lecture.course_id ?? '')).get();
  if (!course || course.professor_id !== profile.id) return c.json({ detail: 'المحاضرة غير موجودة' }, 404);

  const body = await c.req.json<{ title: string; duration_seconds?: number }>();
  await db.update(schema.lectures).set({ title: body.title, duration_seconds: body.duration_seconds }).where(eq(schema.lectures.id, lectureId));
  return c.json({ ok: true });
});

professorsRouter.delete('/me/lectures/:lecture_id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  const lectureId = c.req.param('lecture_id');
  const lecture = await db.select().from(schema.lectures).where(eq(schema.lectures.id, lectureId)).get();
  if (!lecture) return c.json({ detail: 'المحاضرة غير موجودة' }, 404);

  const course = await db.select().from(schema.courses).where(eq(schema.courses.id, lecture.course_id ?? '')).get();
  if (!course || course.professor_id !== profile.id) return c.json({ detail: 'المحاضرة غير موجودة' }, 404);

  await db.delete(schema.lectureProgress).where(eq(schema.lectureProgress.lecture_id, lectureId));
  await db.delete(schema.lectures).where(eq(schema.lectures.id, lectureId));
  return c.json({ ok: true });
});

professorsRouter.post('/me/lectures/:lecture_id/file', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const profile = await getOwnProfile(db, user.id, user.role);
  if (!profile) return c.json({ detail: 'هذه الواجهة مخصصة للدكاترة فقط' }, 403);

  const lectureId = c.req.param('lecture_id');
  const lecture = await db.select().from(schema.lectures).where(eq(schema.lectures.id, lectureId)).get();
  if (!lecture) return c.json({ detail: 'المحاضرة غير موجودة' }, 404);

  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  if (!file) return c.json({ detail: 'الملف مطلوب' }, 400);

  const contents = await file.arrayBuffer();
  if (contents.byteLength > MAX_VIDEO_BYTES) return c.json({ detail: 'الملف أكبر من الحد المسموح (150 ميغابايت)' }, 400);

  const sig = validateFileSignature(contents, VIDEO_EXTS);
  if (!sig.valid) {
    return c.json({ detail: 'توقيع الملف أو نوعه الداخلي غير صالح' }, 400);
  }

  const mimeType = sig.detectedExt === 'webm' ? 'video/webm' : 'video/mp4';

  const storage = createStorageService(c.env.R2_BUCKET);
  const storedName = safeUploadName(file.name, VIDEO_EXTS, 'lecture');
  await storage.save(storedName, contents, mimeType);

  const videoUrl = mediaUrl(storedName);
  try {
    await db.insert(schema.mediaFiles).values({
      id: schema.genId(),
      filename: storedName,
      url: videoUrl,
      content_type: mimeType,
      size_bytes: contents.byteLength,
      uploaded_by: user.id,
      is_deleted: false,
    });
  } catch (_) {}

  await db.update(schema.lectures).set({ video_url: videoUrl }).where(eq(schema.lectures.id, lectureId));
  return c.json({ id: lectureId, title: lecture.title, duration_seconds: lecture.duration_seconds, video_url: videoUrl });
});
