/**
 * Students routes — mirrors Python app/routers/students.py
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, inArray, like, and, desc, lte } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { requireAuth } from '../middleware/auth';
import { peerIds, rankedPairs, rankOf, streakDays, accuracyPct } from '../services/ranking';

export const studentsRouter = new Hono<AppEnv>();

// GET /api/students/leaderboard — public
studentsRouter.get('/leaderboard', async (c) => {
  const res = await c.env.DB.prepare(`
    SELECT u.id, u.full_name, COUNT(sa.id) as answers_count, SUM(sa.is_correct) as score
    FROM users u
    LEFT JOIN student_answers sa ON u.id = sa.user_id
    WHERE u.role = 'student'
    GROUP BY u.id
    ORDER BY score DESC
    LIMIT 20
  `).all();
  const ranked = ((res.results ?? []) as any[]).map((r, i) => ({ ...r, rank: i + 1 }));
  return c.json(ranked);
});

studentsRouter.use('*', requireAuth);

// GET /api/students — search with pagination and privacy protection
studentsRouter.get('/', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const currentUser = c.get('user')!;
  const q = (c.req.query('q') ?? '').trim();
  const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') ?? '20')), 50);
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0'));

  let all = await db
    .select({
      id: schema.users.id,
      full_name: schema.users.full_name,
      email: schema.users.email,
      photo_url: schema.users.photo_url,
      university_id: schema.users.university_id,
      stage_id: schema.users.stage_id,
    })
    .from(schema.users)
    .where(eq(schema.users.role, 'student'));

  const isPrivileged = currentUser.role === 'admin' || currentUser.role === 'professor';

  if (q) {
    const qLower = q.toLowerCase();
    all = all.filter((s) =>
      s.full_name.toLowerCase().includes(qLower) ||
      (isPrivileged && s.email.toLowerCase().includes(qLower))
    );
  }

  const paged = all.slice(offset, offset + limit);

  return c.json(paged.map((s) => ({
    id: s.id,
    full_name: s.full_name,
    email: isPrivileged ? s.email : undefined,
    photo_url: s.photo_url,
    university_id: s.university_id,
    stage_id: s.stage_id,
  })));
});

// GET /api/students/profile (current user)
studentsRouter.get('/profile', async (c) => {
  const user = c.get('user')!;
  const skills = await c.env.DB.prepare('SELECT * FROM user_skills WHERE user_id = ?').bind(user.id).all();
  return c.json({
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    skills: skills.results ?? [],
  });
});

// GET /api/students/stats (current user stats)
studentsRouter.get('/stats', async (c) => {
  const user = c.get('user')!;
  const count = await c.env.DB.prepare('SELECT COUNT(*) as c FROM student_answers WHERE user_id = ?').bind(user.id).first('c');
  const correct = await c.env.DB.prepare('SELECT COUNT(*) as c FROM student_answers WHERE user_id = ? AND is_correct = 1').bind(user.id).first('c');
  const numCount = Number(count ?? 0);
  const numCorrect = Number(correct ?? 0);
  return c.json({
    answered_count: numCount,
    correct_count: numCorrect,
    accuracy: numCount > 0 ? Math.round((numCorrect / numCount) * 100) : 0,
    streak_days: 3,
  });
});

// GET /api/students/skills
studentsRouter.get('/skills', async (c) => {
  const user = c.get('user')!;
  const skills = await c.env.DB.prepare('SELECT * FROM user_skills WHERE user_id = ?').bind(user.id).all();
  return c.json(skills.results ?? []);
});

// POST /api/students/skills
studentsRouter.post('/skills', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json<{ text?: string }>().catch(() => ({ text: undefined }));
  if (!body || !body.text || !body.text.trim()) return c.json({ detail: 'نص المهارة مطلوب' }, 400);

  const sId = 'skl_' + Math.random().toString(36).substring(2, 10);
  await c.env.DB.prepare('INSERT INTO user_skills (id, user_id, text) VALUES (?, ?, ?)')
    .bind(sId, user.id, body.text.trim()).run();
  return c.json({ id: sId, text: body.text.trim() });
});

// DELETE /api/students/skills/:id
studentsRouter.delete('/skills/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user')!;
  await c.env.DB.prepare('DELETE FROM user_skills WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  return c.json({ message: 'تم حذف المهارة' });
});

// GET /api/students/study-tracker
studentsRouter.get('/study-tracker', async (c) => {
  return c.json({ total_minutes: 120, sessions: [] });
});

// POST /api/students/study-tracker
studentsRouter.post('/study-tracker', async (c) => {
  const body = await c.req.json<{ duration_minutes?: number }>().catch(() => ({ duration_minutes: undefined }));
  if (!body || !body.duration_minutes) return c.json({ detail: 'مدة الدراسة مطلوبة' }, 400);
  return c.json({ message: 'تم تسجيل وقت الدراسة', recorded_minutes: body.duration_minutes });
});

// GET /api/students/lecture-progress
studentsRouter.get('/lecture-progress', async (c) => {
  const user = c.get('user')!;
  const res = await c.env.DB.prepare('SELECT * FROM lecture_progress WHERE user_id = ?').bind(user.id).all();
  return c.json(res.results ?? []);
});

// POST /api/students/lecture-progress
studentsRouter.post('/lecture-progress', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json<{ lecture_id?: string }>().catch(() => ({ lecture_id: undefined }));
  if (!body || !body.lecture_id) return c.json({ detail: 'رقم المحاضرة مطلوب' }, 400);

  const lpId = 'lp_' + Math.random().toString(36).substring(2, 10);
  await c.env.DB.prepare('INSERT OR IGNORE INTO lecture_progress (id, user_id, lecture_id) VALUES (?, ?, ?)')
    .bind(lpId, user.id, body.lecture_id).run();
  return c.json({ message: 'تم تسجيل إكمال المحاضرة', lecture_id: body.lecture_id });
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

// ─────────────────────── Academic Change Requests (B1) ───────────────────────
studentsRouter.post('/academic-change-request', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const body = await c.req.json<{
    target_university_id: string;
    target_stage_id: string;
    target_section_id?: string;
    reason: string;
  }>();

  if (!body.target_university_id || !body.target_stage_id || !body.reason?.trim()) {
    return c.json({ detail: 'الجامعة والمرحلة والسبب حقول مطلوبة' }, 400);
  }
  if (body.reason.trim().length < 5) {
    return c.json({ detail: 'سبب الطلب يجب ألا يقل عن 5 أحرف' }, 400);
  }

  const uni = await db.select().from(schema.universities).where(eq(schema.universities.id, body.target_university_id)).get();
  if (!uni) return c.json({ detail: 'الجامعة المستهدفة غير موجودة' }, 404);

  const stage = await db.select().from(schema.stages).where(eq(schema.stages.id, body.target_stage_id)).get();
  if (!stage) return c.json({ detail: 'المرحلة المستهدفة غير موجودة' }, 404);

  const pending = await db.select().from(schema.academicChangeRequests).where(
    and(
      eq(schema.academicChangeRequests.user_id, user.id),
      eq(schema.academicChangeRequests.status, 'pending')
    )
  ).get();
  if (pending) {
    return c.json({ detail: 'لديك طلب تغيير معلّق بالفعل، بانتظار مراجعة الإدارة' }, 409);
  }

  const currentUser = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
  const id = schema.genId();

  await db.insert(schema.academicChangeRequests).values({
    id,
    user_id: user.id,
    current_university_id: currentUser?.university_id ?? null,
    current_stage_id: currentUser?.stage_id ?? null,
    target_university_id: body.target_university_id,
    target_stage_id: body.target_stage_id,
    target_section_id: body.target_section_id ?? null,
    reason: body.reason.trim(),
    status: 'pending',
  });

  return c.json({ ok: true, request_id: id, status: 'pending' });
});

studentsRouter.get('/academic-change-request', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;

  const requests = await db.select().from(schema.academicChangeRequests)
    .where(eq(schema.academicChangeRequests.user_id, user.id))
    .orderBy(desc(schema.academicChangeRequests.created_at));

  const unis = await db.select().from(schema.universities);
  const uniMap = new Map(unis.map((u) => [u.id, u.name]));
  const stages = await db.select().from(schema.stages);
  const stageMap = new Map(stages.map((s) => [s.id, s.name]));

  return c.json(requests.map((r) => ({
    id: r.id,
    current_university: r.current_university_id ? (uniMap.get(r.current_university_id) ?? '—') : '—',
    current_stage: r.current_stage_id ? (stageMap.get(r.current_stage_id) ?? '—') : '—',
    target_university: r.target_university_id ? (uniMap.get(r.target_university_id) ?? r.target_university_id) : '—',
    target_stage: r.target_stage_id ? (stageMap.get(r.target_stage_id) ?? r.target_stage_id) : '—',
    reason: r.reason,
    status: r.status,
    reviewer_notes: r.reviewer_notes,
    reviewed_at: r.reviewed_at,
    created_at: r.created_at,
  })));
});

// ─────────────────────── Student Learning Hub (B3) ───────────────────────────
studentsRouter.get('/learning-hub', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;

  const now = new Date().toISOString();
  const dueReviews = await db.select().from(schema.studentReviews).where(
    and(
      eq(schema.studentReviews.user_id, user.id),
      lte(schema.studentReviews.next_review_at, now)
    )
  );

  const answers = await db.select().from(schema.studentAnswers).where(eq(schema.studentAnswers.user_id, user.id));

  const subjectCorrect: Record<string, { total: number; correct: number }> = {};
  for (const a of answers) {
    const q = await db.select({ subject_id: schema.questions.subject_id }).from(schema.questions).where(eq(schema.questions.id, a.question_id)).get();
    if (q?.subject_id) {
      subjectCorrect[q.subject_id] ??= { total: 0, correct: 0 };
      subjectCorrect[q.subject_id].total++;
      if (a.is_correct) subjectCorrect[q.subject_id].correct++;
    }
  }

  const subjects = await db.select().from(schema.subjects).where(eq(schema.subjects.is_deleted, false));
  const subjectMap = new Map(subjects.map((s) => [s.id, s.name]));

  const weakTopics = Object.entries(subjectCorrect)
    .map(([subjId, data]) => ({
      subject_id: subjId,
      subject_name: subjectMap.get(subjId) ?? '—',
      total_answers: data.total,
      accuracy: data.total > 0 ? Math.round((data.correct / data.total) * 100) : 0,
    }))
    .filter((t) => t.total_answers >= 3 && t.accuracy < 60);

  const streak = await streakDays(db, user.id);
  const accuracy = await accuracyPct(db, user.id);

  return c.json({
    review_due_count: dueReviews.length,
    total_answered: answers.length,
    accuracy_pct: accuracy,
    streak_days: streak,
    weak_topics: weakTopics,
  });
});

// ─────────────────────── Smart Review / Spaced Repetition (B4) ───────────────
studentsRouter.get('/smart-review', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20'), 50);

  const now = new Date().toISOString();
  const dueReviews = await db.select().from(schema.studentReviews).where(
    and(
      eq(schema.studentReviews.user_id, user.id),
      lte(schema.studentReviews.next_review_at, now)
    )
  ).limit(limit);

  let questionIds = dueReviews.map((r) => r.question_id);

  if (questionIds.length < limit) {
    const wrongAnswers = await db.select().from(schema.studentAnswers).where(
      and(
        eq(schema.studentAnswers.user_id, user.id),
        eq(schema.studentAnswers.is_correct, false)
      )
    ).orderBy(desc(schema.studentAnswers.answered_at)).limit(limit * 2);

    for (const ans of wrongAnswers) {
      if (!questionIds.includes(ans.question_id)) {
        questionIds.push(ans.question_id);
        if (questionIds.length >= limit) break;
      }
    }
  }

  if (!questionIds.length) {
    return c.json({ count: 0, items: [], message: 'لا توجد أسئلة مستحقة للمراجعة حالياً' });
  }

  const qs = await db.select().from(schema.questions).where(
    and(
      inArray(schema.questions.id, questionIds),
      eq(schema.questions.is_deleted, false)
    )
  );

  const items = await Promise.all(qs.map(async (q) => {
    const chs = await db.select().from(schema.choices).where(eq(schema.choices.question_id, q.id));
    const sanitizedChoices = chs.map((ch) => ({ id: ch.id, text: ch.text }));
    return {
      id: q.id,
      text: q.text,
      eyebrow: q.eyebrow,
      image_url: q.image_url,
      choices: sanitizedChoices,
    };
  }));

  return c.json({ count: items.length, items });
});

studentsRouter.post('/smart-review/record', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const body = await c.req.json<{ question_id: string; score: number }>();

  if (!body.question_id || typeof body.score !== 'number') {
    return c.json({ detail: 'question_id و score مطلوبان' }, 400);
  }

  const score = Math.max(0, Math.min(5, Math.round(body.score)));

  const existing = await db.select().from(schema.studentReviews).where(
    and(
      eq(schema.studentReviews.user_id, user.id),
      eq(schema.studentReviews.question_id, body.question_id)
    )
  ).get();

  let easeFactor = existing ? parseFloat(existing.ease_factor) || 2.5 : 2.5;
  let intervalDays = existing ? existing.interval_days : 1;
  let repetitionCount = existing ? existing.repetition_count : 0;

  // SM-2 Algorithm
  if (score >= 3) {
    repetitionCount++;
    if (repetitionCount === 1) {
      intervalDays = 1;
    } else if (repetitionCount === 2) {
      intervalDays = 6;
    } else {
      intervalDays = Math.max(1, Math.round(intervalDays * easeFactor));
    }
    easeFactor = Math.max(1.3, easeFactor + (0.1 - (5 - score) * (0.08 + (5 - score) * 0.02)));
  } else {
    repetitionCount = 0;
    intervalDays = 1;
  }

  const now = new Date();
  const nextReviewDate = new Date(now.getTime() + intervalDays * 86400000);
  const nextReviewAt = nextReviewDate.toISOString();
  const lastReviewedAt = now.toISOString();

  if (existing) {
    await db.update(schema.studentReviews).set({
      ease_factor: easeFactor.toFixed(2),
      interval_days: intervalDays,
      repetition_count: repetitionCount,
      next_review_at: nextReviewAt,
      last_reviewed_at: lastReviewedAt,
      last_score: score,
    }).where(eq(schema.studentReviews.id, existing.id));
  } else {
    await db.insert(schema.studentReviews).values({
      id: schema.genId(),
      user_id: user.id,
      question_id: body.question_id,
      ease_factor: easeFactor.toFixed(2),
      interval_days: intervalDays,
      repetition_count: repetitionCount,
      next_review_at: nextReviewAt,
      last_reviewed_at: lastReviewedAt,
      last_score: score,
    });
  }

  return c.json({
    ok: true,
    score,
    repetition_count: repetitionCount,
    interval_days: intervalDays,
    next_review_at: nextReviewAt,
    ease_factor: easeFactor.toFixed(2),
  });
});

// ─────────────────────── Rich Student Profile Dashboard (B5) ─────────────────
studentsRouter.get('/me/dashboard', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;

  const fullUser = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
  if (!fullUser) return c.json({ detail: 'المستخدم غير موجود' }, 404);

  const uni = fullUser.university_id ? await db.select().from(schema.universities).where(eq(schema.universities.id, fullUser.university_id)).get() : null;
  const stage = fullUser.stage_id ? await db.select().from(schema.stages).where(eq(schema.stages.id, fullUser.stage_id)).get() : null;

  const attempts = await db.select().from(schema.examAttempts).where(eq(schema.examAttempts.user_id, user.id)).orderBy(desc(schema.examAttempts.started_at)).limit(5);

  const exams = await db.select().from(schema.exams);
  const examMap = new Map(exams.map((e) => [e.id, e.title]));

  const recentAttempts = attempts.map((att) => ({
    id: att.id,
    exam_id: att.exam_id,
    exam_title: examMap.get(att.exam_id) ?? '—',
    score: att.score,
    total: att.total,
    score_pct: att.total > 0 ? Math.round((att.score / att.total) * 100) : 0,
    finished_at: att.finished_at,
  }));

  const answers = await db.select().from(schema.studentAnswers).where(eq(schema.studentAnswers.user_id, user.id));
  const correctAnswers = answers.filter((a) => a.is_correct).length;

  const peers = await peerIds(db, user.id, fullUser.university_id ?? null);
  const ranked = await rankedPairs(db, peers);

  const certificatesList = await db.select().from(schema.certificates).where(
    and(
      eq(schema.certificates.user_id, user.id),
      eq(schema.certificates.is_revoked, false)
    )
  );

  const pendingRequest = await db.select().from(schema.academicChangeRequests).where(
    and(
      eq(schema.academicChangeRequests.user_id, user.id),
      eq(schema.academicChangeRequests.status, 'pending')
    )
  ).get();

  const now = new Date().toISOString();
  const dueReviewsCount = (await db.select({ id: schema.studentReviews.id }).from(schema.studentReviews).where(
    and(
      eq(schema.studentReviews.user_id, user.id),
      lte(schema.studentReviews.next_review_at, now)
    )
  )).length;

  return c.json({
    profile: {
      id: fullUser.id,
      full_name: fullUser.full_name,
      email: fullUser.email,
      photo_url: fullUser.photo_url,
      university_name: uni?.name ?? null,
      stage_name: stage?.name ?? null,
      role: fullUser.role,
    },
    performance: {
      total_answered: answers.length,
      correct_count: correctAnswers,
      accuracy_pct: await accuracyPct(db, user.id),
      streak_days: await streakDays(db, user.id),
      rank: rankOf(ranked, user.id),
      total_ranked: ranked.length,
    },
    recent_attempts: recentAttempts,
    certificates: certificatesList.map((cert) => ({
      code: cert.certificate_code,
      exam_title: cert.exam_title,
      score_percentage: cert.score_percentage,
      issued_at: cert.issued_at,
    })),
    smart_review_due_count: dueReviewsCount,
    pending_academic_change: pendingRequest ? {
      id: pendingRequest.id,
      reason: pendingRequest.reason,
      created_at: pendingRequest.created_at,
    } : null,
  });
});

// ─────────────────────── Verifiable Certificates Issuance (B6) ──────────────
studentsRouter.post('/exams/:id/certificate', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const examId = c.req.param('id');

  const exam = await db.select().from(schema.exams).where(eq(schema.exams.id, examId)).get();
  if (!exam) return c.json({ detail: 'الامتحان غير موجود' }, 404);

  // Verify student has completed the exam with score >= 50%
  const attempts = await db.select().from(schema.examAttempts).where(
    and(
      eq(schema.examAttempts.exam_id, examId),
      eq(schema.examAttempts.user_id, user.id)
    )
  );

  const bestAttempt = attempts
    .filter((a) => a.finished_at && a.total > 0)
    .sort((a, b) => (b.score / b.total) - (a.score / a.total))[0];

  if (!bestAttempt) {
    return c.json({ detail: 'يجب إكمال الامتحان أولاً للحصول على الشهادة' }, 400);
  }

  const scorePct = Math.round((bestAttempt.score / bestAttempt.total) * 100);
  if (scorePct < 50) {
    return c.json({ detail: `درجتك (${scorePct}%) أقل من الحد الأدنى للنجاح (50%)` }, 400);
  }

  // Check if certificate already exists
  const existing = await db.select().from(schema.certificates).where(
    and(
      eq(schema.certificates.user_id, user.id),
      eq(schema.certificates.exam_id, examId)
    )
  ).get();

  if (existing) {
    return c.json(existing);
  }

  const studentUser = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const certCode = `CERT-${hex.slice(0, 4)}-${hex.slice(4, 8)}`;

  const certId = schema.genId();
  await db.insert(schema.certificates).values({
    id: certId,
    user_id: user.id,
    exam_id: examId,
    certificate_code: certCode,
    student_name: studentUser?.full_name ?? 'طالب منصة نبض',
    exam_title: exam.title,
    score_percentage: scorePct,
    is_revoked: false,
  });

  const createdCert = await db.select().from(schema.certificates).where(eq(schema.certificates.id, certId)).get();
  return c.json(createdCert);
});
