/**
 * Students routes — mirrors Python app/routers/students.py
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, inArray, like } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { requireAuth } from '../middleware/auth';
import { peerIds, rankedPairs, rankOf, streakDays, accuracyPct } from '../services/ranking';

export const studentsRouter = new Hono<AppEnv>();
studentsRouter.use('*', requireAuth);

// GET /api/students — search
studentsRouter.get('/', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const q = c.req.query('q') ?? '';

  let students;
  if (q) {
    const all = await db.select().from(schema.users).where(eq(schema.users.role, 'student'));
    students = all.filter((s) =>
      s.full_name.toLowerCase().includes(q.toLowerCase()) ||
      s.email.toLowerCase().includes(q.toLowerCase())
    );
  } else {
    students = await db.select().from(schema.users).where(eq(schema.users.role, 'student'));
  }

  return c.json(students.map((s) => ({
    id: s.id,
    full_name: s.full_name,
    email: s.email,
    photo_url: s.photo_url,
    university_id: s.university_id,
    stage_id: s.stage_id,
  })));
});

// GET /api/students/:id/profile
studentsRouter.get('/:id/profile', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const currentUser = c.get('user')!;
  const targetId = c.req.param('id');

  const target = await db.select().from(schema.users).where(eq(schema.users.id, targetId)).get();
  if (!target) return c.json({ detail: 'الطالب غير موجود' }, 404);

  const answers = await db.select().from(schema.studentAnswers).where(eq(schema.studentAnswers.user_id, targetId));
  const correctCount = answers.filter((a) => a.is_correct).length;

  const fullUser = await db.select().from(schema.users).where(eq(schema.users.id, currentUser.id)).get();
  const peers = await peerIds(db, currentUser.id, fullUser?.university_id ?? null);
  const ranked = await rankedPairs(db, peers);

  let university = null;
  if (target.university_id) {
    university = await db.select().from(schema.universities).where(eq(schema.universities.id, target.university_id)).get();
  }
  let stage = null;
  if (target.stage_id) {
    stage = await db.select().from(schema.stages).where(eq(schema.stages.id, target.stage_id)).get();
  }

  const skills = await db.select().from(schema.userSkills).where(eq(schema.userSkills.user_id, targetId));

  return c.json({
    id: target.id,
    full_name: target.full_name,
    photo_url: target.photo_url,
    caption: target.caption,
    university_name: university?.name ?? null,
    stage_name: stage?.name ?? null,
    skills: skills.map((s) => s.text),
    answered_count: answers.length,
    correct_count: correctCount,
    streak_days: await streakDays(db, targetId),
    accuracy_pct: await accuracyPct(db, targetId),
    rank: rankOf(ranked, targetId),
    total_ranked: ranked.length,
  });
});
