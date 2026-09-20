/**
 * Exams routes — robust, atomic, and secure implementation
 * Complete feature parity with Python backend and contract router
 */
import { Hono, type Context } from 'hono';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { requireAuth } from '../middleware/auth';

export const examsRouter = new Hono<AppEnv>();

function deadline(exam: any, attempt: any): Date | null {
  if (!exam || !exam.duration_minutes) return null;
  let startedStr = attempt.started_at ?? '';
  if (startedStr && !startedStr.includes('T')) {
    startedStr = startedStr.replace(' ', 'T') + 'Z';
  }
  const started = startedStr ? new Date(startedStr) : new Date();
  return new Date(started.getTime() + exam.duration_minutes * 60000);
}

async function autoFinishD1(db: D1Database, attemptId: string, finishedAt: Date) {
  const countRes = await db
    .prepare('SELECT COUNT(*) as c FROM exam_attempt_questions WHERE attempt_id = ? AND is_correct = 1')
    .bind(attemptId)
    .first('c');
  const score = Number(countRes ?? 0);
  await db
    .prepare('UPDATE exam_attempts SET score = ?, finished_at = ? WHERE id = ? AND finished_at IS NULL')
    .bind(score, finishedAt.toISOString(), attemptId)
    .run();
}

async function getItemsOut(db: D1Database, attemptId: string, reveal: boolean) {
  const items = await db
    .prepare('SELECT * FROM exam_attempt_questions WHERE attempt_id = ? ORDER BY order_index ASC')
    .bind(attemptId)
    .all();

  if (!items.results || items.results.length === 0) return [];

  const qIds = (items.results as any[]).map((it) => it.question_id);
  const placeholders = qIds.map(() => '?').join(',');

  const questionsRes = await db
    .prepare(`SELECT * FROM questions WHERE id IN (${placeholders})`)
    .bind(...qIds)
    .all();

  const choicesRes = await db
    .prepare(`SELECT * FROM choices WHERE question_id IN (${placeholders}) ORDER BY order_index ASC`)
    .bind(...qIds)
    .all();

  const qMap: Record<string, any> = {};
  for (const q of questionsRes.results as any[]) {
    qMap[q.id] = q;
  }

  const chMap: Record<string, any[]> = {};
  for (const ch of choicesRes.results as any[]) {
    chMap[ch.question_id] ??= [];
    chMap[ch.question_id].push(ch);
  }

  return (items.results as any[])
    .map((it) => {
      const q = qMap[it.question_id];
      if (!q) return null;
      const qChoices = chMap[it.question_id] ?? [];
      const correct = qChoices.find((ch) => Boolean(ch.is_correct));

      const row: Record<string, unknown> = {
        id: q.id,
        item_id: it.id,
        question_id: q.id,
        eyebrow: q.eyebrow,
        text: q.text,
        image_url: q.image_url,
        choices: qChoices.map((ch) => ({
          id: ch.id,
          text: ch.text,
          order_index: ch.order_index,
        })),
        your_choice_id: it.choice_id,
        answered: it.choice_id !== null,
      };

      if (reveal) {
        row.is_correct = Boolean(it.is_correct);
        row.correct_choice_id = correct?.id ?? null;
        row.rationale = q.rationale;
      }

      return row;
    })
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public Routes: Listing & Leaderboard
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/exams
examsRouter.get('/', async (c) => {
  const subjectId = c.req.query('subject_id');
  let res;
  if (subjectId) {
    res = await c.env.DB.prepare(
      'SELECT * FROM exams WHERE subject_id = ?'
    )
      .bind(subjectId)
      .all();
  } else {
    res = await c.env.DB.prepare(
      'SELECT * FROM exams'
    ).all();
  }
  return c.json(res.results ?? []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Protected Routes: Attempts Management
// (Must be defined before /:id to prevent route shadowing)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/exams/attempts/mine
examsRouter.get('/attempts/mine', requireAuth, async (c) => {
  const user = c.get('user')!;
  const res = await c.env.DB.prepare(`
    SELECT ea.*, e.title as exam_title
    FROM exam_attempts ea
    JOIN exams e ON ea.exam_id = e.id
    WHERE ea.user_id = ?
    ORDER BY ea.started_at DESC
  `)
    .bind(user.id)
    .all();

  return c.json(res.results ?? []);
});

// GET /api/exams/attempts/:attempt_id/review
examsRouter.get('/attempts/:attempt_id/review', requireAuth, async (c) => {
  const user = c.get('user')!;
  const attemptId = c.req.param('attempt_id');

  const attempt = await c.env.DB.prepare('SELECT * FROM exam_attempts WHERE id = ?')
    .bind(attemptId)
    .first();
  if (!attempt) return c.json({ detail: 'المحاولة غير موجودة' }, 404);
  if (attempt.user_id !== user.id) return c.json({ detail: 'غير مصرح' }, 403);

  const questionsRes = await c.env.DB.prepare(`
    SELECT eaq.choice_id as user_choice_id, eaq.is_correct, q.*
    FROM exam_attempt_questions eaq
    JOIN questions q ON eaq.question_id = q.id
    WHERE eaq.attempt_id = ?
    ORDER BY eaq.order_index ASC
  `)
    .bind(attemptId)
    .all();

  const questionsWithChoices = [];
  for (const q of (questionsRes.results ?? []) as any[]) {
    const choices = await c.env.DB.prepare(
      'SELECT id, text, order_index, is_correct FROM choices WHERE question_id = ? ORDER BY order_index ASC'
    )
      .bind(q.id)
      .all();
    questionsWithChoices.push({ ...q, choices: choices.results ?? [] });
  }

  return c.json({ attempt, questions: questionsWithChoices });
});

// GET /api/exams/attempts/:attempt_id/result
examsRouter.get('/attempts/:attempt_id/result', requireAuth, async (c) => {
  const user = c.get('user')!;
  const attemptId = c.req.param('attempt_id') ?? '';

  const attempt = await c.env.DB.prepare('SELECT * FROM exam_attempts WHERE id = ?')
    .bind(attemptId)
    .first();
  if (!attempt) return c.json({ detail: 'المحاولة غير موجودة' }, 404);
  if (attempt.user_id !== user.id) return c.json({ detail: 'المحاولة غير موجودة' }, 404);

  const items = await getItemsOut(c.env.DB, attemptId, Boolean(attempt.finished_at));

  return c.json({
    attempt_id: attempt.id,
    score: attempt.score,
    total: attempt.total,
    finished_at: attempt.finished_at,
    items,
  });
});

// POST /api/exams/attempts/:attempt_id/finish
examsRouter.post('/attempts/:attempt_id/finish', requireAuth, async (c) => {
  const user = c.get('user')!;
  const attemptId = c.req.param('attempt_id');

  const attempt = await c.env.DB.prepare('SELECT * FROM exam_attempts WHERE id = ?')
    .bind(attemptId)
    .first();
  if (!attempt) {
    return c.json({ detail: 'محاولة الامتحان غير موجودة' }, 404);
  }
  if (attempt.user_id !== user.id) {
    if (user.role === 'admin') {
      return c.json({ detail: 'لا تملك صلاحية الوصول لهذه المحاولة' }, 403);
    }
    return c.json({ detail: 'محاولة الامتحان غير موجودة' }, 404);
  }
  if (attempt.finished_at) {
    return c.json({ detail: 'تم إنهاء الامتحان مسبقاً' }, 400);
  }

  const countRes = await c.env.DB.prepare(
    'SELECT COUNT(*) as c FROM exam_attempt_questions WHERE attempt_id = ? AND is_correct = 1'
  )
    .bind(attemptId)
    .first('c');
  const totalRes = await c.env.DB.prepare(
    'SELECT COUNT(*) as c FROM exam_attempt_questions WHERE attempt_id = ?'
  )
    .bind(attemptId)
    .first('c');

  const score = Number(countRes ?? 0);
  const total = Number(totalRes ?? 0);
  const percentage = total > 0 ? Math.round((score / total) * 100) : 0;
  const finishedAt = new Date().toISOString();

  // Atomically update attempt status
  const updateRes = await c.env.DB.prepare(
    'UPDATE exam_attempts SET score = ?, total = ?, finished_at = ? WHERE id = ? AND finished_at IS NULL'
  )
    .bind(score, total, finishedAt, attemptId)
    .run();

  if (!updateRes.meta.changes) {
    return c.json({ detail: 'تم إنهاء الامتحان مسبقاً' }, 400);
  }

  // Copy answered questions to student_answers for student analytics & profile stats
  const answers = await c.env.DB.prepare(
    'SELECT question_id, choice_id, is_correct FROM exam_attempt_questions WHERE attempt_id = ? AND choice_id IS NOT NULL'
  )
    .bind(attemptId)
    .all();

  if (answers.results && answers.results.length > 0) {
    const saStmts = (answers.results as any[]).map((a) => {
      const saId = 'sa_' + Math.random().toString(36).substring(2, 10);
      return c.env.DB.prepare(
        'INSERT INTO student_answers (id, user_id, question_id, choice_id, is_correct) VALUES (?, ?, ?, ?, ?)'
      ).bind(saId, user.id, a.question_id, a.choice_id, a.is_correct ? 1 : 0);
    });
    await c.env.DB.batch(saStmts);
  }

  return c.json({
    attempt_id: attemptId,
    score,
    total,
    percentage,
    finished_at: finishedAt,
  });
});

// POST /api/exams/attempts/:attempt_id/items/:item_id/answer
examsRouter.post('/attempts/:attempt_id/items/:item_id/answer', requireAuth, async (c) => {
  const user = c.get('user')!;
  const { attempt_id, item_id } = c.req.param();
  const body = await c.req.json<{ choice_id: string }>();

  const attempt = await c.env.DB.prepare('SELECT * FROM exam_attempts WHERE id = ?')
    .bind(attempt_id)
    .first();
  if (!attempt) {
    return c.json({ detail: 'محاولة الامتحان غير موجودة' }, 404);
  }
  if (attempt.user_id !== user.id) {
    return c.json({ detail: 'محاولة الامتحان غير موجودة' }, 404);
  }

  // Check deadline
  const exam = await c.env.DB.prepare('SELECT * FROM exams WHERE id = ?')
    .bind(attempt.exam_id)
    .first();
  if (exam) {
    const dl = deadline(exam, attempt);
    if (dl && new Date() > dl && !attempt.finished_at) {
      await autoFinishD1(c.env.DB, String(attempt.id), dl);
      return c.json({ detail: 'انتهى وقت الامتحان' }, 400);
    }
  }

  if (attempt.finished_at) {
    return c.json({ detail: 'تم إنهاء الامتحان بالفعل ولا يمكن تعديل الإجابات' }, 400);
  }

  const item = await c.env.DB.prepare(
    'SELECT * FROM exam_attempt_questions WHERE id = ? AND attempt_id = ?'
  )
    .bind(item_id, attempt_id)
    .first();
  if (!item) {
    return c.json({ detail: 'السؤال غير موجود بهذه المحاولة' }, 404);
  }

  const choice = await c.env.DB.prepare(
    'SELECT * FROM choices WHERE id = ? AND question_id = ?'
  )
    .bind(body.choice_id, item.question_id)
    .first();
  if (!choice) {
    return c.json({ detail: 'الخيار المحدد لا ينتمي لهذا السؤال' }, 400);
  }

  const isCorrect = Boolean(choice.is_correct);

  await c.env.DB.prepare(
    'UPDATE exam_attempt_questions SET choice_id = ?, is_correct = ?, answered_at = ? WHERE id = ?'
  )
    .bind(choice.id, isCorrect ? 1 : 0, new Date().toISOString(), item_id)
    .run();

  return c.json({ message: 'تم حفظ الإجابة بنجاح', ok: true, recorded: true });
});

// Common handler for answering by question_id or item_id
const handleAttemptAnswer = async (c: Context<AppEnv>) => {
  const user = c.get('user')!;
  const attempt_id = c.req.param('attempt_id') ?? '';
  if (!attempt_id) return c.json({ detail: 'المحاولة غير موجودة' }, 404);

  const body = await c.req.json<any>().catch(() => ({}));

  let choiceId = body?.choice_id;
  if (!choiceId && body?.selected_option !== undefined && body?.question_id) {
    const chs = await c.env.DB.prepare(
      'SELECT id FROM choices WHERE question_id = ? ORDER BY order_index ASC'
    )
      .bind(body.question_id)
      .all();
    const selected = (chs.results ?? [])[Number(body.selected_option)];
    if (selected) {
      choiceId = (selected as any).id;
    }
  }

  if (!body || (!body.question_id && !body.item_id) || !choiceId) {
    return c.json({ detail: 'رقم السؤال ورقم الخيار مطلوبان' }, 400);
  }

  const attempt = await c.env.DB.prepare('SELECT * FROM exam_attempts WHERE id = ?')
    .bind(attempt_id)
    .first();
  if (!attempt) {
    return c.json({ detail: 'محاولة الامتحان غير موجودة' }, 404);
  }
  if (attempt.user_id !== user.id) {
    return c.json({ detail: 'لا تملك صلاحية الوصول لهذه المحاولة' }, 403);
  }

  // Check deadline FIRST
  const exam = await c.env.DB.prepare('SELECT * FROM exams WHERE id = ?')
    .bind(attempt.exam_id)
    .first();
  if (exam) {
    const dl = deadline(exam, attempt);
    if (dl && new Date() > dl && !attempt.finished_at) {
      await autoFinishD1(c.env.DB, String(attempt.id), dl);
      return c.json({ detail: 'انتهى وقت الامتحان' }, 400);
    }
  }

  if (attempt.finished_at) {
    return c.json({ detail: 'تم إنهاء الامتحان بالفعل ولا يمكن تعديل الإجابات' }, 400);
  }

  let item: any;
  if (body.question_id) {
    item = await c.env.DB.prepare(
      'SELECT * FROM exam_attempt_questions WHERE attempt_id = ? AND question_id = ?'
    )
      .bind(attempt_id, body.question_id)
      .first();
  }
  if (!item && body.item_id) {
    item = await c.env.DB.prepare(
      'SELECT * FROM exam_attempt_questions WHERE attempt_id = ? AND id = ?'
    )
      .bind(attempt_id, body.item_id)
      .first();
  }

  if (!item) {
    return c.json({ detail: 'السؤال غير موجود بهذه المحاولة' }, 404);
  }

  const choice = await c.env.DB.prepare(
    'SELECT * FROM choices WHERE id = ? AND question_id = ?'
  )
    .bind(choiceId, item.question_id)
    .first();
  if (!choice) {
    return c.json({ detail: 'الخيار المحدد لا ينتمي لهذا السؤال' }, 400);
  }

  const isCorrect = Boolean(choice.is_correct);

  await c.env.DB.prepare(
    'UPDATE exam_attempt_questions SET choice_id = ?, is_correct = ?, answered_at = ? WHERE id = ?'
  )
    .bind(choice.id, isCorrect ? 1 : 0, new Date().toISOString(), item.id)
    .run();

  return c.json({ message: 'تم حفظ الإجابة بنجاح', recorded: true, ok: true });
};

examsRouter.post('/attempts/:attempt_id/answer', requireAuth, handleAttemptAnswer);
examsRouter.post('/attempts/:attempt_id/answers', requireAuth, handleAttemptAnswer);

// ─────────────────────────────────────────────────────────────────────────────
// Exam Start & Details Routes
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/exams/:exam_id/start
examsRouter.post('/:exam_id/start', requireAuth, async (c) => {
  const user = c.get('user')!;
  const examId = c.req.param('exam_id');

  const exam = await c.env.DB.prepare(
    'SELECT * FROM exams WHERE id = ?'
  )
    .bind(examId)
    .first();
  if (!exam) return c.json({ detail: 'الامتحان غير موجود' }, 404);

  // Check for existing open attempt
  let attempt = await c.env.DB.prepare(
    'SELECT * FROM exam_attempts WHERE exam_id = ? AND user_id = ? AND finished_at IS NULL'
  )
    .bind(examId, user.id)
    .first();

  if (attempt) {
    const dl = deadline(exam, attempt);
    if (dl && new Date() > dl) {
      await autoFinishD1(c.env.DB, String(attempt.id), dl);
      attempt = null;
    }
  }

  if (!attempt) {
    // Pick questions from subject pool
    const poolRes = await c.env.DB.prepare(
      'SELECT * FROM questions WHERE subject_id = ?'
    )
      .bind(exam.subject_id ?? '')
      .all();

    const pool = (poolRes.results ?? []) as any[];
    if (pool.length === 0) {
      return c.json({ detail: 'لا توجد أسئلة متاحة لهذا الامتحان بعد' }, 400);
    }

    // Shuffle pool
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const count = Number((exam as any).question_count || pool.length);
    const chosen = pool.slice(0, count);

    const attemptId = 'att_' + Math.random().toString(36).substring(2, 10);
    const now = new Date().toISOString();

    const attemptStmt = c.env.DB.prepare(
      'INSERT INTO exam_attempts (id, exam_id, user_id, started_at, total, score) VALUES (?, ?, ?, ?, ?, 0)'
    ).bind(attemptId, examId, user.id, now, chosen.length);

    const itemStmts = chosen.map((q: any, idx: number) => {
      const eaqId = 'eaq_' + Math.random().toString(36).substring(2, 10);
      return c.env.DB.prepare(
        'INSERT INTO exam_attempt_questions (id, attempt_id, question_id, order_index) VALUES (?, ?, ?, ?)'
      ).bind(eaqId, attemptId, q.id, idx);
    });

    // Execute atomic batch creation
    await c.env.DB.batch([attemptStmt, ...itemStmts]);

    attempt = await c.env.DB.prepare('SELECT * FROM exam_attempts WHERE id = ?')
      .bind(attemptId)
      .first();
  }

  if (!attempt) return c.json({ detail: 'خطأ في إنشاء المحاولة' }, 500);

  const items = await getItemsOut(c.env.DB, String(attempt.id), false);
  const dl = deadline(exam, attempt);

  return c.json({
    attempt_id: attempt.id,
    exam_id: exam.id,
    exam_title: exam.title,
    expires_at: dl,
    duration_minutes: exam.duration_minutes,
    total: attempt.total,
    total_questions: attempt.total,
    started_at: attempt.started_at,
    finished_at: attempt.finished_at,
    questions: items,
  });
});

// GET /api/exams/:id/leaderboard
examsRouter.get('/:id/leaderboard', async (c) => {
  const examId = c.req.param('id');
  const res = await c.env.DB.prepare(`
    SELECT ea.id, ea.user_id, u.full_name, ea.score, ea.total, ea.finished_at
    FROM exam_attempts ea
    JOIN users u ON ea.user_id = u.id
    WHERE ea.exam_id = ? AND ea.finished_at IS NOT NULL
    ORDER BY ea.score DESC, ea.finished_at ASC
    LIMIT 50
  `)
    .bind(examId)
    .all();

  const ranked = ((res.results ?? []) as any[]).map((r, i) => ({ ...r, rank: i + 1 }));
  return c.json(ranked);
});

// GET /api/exams/:id
examsRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const exam = await c.env.DB.prepare(
    'SELECT * FROM exams WHERE id = ?'
  )
    .bind(id)
    .first();
  if (!exam) return c.json({ detail: 'الامتحان غير موجود' }, 404);
  return c.json(exam);
});
