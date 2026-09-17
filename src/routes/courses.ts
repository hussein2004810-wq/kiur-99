/**
 * Courses and lectures routes — mirrors Python app/routers/courses.py
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, inArray, asc } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { requireAuth } from '../middleware/auth';

export const coursesRouter = new Hono<AppEnv>();
coursesRouter.use('*', requireAuth);

async function doneIds(db: ReturnType<typeof drizzle>, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ lecture_id: schema.lectureProgress.lecture_id })
    .from(schema.lectureProgress)
    .where(eq(schema.lectureProgress.user_id, userId));
  return new Set(rows.map((r) => r.lecture_id));
}

async function buildCourseOut(
  db: ReturnType<typeof drizzle>,
  course: typeof schema.courses.$inferSelect,
  doneLectureIds: Set<string>
) {
  const lectures = await db
    .select()
    .from(schema.lectures)
    .where(eq(schema.lectures.course_id, course.id))
    .orderBy(asc(schema.lectures.order_index));

  // Get professor info
  let instructor = 'فريق نبض الأكاديمي';
  if (course.professor_id) {
    const prof = await db
      .select({ user_id: schema.professorProfiles.user_id })
      .from(schema.professorProfiles)
      .where(eq(schema.professorProfiles.id, course.professor_id))
      .get();
    if (prof) {
      const profUser = await db
        .select({ full_name: schema.users.full_name })
        .from(schema.users)
        .where(eq(schema.users.id, prof.user_id))
        .get();
      if (profUser) instructor = profUser.full_name;
    }
  }

  return {
    id: course.id,
    title: course.title,
    instructor,
    subject_id: course.subject_id,
    lectures: lectures.map((l) => ({
      id: l.id,
      title: l.title,
      duration_seconds: l.duration_seconds,
      video_url: l.video_url ?? null,
      done: doneLectureIds.has(l.id),
    })),
  };
}

// GET /api/courses
coursesRouter.get('/', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;

  const courses = await db.select().from(schema.courses);
  const done = await doneIds(db, user.id);

  const result = await Promise.all(courses.map((course) => buildCourseOut(db, course, done)));
  return c.json(result);
});

// GET /api/courses/:course_id
coursesRouter.get('/:course_id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const courseId = c.req.param('course_id');

  const course = await db.select().from(schema.courses).where(eq(schema.courses.id, courseId)).get();
  if (!course) return c.json({ detail: 'الكورس غير موجود' }, 404);

  const done = await doneIds(db, user.id);
  return c.json(await buildCourseOut(db, course, done));
});

// GET /api/courses/:course_id/materials
coursesRouter.get('/:course_id/materials', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const courseId = c.req.param('course_id');

  const course = await db.select().from(schema.courses).where(eq(schema.courses.id, courseId)).get();
  if (!course) return c.json({ detail: 'الكورس غير موجود' }, 404);
  if (!course.subject_id) return c.json({ booklets: [], exams: [] });

  // Get professor profiles whose subject matches
  const profs = await db
    .select({ id: schema.professorProfiles.id })
    .from(schema.professorProfiles)
    .where(eq(schema.professorProfiles.subject_id, course.subject_id));

  const profIds = profs.map((p) => p.id);
  const booklets = profIds.length > 0
    ? await db.select().from(schema.booklets).where(inArray(schema.booklets.professor_id, profIds))
    : [];
  const exams = await db.select().from(schema.exams).where(eq(schema.exams.subject_id, course.subject_id));

  return c.json({
    booklets: booklets.map((b) => ({ id: b.id, title: b.title, pages: b.pages, file_url: b.file_url ?? null })),
    exams: exams.map((e) => ({ id: e.id, title: e.title, question_count: e.question_count, duration_minutes: e.duration_minutes })),
  });
});

// POST /api/courses/lectures/:lecture_id/complete
coursesRouter.post('/lectures/:lecture_id/complete', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const lectureId = c.req.param('lecture_id');

  const lecture = await db.select().from(schema.lectures).where(eq(schema.lectures.id, lectureId)).get();
  if (!lecture) return c.json({ detail: 'المحاضرة غير موجودة' }, 404);

  const existing = await db
    .select()
    .from(schema.lectureProgress)
    .where(eq(schema.lectureProgress.user_id, user.id) && eq(schema.lectureProgress.lecture_id, lectureId))
    .get();

  if (!existing) {
    await db.insert(schema.lectureProgress).values({
      id: schema.genId(),
      user_id: user.id,
      lecture_id: lectureId,
    });
  }
  return c.json({ ok: true });
});
