/**
 * Server-side content policy.  URLs and hidden UI controls are never proof of
 * entitlement: every protected course, booklet and media object resolves to a
 * subject and is checked here.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import type { CurrentUser } from '../types';

// Routes may create Drizzle with or without a schema generic.  The policy
// operates only through explicit schema tables, so it deliberately accepts the
// common D1 Drizzle shape rather than forcing every caller's generic.
type Db = ReturnType<typeof drizzle>;

export async function canAccessSubject(
  db: Db,
  user: CurrentUser,
  subjectId: string
): Promise<boolean> {
  if (user.role === 'admin') return true;

  const subject = await db.select().from(schema.subjects)
    .where(eq(schema.subjects.id, subjectId)).get();
  if (!subject?.stage_id) return false;

  // Academic staff are limited to the subjects assigned to their own profile.
  if (user.role === 'professor') {
    return Boolean(await db.select({ id: schema.professorProfiles.id })
      .from(schema.professorProfiles)
      .where(and(
        eq(schema.professorProfiles.user_id, user.id),
        eq(schema.professorProfiles.subject_id, subjectId)
      )).get());
  }
  if (user.role !== 'student') return false;

  // A valid, non-expired activation grants the subject independently of the
  // student's academic placement.
  const activation = await db.select({ id: schema.activationCodes.id })
    .from(schema.activationCodes)
    .where(and(
      eq(schema.activationCodes.subject_id, subjectId),
      eq(schema.activationCodes.activated_by_user_id, user.id),
      eq(schema.activationCodes.status, 'active')
    )).get();
  if (activation) return true;

  const stage = await db.select().from(schema.stages)
    .where(eq(schema.stages.id, subject.stage_id)).get();
  if (!stage || !user.stage_id || user.stage_id !== stage.id) return false;

  // Stage is the authoritative node in the hierarchy.  Check every populated
  // scope component so an inconsistent profile never gains content access.
  if (stage.university_id && user.university_id !== stage.university_id) return false;
  if (stage.college_id && user.college_id !== stage.college_id) return false;
  if (stage.department_id && user.department_id !== stage.department_id) return false;
  return true;
}

export async function canAccessCourse(
  db: Db,
  user: CurrentUser,
  course: typeof schema.courses.$inferSelect
): Promise<boolean> {
  if (course.is_deleted || !course.subject_id) return false;
  if (user.role === 'professor' && course.professor_id) {
    const ownsCourse = await db.select({ id: schema.professorProfiles.id })
      .from(schema.professorProfiles)
      .where(and(
        eq(schema.professorProfiles.id, course.professor_id),
        eq(schema.professorProfiles.user_id, user.id)
      )).get();
    if (ownsCourse) return true;
  }
  return canAccessSubject(db, user, course.subject_id);
}

export async function canAccessMedia(
  db: Db,
  user: CurrentUser,
  media: typeof schema.mediaFiles.$inferSelect
): Promise<boolean> {
  // A booklet inherits the academic policy of its professor's subject.
  const booklet = await db.select({ subject_id: schema.professorProfiles.subject_id })
    .from(schema.booklets)
    .innerJoin(schema.professorProfiles, eq(schema.booklets.professor_id, schema.professorProfiles.id))
    .where(eq(schema.booklets.file_url, media.url)).get();
  if (booklet?.subject_id) return canAccessSubject(db, user, booklet.subject_id);

  // A lecture inherits the course's subject policy and cannot be accessed when
  // either the course or lecture has been retired.
  const lecture = await db.select({
    subject_id: schema.courses.subject_id,
    course_id: schema.courses.id,
    course_deleted: schema.courses.is_deleted,
    lecture_deleted: schema.lectures.is_deleted,
  })
    .from(schema.lectures)
    .innerJoin(schema.courses, eq(schema.lectures.course_id, schema.courses.id))
    .where(eq(schema.lectures.video_url, media.url)).get();
  if (lecture?.subject_id && !lecture.course_deleted && !lecture.lecture_deleted) {
    const course = await db.select().from(schema.courses).where(eq(schema.courses.id, lecture.course_id)).get();
    return course ? canAccessCourse(db, user, course) : false;
  }

  // Uploaded profile photos belong only to their account owner or administrators.
  if (media.uploaded_by && media.uploaded_by === user.id) return true;
  return user.role === 'admin';
}
