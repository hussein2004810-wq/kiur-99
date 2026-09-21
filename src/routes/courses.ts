/**
 * Courses and lectures routes — mirrors Python app/routers/courses.py
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, inArray, asc, and, like, desc } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { requireAuth, optionalAuth } from '../middleware/auth';
import { canAccessCourse } from '../services/content-access';

/**
 * Checks if a user is entitled to view course videos and materials.
 * Admins and professors are always entitled.
 * Students must be academically enrolled in the matching stage or have an active code.
 */
export async function isUserEntitledToCourse(
  db: ReturnType<typeof drizzle>,
  user: any,
  course: typeof schema.courses.$inferSelect
): Promise<boolean> {
  return canAccessCourse(db, user, course);
}

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
  doneLectureIds: Set<string>,
  isEntitled: boolean
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
    entitled: isEntitled,
    lectures: lectures.map((l) => ({
      id: l.id,
      title: l.title,
      duration_seconds: l.duration_seconds,
      order_index: l.order_index,
      video_url: isEntitled ? (l.video_url ?? null) : null,
      done: doneLectureIds.has(l.id),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Courses Router (mounted at /api/courses)
// ─────────────────────────────────────────────────────────────────────────────
export const coursesRouter = new Hono<AppEnv>();
coursesRouter.use('*', optionalAuth);

// GET /api/courses/search?q=...
coursesRouter.get('/search', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const q = c.req.query('q') || '';
  const rows = await db
    .select()
    .from(schema.courses)
    .where(like(schema.courses.title, `%${q}%`));
  return c.json(rows);
});

// GET /api/courses
coursesRouter.get('/', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user');
  const subjectId = c.req.query('subject_id');

  const courses = subjectId
    ? await db.select().from(schema.courses).where(eq(schema.courses.subject_id, subjectId))
    : await db.select().from(schema.courses);

  const done = user ? await doneIds(db, user.id) : new Set<string>();

  const result = await Promise.all(
    courses.map(async (course) => {
      const isEntitled = user ? await isUserEntitledToCourse(db, user, course) : false;
      return buildCourseOut(db, course, done, isEntitled);
    })
  );
  return c.json(result);
});

// GET /api/courses/:course_id
coursesRouter.get('/:course_id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user');
  const courseId = c.req.param('course_id') ?? '';

  const course = await db.select().from(schema.courses).where(eq(schema.courses.id, courseId)).get();
  if (!course) return c.json({ detail: 'الكورس غير موجود' }, 404);

  const isEntitled = user ? await isUserEntitledToCourse(db, user, course) : false;
  const done = user ? await doneIds(db, user.id) : new Set<string>();
  return c.json(await buildCourseOut(db, course, done, isEntitled));
});

// GET /api/courses/:course_id/lectures
coursesRouter.get('/:course_id/lectures', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user');
  const courseId = c.req.param('course_id');

  const course = await db.select().from(schema.courses).where(eq(schema.courses.id, courseId)).get();
  if (!course) return c.json({ detail: 'الكورس غير موجود' }, 404);

  const isEntitled = user ? await isUserEntitledToCourse(db, user, course) : false;
  const lectures = await db
    .select()
    .from(schema.lectures)
    .where(eq(schema.lectures.course_id, courseId))
    .orderBy(asc(schema.lectures.order_index));

  return c.json(
    lectures.map((l) => ({
      ...l,
      video_url: isEntitled ? l.video_url : null,
    }))
  );
});

// GET /api/courses/:course_id/stats
coursesRouter.get('/:course_id/stats', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const courseId = c.req.param('course_id');

  const lectures = await db
    .select({ duration_seconds: schema.lectures.duration_seconds })
    .from(schema.lectures)
    .where(eq(schema.lectures.course_id, courseId));

  const totalSecs = lectures.reduce((sum, l) => sum + (l.duration_seconds || 0), 0);
  return c.json({ lecture_count: lectures.length, total_duration_seconds: totalSecs });
});

// GET /api/courses/:course_id/materials
coursesRouter.get('/:course_id/materials', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const courseId = c.req.param('course_id') ?? '';

  const course = await db.select().from(schema.courses).where(eq(schema.courses.id, courseId)).get();
  if (!course) return c.json({ detail: 'الكورس غير موجود' }, 404);

  // Enforce entitlement
  const isEntitled = await isUserEntitledToCourse(db, user, course);
  if (!isEntitled) {
    return c.json({ detail: 'غير مصرح بالوصول إلى مواد هذا الكورس' }, 403);
  }

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
coursesRouter.post('/lectures/:lecture_id/complete', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const lectureId = c.req.param('lecture_id') ?? '';
  if (!lectureId) return c.json({ detail: 'المحاضرة غير موجودة' }, 404);

  const lecture = await db.select().from(schema.lectures).where(eq(schema.lectures.id, lectureId)).get();
  if (!lecture) return c.json({ detail: 'المحاضرة غير موجودة' }, 404);

  if (!lecture.course_id) return c.json({ detail: 'المحاضرة غير مرتبطة بكورس صالح' }, 404);
  const course = await db.select().from(schema.courses).where(eq(schema.courses.id, lecture.course_id)).get();
  if (!course || !(await isUserEntitledToCourse(db, user, course))) {
    return c.json({ detail: 'غير مصرح بتسجيل تقدم هذه المحاضرة' }, 403);
  }

  // Fixed: use and(...) instead of JavaScript short-circuit &&
  const existing = await db
    .select()
    .from(schema.lectureProgress)
    .where(and(
      eq(schema.lectureProgress.user_id, user.id),
      eq(schema.lectureProgress.lecture_id, lectureId)
    ))
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

// ─────────────────────────────────────────────────────────────────────────────
// 2. Lectures Router (mounted at /api/lectures)
// ─────────────────────────────────────────────────────────────────────────────
export const lecturesRouter = new Hono<AppEnv>();

// GET /api/lectures/:id
lecturesRouter.get('/:id', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id') as string;
  if (!id) return c.json({ detail: 'المحاضرة غير موجودة' }, 404);
  const user = c.get('user');

  const lec = await db.select().from(schema.lectures).where(eq(schema.lectures.id, id)).get();
  if (!lec) return c.json({ detail: 'المحاضرة غير موجودة' }, 404);

  const courseId = lec.course_id;
  if (!courseId || lec.is_deleted) return c.json({ detail: 'المحاضرة غير موجودة' }, 404);
  const course = await db.select().from(schema.courses).where(eq(schema.courses.id, courseId)).get();
  if (!course || !(await isUserEntitledToCourse(db, user!, course))) {
    return c.json({ detail: 'غير مصرح بالوصول إلى هذه المحاضرة' }, 403);
  }

  return c.json(lec);
});

// POST /api/lectures/:id/progress
lecturesRouter.post('/:id/progress', requireAuth, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ seconds?: number }>().catch(() => ({ seconds: 0 }));
  return c.json({ message: 'تم تحديث التقدم', lecture_id: id, seconds: body?.seconds ?? 0 });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Recent Views Router (mounted at /api/recent-views)
// ─────────────────────────────────────────────────────────────────────────────
export const recentViewsRouter = new Hono<AppEnv>();
recentViewsRouter.use('*', requireAuth);

// GET /api/recent-views
recentViewsRouter.get('/', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const rows = await db
    .select()
    .from(schema.recentViews)
    .where(eq(schema.recentViews.user_id, user.id))
    .orderBy(desc(schema.recentViews.viewed_at));
  return c.json(rows);
});

// POST /api/recent-views
recentViewsRouter.post('/', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const body = await c.req.json<{ content_type: string; content_id: string }>();

  if (!body.content_type || !body.content_id) {
    return c.json({ detail: 'البيانات غير مكتملة' }, 400);
  }

  await db.insert(schema.recentViews).values({
    id: schema.genId(),
    user_id: user.id,
    content_type: body.content_type,
    content_id: body.content_id,
  });

  return c.json({ message: 'تم تسجيل العرض الأخير', ok: true });
});
