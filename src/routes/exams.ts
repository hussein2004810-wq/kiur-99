/**
 * Exams routes — mirrors Python app/routers/exams.py
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and, isNull, inArray, asc } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { requireAuth } from '../middleware/auth';

export const examsRouter = new Hono<AppEnv>();
examsRouter.use('*', requireAuth);

function deadline(exam: typeof schema.exams.$inferSelect, attempt: typeof schema.examAttempts.$inferSelect): Date | null {
  if (!exam.duration_minutes) return null;
  const started = new Date(attempt.started_at ?? Date.now());
  return new Date(started.getTime() + exam.duration_minutes * 60000);
}

// POST /api/exams/:exam_id/start
examsRouter.post('/:exam_id/start', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const examId = c.req.param('exam_id');

  const exam = await db.select().from(schema.exams).where(eq(schema.exams.id, examId)).get();
  if (!exam) return c.json({ detail: 'الامتحان غير موجود' }, 404);

  // Check for existing open attempt
  let attempt = await db
    .select()
    .from(schema.examAttempts)
    .where(and(eq(schema.examAttempts.exam_id, examId), eq(schema.examAttempts.user_id, user.id), isNull(schema.examAttempts.finished_at)))
    .get();

  if (!attempt) {
    // Pick random questions
    const pool = await db.select().from(schema.questions).where(eq(schema.questions.subject_id, exam.subject_id ?? ''));
    if (pool.length === 0) return c.json({ detail: 'لا توجد أسئلة متاحة لهذا الامتحان بعد' }, 400);

    // Shuffle
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const count = exam.question_count ?? pool.length;
    const chosen = pool.slice(0, count);

    const attemptId = schema.genId();
    await db.insert(schema.examAttempts).values({
      id: attemptId,
      exam_id: examId,
      user_id: user.id,
      total: chosen.length,
      score: 0,
    });

    for (let idx = 0; idx < chosen.length; idx++) {
      await db.insert(schema.examAttemptQuestions).values({
        id: schema.genId(),
        attempt_id: attemptId,
        question_id: chosen[idx].id,
        order_index: idx,
      });
    }

    attempt = await db.select().from(schema.examAttempts).where(eq(schema.examAttempts.id, attemptId)).get();
  }

  if (!attempt) return c.json({ detail: 'خطأ في إنشاء المحاولة' }, 500);

  const items = await getItemsOut(db, attempt.id, false);
  const dl = deadline(exam, attempt);

  return c.json({
    attempt_id: attempt.id,
    exam_title: exam.title,
    expires_at: dl,
    duration_minutes: exam.duration_minutes,
    total: attempt.total,
    started_at: attempt.started_at,
    finished_at: attempt.finished_at,
    questions: items,
  });
});

// POST /api/exams/attempts/:attempt_id/items/:item_id/answer
examsRouter.post('/attempts/:attempt_id/items/:item_id/answer', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const { attempt_id, item_id } = c.req.param();
  const body = await c.req.json<{ choice_id: string }>();

  const attempt = await db.select().from(schema.examAttempts).where(eq(schema.examAttempts.id, attempt_id)).get();
  if (!attempt || attempt.user_id !== user.id) return c.json({ detail: 'المحاولة غير موجودة' }, 404);

  // Check deadline
  const exam = await db.select().from(schema.exams).where(eq(schema.exams.id, attempt.exam_id)).get();
  if (exam) {
    const dl = deadline(exam, attempt);
    if (dl && new Date() > dl && !attempt.finished_at) {
      await autoFinish(db, attempt.id, dl);
      return c.json({ detail: 'انتهى وقت الامتحان' }, 400);
    }
  }

  if (attempt.finished_at) return c.json({ detail: 'انتهى وقت الامتحان' }, 400);

  const item = await db.select().from(schema.examAttemptQuestions).where(eq(schema.examAttemptQuestions.id, item_id)).get();
  if (!item || item.attempt_id !== attempt_id) return c.json({ detail: 'السؤال غير موجود بهذه المحاولة' }, 404);

  const choices = await db.select().from(schema.choices).where(eq(schema.choices.question_id, item.question_id));
  const choice = choices.find((ch) => ch.id === body.choice_id);
  if (!choice) return c.json({ detail: 'خيار غير صالح' }, 400);

  await db.update(schema.examAttemptQuestions).set({
    choice_id: choice.id,
    is_correct: choice.is_correct,
    answered_at: new Date().toISOString(),
  }).where(eq(schema.examAttemptQuestions.id, item_id));

  return c.json({ ok: true });
});

// POST /api/exams/attempts/:attempt_id/finish
examsRouter.post('/attempts/:attempt_id/finish', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const attemptId = c.req.param('attempt_id');

  const attempt = await db.select().from(schema.examAttempts).where(eq(schema.examAttempts.id, attemptId)).get();
  if (!attempt || attempt.user_id !== user.id) return c.json({ detail: 'المحاولة غير موجودة' }, 404);

  if (!attempt.finished_at) {
    const items = await db.select().from(schema.examAttemptQuestions).where(eq(schema.examAttemptQuestions.attempt_id, attemptId));
    const score = items.filter((it) => it.is_correct).length;
    await db.update(schema.examAttempts).set({
      score,
      finished_at: new Date().toISOString(),
    }).where(eq(schema.examAttempts.id, attemptId));
  }

  const updated = await db.select().from(schema.examAttempts).where(eq(schema.examAttempts.id, attemptId)).get();
  return c.json({ attempt_id: updated!.id, score: updated!.score, total: updated!.total, finished_at: updated!.finished_at });
});

// GET /api/exams/attempts/:attempt_id/result
examsRouter.get('/attempts/:attempt_id/result', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const attemptId = c.req.param('attempt_id');

  const attempt = await db.select().from(schema.examAttempts).where(eq(schema.examAttempts.id, attemptId)).get();
  if (!attempt || attempt.user_id !== user.id) return c.json({ detail: 'المحاولة غير موجودة' }, 404);

  const items = await getItemsOut(db, attemptId, Boolean(attempt.finished_at));

  return c.json({ attempt_id: attempt.id, score: attempt.score, total: attempt.total, finished_at: attempt.finished_at, items });
});

async function autoFinish(db: ReturnType<typeof drizzle>, attemptId: string, finishedAt: Date) {
  const items = await db.select().from(schema.examAttemptQuestions).where(eq(schema.examAttemptQuestions.attempt_id, attemptId));
  const score = items.filter((it) => it.is_correct).length;
  await db.update(schema.examAttempts).set({ score, finished_at: finishedAt.toISOString() }).where(eq(schema.examAttempts.id, attemptId));
}

async function getItemsOut(db: ReturnType<typeof drizzle>, attemptId: string, reveal: boolean) {
  const items = await db
    .select()
    .from(schema.examAttemptQuestions)
    .where(eq(schema.examAttemptQuestions.attempt_id, attemptId))
    .orderBy(asc(schema.examAttemptQuestions.order_index));

  const qIds = items.map((it) => it.question_id);
  if (qIds.length === 0) return [];

  const questions = await db.select().from(schema.questions).where(inArray(schema.questions.id, qIds));
  const choices = await db.select().from(schema.choices).where(inArray(schema.choices.question_id, qIds));

  const qMap: Record<string, typeof schema.questions.$inferSelect> = {};
  questions.forEach((q) => { qMap[q.id] = q; });
  const chMap: Record<string, typeof schema.choices.$inferSelect[]> = {};
  choices.forEach((ch) => { chMap[ch.question_id] ??= []; chMap[ch.question_id].push(ch); });

  return items.map((it) => {
    const q = qMap[it.question_id];
    if (!q) return null;
    const qChoices = chMap[it.question_id] ?? [];
    const correct = qChoices.find((ch) => ch.is_correct);
    const row: Record<string, unknown> = {
      item_id: it.id,
      question_id: q.id,
      eyebrow: q.eyebrow,
      text: q.text,
      image_url: q.image_url,
      choices: qChoices.map((ch) => ({ id: ch.id, text: ch.text })),
      your_choice_id: it.choice_id,
      answered: it.choice_id !== null,
    };
    if (reveal) {
      row.is_correct = it.is_correct;
      row.correct_choice_id = correct?.id ?? null;
      row.rationale = q.rationale;
    }
    return row;
  }).filter(Boolean);
}
