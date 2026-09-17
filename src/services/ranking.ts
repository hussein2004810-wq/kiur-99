/**
 * Ranking helpers — mirrors Python app/ranking.py
 * All aggregations done in SQL (D1 SQLite) for efficiency.
 */
import { drizzle } from 'drizzle-orm/d1';
import { eq, inArray, and } from 'drizzle-orm';
import * as schema from '../db/schema';

type DB = ReturnType<typeof drizzle>;

/** The student's ranking cohort — their university if set, else all students. */
export async function peerIds(db: DB, userId: string, universityId: string | null): Promise<string[]> {
  const students = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, 'student'));
  if (!universityId) return students.map((u) => u.id);

  const filtered = students.filter(async (_) => true); // We'll filter in-memory since D1 is serverless SQLite
  // Re-query with university filter
  const uniStudents = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.role, 'student'), eq(schema.users.university_id, universityId)));
  return uniStudents.map((u) => u.id);
}

/** {user_id: count of distinct questions answered correctly} */
export async function correctCounts(db: DB, userIds: string[]): Promise<Record<string, number>> {
  if (userIds.length === 0) return {};
  const answers = await db
    .select()
    .from(schema.studentAnswers)
    .where(and(inArray(schema.studentAnswers.user_id, userIds), eq(schema.studentAnswers.is_correct, true)));

  // Count distinct questions per user
  const result: Record<string, Set<string>> = {};
  for (const a of answers) {
    result[a.user_id] ??= new Set();
    result[a.user_id].add(a.question_id);
  }
  const counts: Record<string, number> = {};
  for (const [uid, qSet] of Object.entries(result)) {
    counts[uid] = qSet.size;
  }
  return counts;
}

/** Accuracy percentage for one user — null if never answered. */
export async function accuracyPct(db: DB, userId: string): Promise<number | null> {
  const answers = await db
    .select()
    .from(schema.studentAnswers)
    .where(eq(schema.studentAnswers.user_id, userId));

  if (answers.length === 0) return null;
  const correct = answers.filter((a) => a.is_correct).length;
  return Math.round(100 * correct / answers.length);
}

/** [(user_id, score)] ordered best-first */
export async function rankedPairs(db: DB, userIds: string[]): Promise<Array<[string, number]>> {
  const scores = await correctCounts(db, userIds);
  const pairs: Array<[string, number]> = userIds.map((uid) => [uid, scores[uid] ?? 0]);
  return pairs.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function rankOf(ranked: Array<[string, number]>, userId: string): number | null {
  const idx = ranked.findIndex(([uid]) => uid === userId);
  return idx === -1 ? null : idx + 1;
}

/** Consecutive days up to today with at least one answer. */
export async function streakDays(db: DB, userId: string): Promise<number> {
  const answers = await db
    .select({ answered_at: schema.studentAnswers.answered_at })
    .from(schema.studentAnswers)
    .where(eq(schema.studentAnswers.user_id, userId));

  const days = new Set<string>();
  for (const a of answers) {
    if (a.answered_at) {
      days.add(String(a.answered_at).slice(0, 10));
    }
  }

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  let cursor = todayStr;
  if (!days.has(cursor)) {
    // today isn't a broken streak until it ends
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    cursor = yesterday.toISOString().slice(0, 10);
  }

  let streak = 0;
  while (days.has(cursor)) {
    streak++;
    const d = new Date(cursor + 'T00:00:00Z');
    d.setDate(d.getDate() - 1);
    cursor = d.toISOString().slice(0, 10);
  }
  return streak;
}
