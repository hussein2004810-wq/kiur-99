/**
 * Questions routes — mirrors Python app/routers/questions.py
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, and, inArray } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { requireAuth } from '../middleware/auth';

export const questionsRouter = new Hono<AppEnv>();
questionsRouter.use('*', requireAuth);

// GET /api/subjects/:subject_id/questions
questionsRouter.get('/subjects/:subject_id/questions', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const subjectId = c.req.param('subject_id');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20'), 100);
  const offset = parseInt(c.req.query('offset') ?? '0');

  const questions = await db
    .select()
    .from(schema.questions)
    .where(eq(schema.questions.subject_id, subjectId))
    .limit(limit)
    .offset(offset);

  const questionIds = questions.map((q) => q.id);
  const choices =
    questionIds.length > 0
      ? await db.select().from(schema.choices).where(inArray(schema.choices.question_id, questionIds))
      : [];

  return c.json(
    questions.map((q) => {
      const { rationale: _rationale, ...safeQ } = q;
      return {
        ...safeQ,
        choices: choices
          .filter((ch) => ch.question_id === q.id)
          .map((ch) => ({ id: ch.id, text: ch.text })),
      };
    })
  );
});

// GET /api/questions (with ?subject_id=...)
questionsRouter.get('/questions', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const subjectId = c.req.query('subject_id');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 100);
  const offset = parseInt(c.req.query('offset') ?? '0');

  const questions = subjectId
    ? await db.select().from(schema.questions).where(eq(schema.questions.subject_id, subjectId)).limit(limit).offset(offset)
    : await db.select().from(schema.questions).limit(limit).offset(offset);

  const questionIds = questions.map((q) => q.id);
  const choices =
    questionIds.length > 0
      ? await db.select().from(schema.choices).where(inArray(schema.choices.question_id, questionIds))
      : [];

  return c.json(
    questions.map((q) => {
      const { rationale: _rationale, ...safeQ } = q;
      return {
        ...safeQ,
        choices: choices
          .filter((ch) => ch.question_id === q.id)
          .map((ch) => ({ id: ch.id, text: ch.text })),
      };
    })
  );
});

// GET /api/questions/:id
questionsRouter.get('/questions/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const q = await db.select().from(schema.questions).where(eq(schema.questions.id, id)).get();
  if (!q) return c.json({ detail: 'السؤال غير موجود' }, 404);

  const choices = await db.select().from(schema.choices).where(eq(schema.choices.question_id, id));
  const { rationale: _rationale, ...safeQ } = q;
  return c.json({
    ...safeQ,
    choices: choices.map((ch) => ({ id: ch.id, text: ch.text })),
  });
});

// POST /api/questions/:question_id/answer
questionsRouter.post('/questions/:question_id/answer', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const questionId = c.req.param('question_id');
  const body = await c.req.json<{ choice_id: string }>();

  const question = await db.select().from(schema.questions).where(eq(schema.questions.id, questionId)).get();
  if (!question) return c.json({ detail: 'السؤال غير موجود' }, 404);

  const questionChoices = await db.select().from(schema.choices).where(eq(schema.choices.question_id, questionId));
  const choice = questionChoices.find((ch) => ch.id === body.choice_id);
  if (!choice) return c.json({ detail: 'خيار غير صالح' }, 400);

  const correctChoice = questionChoices.find((ch) => ch.is_correct);

  // Save answer
  await db.insert(schema.studentAnswers).values({
    id: schema.genId(),
    user_id: user.id,
    question_id: questionId,
    choice_id: choice.id,
    is_correct: choice.is_correct ?? false,
  });

  return c.json({
    is_correct: choice.is_correct,
    correct_choice_id: correctChoice?.id ?? '',
    rationale: question.rationale,
  });
});

// POST /api/questions/:question_id/save
questionsRouter.post('/questions/:question_id/save', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const questionId = c.req.param('question_id');

  const question = await db.select().from(schema.questions).where(eq(schema.questions.id, questionId)).get();
  if (!question) return c.json({ detail: 'السؤال غير موجود' }, 404);

  const existing = await db
    .select()
    .from(schema.savedQuestions)
    .where(and(eq(schema.savedQuestions.user_id, user.id), eq(schema.savedQuestions.question_id, questionId)))
    .get();

  if (!existing) {
    await db.insert(schema.savedQuestions).values({
      id: schema.genId(),
      user_id: user.id,
      question_id: questionId,
    });
  }
  return c.json({ ok: true, saved: true });
});

// DELETE /api/questions/:question_id/save
questionsRouter.delete('/questions/:question_id/save', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const questionId = c.req.param('question_id');

  await db
    .delete(schema.savedQuestions)
    .where(and(eq(schema.savedQuestions.user_id, user.id), eq(schema.savedQuestions.question_id, questionId)));

  return c.json({ ok: true, saved: false });
});

// GET /api/me/saved-questions
questionsRouter.get('/me/saved-questions', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;

  const saved = await db
    .select()
    .from(schema.savedQuestions)
    .where(eq(schema.savedQuestions.user_id, user.id))
    .orderBy(desc(schema.savedQuestions.created_at));

  if (saved.length === 0) return c.json([]);

  const order: Record<string, number> = {};
  saved.forEach((s, i) => { order[s.question_id] = i; });

  const questionIds = saved.map((s) => s.question_id);
  const questions = await db.select().from(schema.questions).where(inArray(schema.questions.id, questionIds));
  const choices = await db.select().from(schema.choices).where(inArray(schema.choices.question_id, questionIds));

  const result = questions
    .map((q) => {
      const { rationale: _rationale, ...safeQ } = q;
      return {
        ...safeQ,
        choices: choices
          .filter((ch) => ch.question_id === q.id)
          .map((ch) => ({ id: ch.id, text: ch.text })),
      };
    })
    .sort((a, b) => (order[a.id] ?? 0) - (order[b.id] ?? 0));

  return c.json(result);
});

// GET /api/saved-questions (contract alias)
questionsRouter.get('/saved-questions', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;

  const saved = await db
    .select()
    .from(schema.savedQuestions)
    .where(eq(schema.savedQuestions.user_id, user.id))
    .orderBy(desc(schema.savedQuestions.created_at));

  if (saved.length === 0) return c.json([]);

  const questionIds = saved.map((s) => s.question_id);
  const questions = await db.select().from(schema.questions).where(inArray(schema.questions.id, questionIds));
  const choices = await db.select().from(schema.choices).where(inArray(schema.choices.question_id, questionIds));

  const questionsMap: Record<string, any> = {};
  questions.forEach((q) => {
    const { rationale: _rationale, ...safeQ } = q;
    questionsMap[q.id] = {
      ...safeQ,
      choices: choices.filter((ch) => ch.question_id === q.id).map((ch) => ({ id: ch.id, text: ch.text })),
    };
  });

  return c.json(
    saved.map((s) => ({
      bookmark_id: s.id,
      ...(questionsMap[s.question_id] || {}),
    }))
  );
});

// POST /api/saved-questions/:id (contract alias)
questionsRouter.post('/saved-questions/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const questionId = c.req.param('id');

  const question = await db.select().from(schema.questions).where(eq(schema.questions.id, questionId)).get();
  if (!question) return c.json({ detail: 'السؤال غير موجود' }, 404);

  const existing = await db
    .select()
    .from(schema.savedQuestions)
    .where(and(eq(schema.savedQuestions.user_id, user.id), eq(schema.savedQuestions.question_id, questionId)))
    .get();

  if (!existing) {
    await db.insert(schema.savedQuestions).values({
      id: schema.genId(),
      user_id: user.id,
      question_id: questionId,
    });
  }
  return c.json({ message: 'تم حفظ السؤال', ok: true, saved: true });
});

// DELETE /api/saved-questions/:id (contract alias)
questionsRouter.delete('/saved-questions/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const questionId = c.req.param('id');

  await db
    .delete(schema.savedQuestions)
    .where(and(
      eq(schema.savedQuestions.user_id, user.id),
      eq(schema.savedQuestions.question_id, questionId)
    ));

  return c.json({ message: 'تم إلغاء حفظ السؤال', ok: true, saved: false });
});

// GET /api/me/mistakes
questionsRouter.get('/me/mistakes', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 200);

  const wrong = await db
    .select()
    .from(schema.studentAnswers)
    .where(and(eq(schema.studentAnswers.user_id, user.id), eq(schema.studentAnswers.is_correct, false)))
    .orderBy(desc(schema.studentAnswers.answered_at))
    .limit(500);

  const latestPerQuestion: typeof wrong = [];
  const seen = new Set<string>();
  for (const a of wrong) {
    if (seen.has(a.question_id)) continue;
    seen.add(a.question_id);
    latestPerQuestion.push(a);
    if (latestPerQuestion.length >= limit) break;
  }

  if (latestPerQuestion.length === 0) return c.json([]);

  const qIds = latestPerQuestion.map((a) => a.question_id);
  const cIds = latestPerQuestion.map((a) => a.choice_id).filter(Boolean) as string[];

  const questionsMap: Record<string, typeof schema.questions.$inferSelect & { choices: typeof schema.choices.$inferSelect[] }> = {};
  const qs = await db.select().from(schema.questions).where(inArray(schema.questions.id, qIds));
  const allChoices = qIds.length > 0 ? await db.select().from(schema.choices).where(inArray(schema.choices.question_id, qIds)) : [];
  qs.forEach((q) => {
    questionsMap[q.id] = { ...q, choices: allChoices.filter((ch) => ch.question_id === q.id) };
  });

  const choicesMap: Record<string, typeof schema.choices.$inferSelect> = {};
  if (cIds.length > 0) {
    const chRows = await db.select().from(schema.choices).where(inArray(schema.choices.id, cIds));
    chRows.forEach((ch) => { choicesMap[ch.id] = ch; });
  }

  const out = latestPerQuestion.map((a) => {
    const q = questionsMap[a.question_id];
    if (!q) return null;
    const correct = q.choices.find((ch) => ch.is_correct);
    const yourChoice = a.choice_id ? choicesMap[a.choice_id] : undefined;
    return {
      question_id: q.id,
      eyebrow: q.eyebrow,
      text: q.text,
      rationale: q.rationale,
      your_choice: yourChoice?.text ?? null,
      correct_choice: correct?.text ?? null,
      answered_at: a.answered_at,
    };
  }).filter(Boolean);

  return c.json(out);
});
