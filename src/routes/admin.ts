/**
 * Admin routes — mirrors Python app/routers/admin.py (1209 lines)
 * All endpoints behind admin-only guard.
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, inArray, desc, and } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { hashPassword } from '../services/crypto';
import { createStorageService, safeUploadName, mediaUrl, IMAGE_EXTS, PDF_EXTS, VIDEO_EXTS, MAX_UPLOAD_BYTES, validateFileSignature } from '../services/storage';
import { recordAuditEvent } from '../services/audit';

export const adminRouter = new Hono<AppEnv>();
adminRouter.use('*', requireAdmin);

const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
const ALL_EXTS = [...IMAGE_EXTS, ...PDF_EXTS, ...VIDEO_EXTS];
const VALID_ROLES = new Set(['student', 'professor', 'reseller', 'admin']);

// Helper: daily counts for last N days
function dailyCounts(items: { date_col: string | null }[], days = 7): Array<{ date: string; count: number }> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    if (!item.date_col) continue;
    const key = String(item.date_col).slice(0, 10);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const result = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    result.push({ date: key, count: counts[key] ?? 0 });
  }
  return result;
}

// ─────────────────────── Overview ────────────────────────────────────────────
adminRouter.get('/overview', async (c) => {
  const db = drizzle(c.env.DB, { schema });

  const students = await db.select().from(schema.users).where(eq(schema.users.role, 'student'));
  const activeCodes = await db.select().from(schema.activationCodes).where(eq(schema.activationCodes.status, 'active'));
  const pendingBans = await db.select().from(schema.banRecords).where(eq(schema.banRecords.status, 'active'));
  const allOrders = await db.select().from(schema.orders).where(inArray(schema.orders.status, ['paid', 'fulfilled']));
  const revenueTotal = allOrders.reduce((s, o) => s + (o.total ?? 0), 0);

  const allAnswers = await db.select({ date_col: schema.studentAnswers.answered_at }).from(schema.studentAnswers);
  const weeklyActivity = dailyCounts(allAnswers);

  return c.json({
    total_students: students.length,
    active_activations: activeCodes.length,
    pending_bans: pendingBans.length,
    revenue_total: revenueTotal,
    weekly_activity: weeklyActivity,
  });
});

// ─────────────────────── Users CRUD ─────────────────────────────────────────
adminRouter.get('/users', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const role = c.req.query('role');
  const users = await db.select().from(schema.users);
  const filtered = role ? users.filter((u) => u.role === role) : users;
  return c.json(filtered.map((u) => ({
    id: u.id, email: u.email, full_name: u.full_name, role: u.role,
    photo_url: u.photo_url, is_banned: u.is_banned, created_at: u.created_at,
  })));
});

adminRouter.post('/users', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{ email: string; full_name: string; role: string; password?: string; subject_id?: string; title?: string }>();

  if (!VALID_ROLES.has(body.role)) return c.json({ detail: 'دور غير صالح' }, 400);
  const existing = await db.select().from(schema.users).where(eq(schema.users.email, body.email.trim())).get();
  if (existing) return c.json({ detail: 'البريد الإلكتروني مستخدم مسبقاً' }, 400);

  if (body.role === 'professor') {
    if (!body.subject_id) return c.json({ detail: 'اختر المادة التي يدرّسها الدكتور' }, 400);
    const subject = await db.select().from(schema.subjects).where(eq(schema.subjects.id, body.subject_id)).get();
    if (!subject) return c.json({ detail: 'المادة غير موجودة' }, 404);
  }

  const userId = schema.genId();
  await db.insert(schema.users).values({
    id: userId,
    email: body.email.trim(),
    full_name: body.full_name.trim(),
    role: body.role as 'student' | 'professor' | 'admin' | 'reseller',
    password_hash: body.password ? await hashPassword(body.password) : null,
  });

  if (body.role === 'professor') {
    await db.insert(schema.professorProfiles).values({
      id: schema.genId(),
      user_id: userId,
      subject_id: body.subject_id!,
      title: body.title?.trim() || 'أستاذ مساعد',
    });
  }

  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  return c.json(user);
});

adminRouter.put('/users/:user_id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.req.param('user_id');
  const body = await c.req.json<{ email: string; full_name: string; role: string; password?: string }>();

  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) return c.json({ detail: 'المستخدم غير موجود' }, 404);
  if (!VALID_ROLES.has(body.role)) return c.json({ detail: 'دور غير صالح' }, 400);

  const dup = await db.select().from(schema.users).where(eq(schema.users.email, body.email.trim())).get();
  if (dup && dup.id !== userId) return c.json({ detail: 'البريد الإلكتروني مستخدم مسبقاً من حساب آخر' }, 400);

  const updates: Record<string, unknown> = { email: body.email.trim(), full_name: body.full_name.trim(), role: body.role };
  if (body.password) updates.password_hash = await hashPassword(body.password);
  await db.update(schema.users).set(updates).where(eq(schema.users.id, userId));

  recordAuditEvent({
    event: 'ADMIN_ROLE_CHANGED',
    status: 'SUCCESS',
    actorId: c.get('user')?.id,
    targetId: userId,
    details: { oldRole: user.role, newRole: body.role, email: body.email },
  });

  return c.json(await db.select().from(schema.users).where(eq(schema.users.id, userId)).get());
});

// ─────────────────────── Professors management ───────────────────────────────
adminRouter.get('/professors', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const profUsers = await db.select().from(schema.users).where(eq(schema.users.role, 'professor'));
  const profiles = await db.select().from(schema.professorProfiles);
  const profileByUser: Record<string, typeof profiles[0]> = {};
  profiles.forEach((p) => { profileByUser[p.user_id] = p; });

  const out = await Promise.all(profUsers.map(async (user) => {
    const p = profileByUser[user.id];
    let subjectName = null;
    if (p?.subject_id) {
      const sub = await db.select().from(schema.subjects).where(eq(schema.subjects.id, p.subject_id)).get();
      subjectName = sub?.name ?? null;
    }
    return {
      user_id: user.id, full_name: user.full_name, email: user.email,
      profile_id: p?.id ?? null, subject_id: p?.subject_id ?? null, subject_name: subjectName, title: p?.title ?? null,
    };
  }));
  return c.json(out);
});

adminRouter.put('/professors/:user_id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.req.param('user_id');
  const body = await c.req.json<{ subject_id: string; title?: string }>();

  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) return c.json({ detail: 'المستخدم غير موجود' }, 404);
  if (user.role !== 'professor') return c.json({ detail: 'هذا الحساب ليس حساب دكتور' }, 400);

  const subject = await db.select().from(schema.subjects).where(eq(schema.subjects.id, body.subject_id)).get();
  if (!subject) return c.json({ detail: 'المادة غير موجودة' }, 404);

  const existing = await db.select().from(schema.professorProfiles).where(eq(schema.professorProfiles.user_id, userId)).get();
  if (existing) {
    await db.update(schema.professorProfiles).set({
      subject_id: body.subject_id,
      title: body.title?.trim() || existing.title,
    }).where(eq(schema.professorProfiles.id, existing.id));
    return c.json({ profile_id: existing.id, subject_id: body.subject_id, title: body.title || existing.title });
  } else {
    const id = schema.genId();
    await db.insert(schema.professorProfiles).values({
      id, user_id: userId, subject_id: body.subject_id, title: body.title?.trim() || 'أستاذ مساعد',
    });
    return c.json({ profile_id: id, subject_id: body.subject_id, title: body.title || 'أستاذ مساعد' });
  }
});

// ─────────────────────── Reseller code management ────────────────────────────
adminRouter.post('/resellers/:reseller_id/codes', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const resellerId = c.req.param('reseller_id');
  const count = parseInt(c.req.query('count') ?? '1');
  const subjectId = c.req.query('subject_id') ?? null;

  const reseller = await db.select().from(schema.users).where(eq(schema.users.id, resellerId)).get();
  if (!reseller || reseller.role !== 'reseller') return c.json({ detail: 'المندوب غير موجود' }, 404);
  if (count < 1 || count > 100) return c.json({ detail: 'العدد يجب أن يكون بين 1 و100' }, 400);
  if (subjectId) {
    const sub = await db.select().from(schema.subjects).where(eq(schema.subjects.id, subjectId)).get();
    if (!sub) return c.json({ detail: 'المادة غير موجودة' }, 404);
  }

  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(3))).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const code = `NBD-${hex}`;
    await db.insert(schema.activationCodes).values({ id: schema.genId(), code, subject_id: subjectId, status: 'idle', reseller_id: resellerId });
    codes.push(code);
  }
  return c.json({ codes });
});

adminRouter.get('/resellers/:reseller_id/codes', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const resellerId = c.req.param('reseller_id');
  const reseller = await db.select().from(schema.users).where(eq(schema.users.id, resellerId)).get();
  if (!reseller || reseller.role !== 'reseller') return c.json({ detail: 'المندوب غير موجود' }, 404);

  const codes = await db.select().from(schema.activationCodes).where(eq(schema.activationCodes.reseller_id, resellerId));
  const result = await Promise.all(codes.map(async (code) => {
    let subjectName = 'VIP — جميع المواد';
    if (code.subject_id) {
      const sub = await db.select().from(schema.subjects).where(eq(schema.subjects.id, code.subject_id)).get();
      if (sub) subjectName = sub.name;
    }
    return { id: code.id, code: code.code, status: code.status, subject_name: subjectName, sold_at: code.sold_at };
  }));
  return c.json(result);
});

// ─────────────────────── Ban management ──────────────────────────────────────
adminRouter.post('/users/:user_id/ban', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.req.param('user_id');
  const reason = c.req.query('reason') ?? '';

  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) return c.json({ detail: 'المستخدم غير موجود' }, 404);

  await db.update(schema.users).set({ is_banned: true }).where(eq(schema.users.id, userId));
  await db.insert(schema.banRecords).values({ id: schema.genId(), user_id: userId, reason, status: 'active' });

  recordAuditEvent({
    event: 'ADMIN_USER_BANNED',
    status: 'SUCCESS',
    actorId: c.get('user')?.id,
    targetId: userId,
    details: { reason },
  });

  return c.json({ ok: true });
});

adminRouter.post('/users/:user_id/unban', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.req.param('user_id');

  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) return c.json({ detail: 'المستخدم غير موجود' }, 404);

  await db.update(schema.users).set({ is_banned: false }).where(eq(schema.users.id, userId));
  await db.update(schema.banRecords).set({ status: 'lifted' })
    .where(and(eq(schema.banRecords.user_id, userId), eq(schema.banRecords.status, 'active')));

  recordAuditEvent({
    event: 'ADMIN_USER_UNBANNED',
    status: 'SUCCESS',
    actorId: c.get('user')?.id,
    targetId: userId,
  });

  return c.json({ ok: true });
});

adminRouter.post('/users/:user_id/2fa/reset', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const userId = c.req.param('user_id');
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) return c.json({ detail: 'المستخدم غير موجود' }, 404);
  await db.update(schema.users).set({ totp_enabled: false, totp_secret: null }).where(eq(schema.users.id, userId));

  recordAuditEvent({
    event: 'AUTH_2FA_DISABLED',
    status: 'SUCCESS',
    actorId: c.get('user')?.id,
    targetId: userId,
    details: { resetByAdmin: true },
  });

  return c.json({ ok: true });
});

// ─────────────────────── Logs & Bans (read) ──────────────────────────────────
adminRouter.get('/logs', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 500);
  // ActivityLog table may not be in schema if not generated — return empty gracefully
  return c.json([]);
});

adminRouter.get('/bans', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const bans = await db.select().from(schema.banRecords).orderBy(desc(schema.banRecords.created_at));
  const out = await Promise.all(bans.map(async (b) => {
    const user = await db.select().from(schema.users).where(eq(schema.users.id, b.user_id)).get();
    return {
      id: b.id, user_id: b.user_id, user_name: user?.full_name ?? '—',
      reason: b.reason, status: b.status, created_at: b.created_at,
      appeal_message: b.appeal_message, appealed_at: b.appealed_at,
    };
  }));
  return c.json(out);
});

adminRouter.post('/bans/:ban_id/approve-appeal', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const banId = c.req.param('ban_id');
  const record = await db.select().from(schema.banRecords).where(eq(schema.banRecords.id, banId)).get();
  if (!record) return c.json({ detail: 'سجل الحظر غير موجود' }, 404);
  await db.update(schema.banRecords).set({ status: 'lifted' }).where(eq(schema.banRecords.id, banId));
  await db.update(schema.users).set({ is_banned: false }).where(eq(schema.users.id, record.user_id));
  return c.json({ ok: true });
});

adminRouter.post('/bans/:ban_id/reject-appeal', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const banId = c.req.param('ban_id');
  const record = await db.select().from(schema.banRecords).where(eq(schema.banRecords.id, banId)).get();
  if (!record) return c.json({ detail: 'سجل الحظر غير موجود' }, 404);
  await db.update(schema.banRecords).set({ status: 'active' }).where(eq(schema.banRecords.id, banId));
  return c.json({ ok: true });
});

// ─────────────────────── Catalog CRUD ────────────────────────────────────────
adminRouter.get('/catalog', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const sections = await db.select().from(schema.sections);
  const unis = await db.select().from(schema.universities);
  const stages = await db.select().from(schema.stages);
  const subjects = await db.select().from(schema.subjects);
  const questions = await db.select({ id: schema.questions.id, subject_id: schema.questions.subject_id }).from(schema.questions);

  const stagesByUni: Record<string, typeof stages> = {};
  stages.forEach((s) => { if (s.university_id) { stagesByUni[s.university_id] ??= []; stagesByUni[s.university_id].push(s); } });

  const subjectsByStage: Record<string, typeof subjects> = {};
  subjects.forEach((s) => { if (s.stage_id) { subjectsByStage[s.stage_id] ??= []; subjectsByStage[s.stage_id].push(s); } });

  const questionCountBySubject: Record<string, number> = {};
  questions.forEach((q) => { if (q.subject_id) questionCountBySubject[q.subject_id] = (questionCountBySubject[q.subject_id] ?? 0) + 1; });

  const unisBySection: Record<string, typeof unis> = {};
  unis.forEach((u) => { if (u.section_id) { unisBySection[u.section_id] ??= []; unisBySection[u.section_id].push(u); } });

  const rows: Array<{ id: string; level: number; type: string; name: string; meta: string }> = [];
  for (const section of sections) {
    const sUnis = unisBySection[section.id] ?? [];
    rows.push({ id: section.id, level: 0, type: 'section', name: section.name, meta: `${sUnis.length} جامعة` });
    for (const uni of sUnis) {
      const uStages = stagesByUni[uni.id] ?? [];
      rows.push({ id: uni.id, level: 1, type: 'university', name: uni.name, meta: `${uStages.length} مرحلة` });
      for (const stage of uStages) {
        const sSubjects = subjectsByStage[stage.id] ?? [];
        rows.push({ id: stage.id, level: 2, type: 'stage', name: stage.name, meta: `${sSubjects.length} مادة` });
        for (const subj of sSubjects) {
          rows.push({ id: subj.id, level: 3, type: 'subject', name: subj.name, meta: `${questionCountBySubject[subj.id] ?? 0} سؤال` });
        }
      }
    }
  }
  return c.json(rows);
});

adminRouter.post('/catalog/sections', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const name = c.req.query('name') ?? '';
  const id = schema.genId();
  await db.insert(schema.sections).values({ id, name: name.trim() });
  return c.json({ id });
});

adminRouter.post('/catalog/universities', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const name = c.req.query('name') ?? '';
  const sectionId = c.req.query('section_id') ?? '';
  const sec = await db.select().from(schema.sections).where(eq(schema.sections.id, sectionId)).get();
  if (!sec) return c.json({ detail: 'القسم غير موجود' }, 404);
  const id = schema.genId();
  await db.insert(schema.universities).values({ id, name: name.trim(), section_id: sectionId });
  return c.json({ id });
});

adminRouter.post('/catalog/stages', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const name = c.req.query('name') ?? '';
  const universityId = c.req.query('university_id') ?? '';
  const uni = await db.select().from(schema.universities).where(eq(schema.universities.id, universityId)).get();
  if (!uni) return c.json({ detail: 'الجامعة غير موجودة' }, 404);
  const id = schema.genId();
  await db.insert(schema.stages).values({ id, name: name.trim(), university_id: universityId });
  return c.json({ id });
});

adminRouter.post('/catalog/subjects', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const name = c.req.query('name') ?? '';
  const stageId = c.req.query('stage_id') ?? '';
  const stage = await db.select().from(schema.stages).where(eq(schema.stages.id, stageId)).get();
  if (!stage) return c.json({ detail: 'المرحلة غير موجودة' }, 404);
  const id = schema.genId();
  await db.insert(schema.subjects).values({ id, name: name.trim(), stage_id: stageId });
  return c.json({ id });
});

adminRouter.put('/catalog/sections/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const name = c.req.query('name') ?? '';
  const s = await db.select().from(schema.sections).where(eq(schema.sections.id, id)).get();
  if (!s) return c.json({ detail: 'القسم غير موجود' }, 404);
  await db.update(schema.sections).set({ name: name.trim() }).where(eq(schema.sections.id, id));
  return c.json({ ok: true });
});

adminRouter.delete('/catalog/sections/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const s = await db.select().from(schema.sections).where(eq(schema.sections.id, id)).get();
  if (!s) return c.json({ detail: 'القسم غير موجود' }, 404);
  const childUnis = await db.select().from(schema.universities).where(eq(schema.universities.section_id, id));
  if (childUnis.length) return c.json({ detail: 'لا يمكن حذف القسم — يحتوي على جامعات. احذفيها أولاً' }, 400);
  await db.delete(schema.sections).where(eq(schema.sections.id, id));
  return c.json({ ok: true });
});

adminRouter.put('/catalog/universities/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const name = c.req.query('name') ?? '';
  const u = await db.select().from(schema.universities).where(eq(schema.universities.id, id)).get();
  if (!u) return c.json({ detail: 'الجامعة غير موجودة' }, 404);
  await db.update(schema.universities).set({ name: name.trim() }).where(eq(schema.universities.id, id));
  return c.json({ ok: true });
});

adminRouter.delete('/catalog/universities/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const u = await db.select().from(schema.universities).where(eq(schema.universities.id, id)).get();
  if (!u) return c.json({ detail: 'الجامعة غير موجودة' }, 404);
  const childStages = await db.select().from(schema.stages).where(eq(schema.stages.university_id, id));
  if (childStages.length) return c.json({ detail: 'لا يمكن حذف الجامعة — تحتوي على مراحل. احذفيها أولاً' }, 400);
  await db.delete(schema.universities).where(eq(schema.universities.id, id));
  return c.json({ ok: true });
});

adminRouter.put('/catalog/stages/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const name = c.req.query('name') ?? '';
  const st = await db.select().from(schema.stages).where(eq(schema.stages.id, id)).get();
  if (!st) return c.json({ detail: 'المرحلة غير موجودة' }, 404);
  await db.update(schema.stages).set({ name: name.trim() }).where(eq(schema.stages.id, id));
  return c.json({ ok: true });
});

adminRouter.delete('/catalog/stages/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const st = await db.select().from(schema.stages).where(eq(schema.stages.id, id)).get();
  if (!st) return c.json({ detail: 'المرحلة غير موجودة' }, 404);
  const childSubjects = await db.select().from(schema.subjects).where(eq(schema.subjects.stage_id, id));
  if (childSubjects.length) return c.json({ detail: 'لا يمكن حذف المرحلة — تحتوي على مواد. احذفيها أولاً' }, 400);
  await db.delete(schema.stages).where(eq(schema.stages.id, id));
  return c.json({ ok: true });
});

adminRouter.put('/catalog/subjects/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const name = c.req.query('name') ?? '';
  const subj = await db.select().from(schema.subjects).where(eq(schema.subjects.id, id)).get();
  if (!subj) return c.json({ detail: 'المادة غير موجودة' }, 404);
  await db.update(schema.subjects).set({ name: name.trim() }).where(eq(schema.subjects.id, id));
  return c.json({ ok: true });
});

adminRouter.delete('/catalog/subjects/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const subj = await db.select().from(schema.subjects).where(eq(schema.subjects.id, id)).get();
  if (!subj) return c.json({ detail: 'المادة غير موجودة' }, 404);

  // Soft delete subject
  await db.update(schema.subjects).set({
    is_deleted: true,
    deleted_at: new Date().toISOString(),
  }).where(eq(schema.subjects.id, id));

  recordAuditEvent({
    event: 'ADMIN_SUBJECT_SOFT_DELETED',
    status: 'SUCCESS',
    actorId: c.get('user')?.id,
    targetId: id,
  });

  return c.json({ ok: true });
});

// ─────────────────────── Catalog Bulk, Import & Duplicate Helpers ──────────
adminRouter.post('/catalog/import', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{ text: string; preview?: boolean }>();
  const text = (body.text || '').trim();
  if (!text) return c.json({ detail: 'النص فارغ' }, 400);

  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  let curSection = '';
  let curUni = '';
  let curStage = '';

  const parsedItems: Array<{ type: 'section' | 'university' | 'stage' | 'subject'; name: string; parentName?: string }> = [];

  for (const rawLine of lines) {
    const indentMatch = rawLine.match(/^(\s*)/);
    const spaces = indentMatch ? indentMatch[1].length : 0;
    const name = rawLine.trim();

    if (spaces === 0) {
      curSection = name;
      parsedItems.push({ type: 'section', name });
    } else if (spaces <= 2) {
      curUni = name;
      parsedItems.push({ type: 'university', name, parentName: curSection });
    } else if (spaces <= 4) {
      curStage = name;
      parsedItems.push({ type: 'stage', name, parentName: curUni });
    } else {
      parsedItems.push({ type: 'subject', name, parentName: curStage });
    }
  }

  const existingSections = await db.select().from(schema.sections);
  const secMap = new Map(existingSections.map((s) => [s.name.trim().toLowerCase(), s.id]));

  const existingUnis = await db.select().from(schema.universities);
  const uniMap = new Map(existingUnis.map((u) => [u.name.trim().toLowerCase(), u.id]));

  const existingStages = await db.select().from(schema.stages);
  const stageMap = new Map(existingStages.map((st) => [st.name.trim().toLowerCase(), st.id]));

  const existingSubs = await db.select().from(schema.subjects).where(eq(schema.subjects.is_deleted, false));
  const subMap = new Map(existingSubs.map((sb) => [sb.name.trim().toLowerCase(), sb.id]));

  let cSec = 0, cUni = 0, cStg = 0, cSub = 0;
  let rSec = 0, rUni = 0, rStg = 0, rSub = 0;

  for (const item of parsedItems) {
    const key = item.name.toLowerCase();
    if (item.type === 'section') {
      if (secMap.has(key)) {
        rSec++;
      } else {
        cSec++;
        if (!body.preview) {
          const id = schema.genId();
          await db.insert(schema.sections).values({ id, name: item.name });
          secMap.set(key, id);
        }
      }
    } else if (item.type === 'university') {
      if (uniMap.has(key)) {
        rUni++;
      } else {
        cUni++;
        if (!body.preview) {
          const sId = secMap.get(item.parentName?.toLowerCase() || '') || null;
          const id = schema.genId();
          await db.insert(schema.universities).values({ id, name: item.name, section_id: sId });
          uniMap.set(key, id);
        }
      }
    } else if (item.type === 'stage') {
      if (stageMap.has(key)) {
        rStg++;
      } else {
        cStg++;
        if (!body.preview) {
          const uId = uniMap.get(item.parentName?.toLowerCase() || '') || null;
          const id = schema.genId();
          await db.insert(schema.stages).values({ id, name: item.name, university_id: uId });
          stageMap.set(key, id);
        }
      }
    } else if (item.type === 'subject') {
      if (subMap.has(key)) {
        rSub++;
      } else {
        cSub++;
        if (!body.preview) {
          const stId = stageMap.get(item.parentName?.toLowerCase() || '') || null;
          const id = schema.genId();
          if (stId) {
            await db.insert(schema.subjects).values({ id, name: item.name, stage_id: stId });
            subMap.set(key, id);
          }
        }
      }
    }
  }

  const totalCreated = cSec + cUni + cStg + cSub;
  return c.json({
    created: { sections: cSec, universities: cUni, stages: cStg, subjects: cSub },
    reused: { sections: rSec, universities: rUni, stages: rStg, subjects: rSub },
    total_created: totalCreated,
    problems: [],
  });
});

adminRouter.post('/catalog/bulk', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{ parent_type: string; parent_id: string | null; names: string[] }>();
  const names = (body.names || []).map((n) => n.trim()).filter((n) => n.length > 0);
  if (!names.length) return c.json({ detail: 'لا توجد أسماء' }, 400);

  let created = 0;
  let skipped = 0;

  if (body.parent_type === 'root') {
    const existing = await db.select().from(schema.sections);
    const set = new Set(existing.map((s) => s.name.toLowerCase()));
    for (const n of names) {
      if (set.has(n.toLowerCase())) { skipped++; continue; }
      await db.insert(schema.sections).values({ id: schema.genId(), name: n });
      set.add(n.toLowerCase());
      created++;
    }
  } else if (body.parent_type === 'section') {
    const existing = await db.select().from(schema.universities).where(eq(schema.universities.section_id, body.parent_id!));
    const set = new Set(existing.map((u) => u.name.toLowerCase()));
    for (const n of names) {
      if (set.has(n.toLowerCase())) { skipped++; continue; }
      await db.insert(schema.universities).values({ id: schema.genId(), name: n, section_id: body.parent_id! });
      set.add(n.toLowerCase());
      created++;
    }
  } else if (body.parent_type === 'university') {
    const existing = await db.select().from(schema.stages).where(eq(schema.stages.university_id, body.parent_id!));
    const set = new Set(existing.map((st) => st.name.toLowerCase()));
    for (const n of names) {
      if (set.has(n.toLowerCase())) { skipped++; continue; }
      await db.insert(schema.stages).values({ id: schema.genId(), name: n, university_id: body.parent_id! });
      set.add(n.toLowerCase());
      created++;
    }
  } else if (body.parent_type === 'stage') {
    const existing = await db.select().from(schema.subjects).where(and(eq(schema.subjects.stage_id, body.parent_id!), eq(schema.subjects.is_deleted, false)));
    const set = new Set(existing.map((sb) => sb.name.toLowerCase()));
    for (const n of names) {
      if (set.has(n.toLowerCase())) { skipped++; continue; }
      await db.insert(schema.subjects).values({ id: schema.genId(), name: n, stage_id: body.parent_id!, is_deleted: false });
      set.add(n.toLowerCase());
      created++;
    }
  }

  return c.json({ created, skipped });
});

adminRouter.post('/catalog/duplicate', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{ type: 'university' | 'stage'; id: string; new_names: string[]; target_parent_id?: string | null }>();
  const names = (body.new_names || []).map((n) => n.trim()).filter((n) => n.length > 0);
  if (!names.length) return c.json({ detail: 'الأسماء مطلوبة' }, 400);

  const copies: string[] = [];
  const skipped: string[] = [];
  let uCount = 0, stgCount = 0, subCount = 0;

  if (body.type === 'university') {
    const srcUni = await db.select().from(schema.universities).where(eq(schema.universities.id, body.id)).get();
    if (!srcUni) return c.json({ detail: 'الجامعة غير موجودة' }, 404);
    const targetSectionId = body.target_parent_id || srcUni.section_id;

    const srcStages = await db.select().from(schema.stages).where(eq(schema.stages.university_id, body.id));

    for (const name of names) {
      const dup = await db.select().from(schema.universities).where(eq(schema.universities.name, name)).get();
      if (dup) { skipped.push(name); continue; }

      const newUniId = schema.genId();
      await db.insert(schema.universities).values({ id: newUniId, name, section_id: targetSectionId, type: srcUni.type, province: srcUni.province });
      uCount++;

      for (const stg of srcStages) {
        const newStageId = schema.genId();
        await db.insert(schema.stages).values({ id: newStageId, name: stg.name, stage_number: stg.stage_number, university_id: newUniId });
        stgCount++;

        const srcSubs = await db.select().from(schema.subjects).where(and(eq(schema.subjects.stage_id, stg.id), eq(schema.subjects.is_deleted, false)));
        for (const sub of srcSubs) {
          await db.insert(schema.subjects).values({ id: schema.genId(), name: sub.name, stage_id: newStageId, term: sub.term, is_ministerial: sub.is_ministerial, has_practical: sub.has_practical, is_deleted: false });
          subCount++;
        }
      }
      copies.push(name);
    }
  } else if (body.type === 'stage') {
    const srcStage = await db.select().from(schema.stages).where(eq(schema.stages.id, body.id)).get();
    if (!srcStage) return c.json({ detail: 'المرحلة غير موجودة' }, 404);
    const targetUniId = body.target_parent_id || srcStage.university_id;

    const srcSubs = await db.select().from(schema.subjects).where(and(eq(schema.subjects.stage_id, body.id), eq(schema.subjects.is_deleted, false)));

    for (const name of names) {
      const newStageId = schema.genId();
      await db.insert(schema.stages).values({ id: newStageId, name, stage_number: srcStage.stage_number, university_id: targetUniId });
      stgCount++;

      for (const sub of srcSubs) {
        await db.insert(schema.subjects).values({ id: schema.genId(), name: sub.name, stage_id: newStageId, term: sub.term, is_ministerial: sub.is_ministerial, has_practical: sub.has_practical, is_deleted: false });
        subCount++;
      }
      copies.push(name);
    }
  }

  return c.json({ copies, skipped, universities: uCount, stages: stgCount, subjects: subCount });
});

// ─────────────────────── Iraqi Medical Group Academic Hierarchy ───────────────
const ARABIC_STAGE_NAMES = ['المرحلة الأولى', 'المرحلة الثانية', 'المرحلة الثالثة', 'المرحلة الرابعة', 'المرحلة الخامسة', 'المرحلة السادسة'];

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((char === ',' || char === '\t') && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// ── 1. Academic Tree (Full Hierarchy for Admin) ──
adminRouter.get('/academic/tree', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const unis = await db.select().from(schema.universities);
  const collist = await db.select().from(schema.colleges);
  const proglist = await db.select().from(schema.collegePrograms);
  const stagelist = await db.select().from(schema.stages);
  const subjlist = await db.select().from(schema.subjects).where(eq(schema.subjects.is_deleted, false));
  const questions = await db.select({ id: schema.questions.id, subject_id: schema.questions.subject_id }).from(schema.questions).where(eq(schema.questions.is_deleted, false));

  const questionsCount: Record<string, number> = {};
  for (const q of questions) {
    if (q.subject_id) questionsCount[q.subject_id] = (questionsCount[q.subject_id] || 0) + 1;
  }

  const colMap = new Map(collist.map((col) => [col.id, col]));

  const subsByStage: Record<string, typeof subjlist> = {};
  for (const sub of subjlist) {
    subsByStage[sub.stage_id] ??= [];
    subsByStage[sub.stage_id].push(sub);
  }

  const stagesByProg: Record<string, typeof stagelist> = {};
  const stagesByUniDirect: Record<string, typeof stagelist> = {};
  for (const stg of stagelist) {
    if (stg.program_id) {
      stagesByProg[stg.program_id] ??= [];
      stagesByProg[stg.program_id].push(stg);
    } else if (stg.university_id) {
      stagesByUniDirect[stg.university_id] ??= [];
      stagesByUniDirect[stg.university_id].push(stg);
    }
  }

  const progsByUni: Record<string, typeof proglist> = {};
  for (const prg of proglist) {
    progsByUni[prg.university_id] ??= [];
    progsByUni[prg.university_id].push(prg);
  }

  const tree = unis.map((uni) => {
    const uProgs = progsByUni[uni.id] ?? [];
    const directStages = stagesByUniDirect[uni.id] ?? [];

    return {
      id: uni.id,
      name: uni.name,
      type: uni.type ?? 'government',
      province: uni.province ?? null,
      logo_url: uni.logo_url ?? null,
      programs: uProgs.map((prg) => {
        const col = colMap.get(prg.college_id);
        const pStages = (stagesByProg[prg.id] ?? []).sort((a, b) => (a.stage_number ?? 0) - (b.stage_number ?? 0));
        return {
          id: prg.id,
          college_id: prg.college_id,
          college_name: col?.name ?? 'كلية غير معروفة',
          college_code: col?.code ?? null,
          system_type: prg.system_type,
          total_stages: prg.total_stages,
          stages: pStages.map((stg) => {
            const sSubjects = subsByStage[stg.id] ?? [];
            return {
              id: stg.id,
              name: stg.name,
              stage_number: stg.stage_number ?? null,
              subjects: sSubjects.map((sub) => ({
                id: sub.id,
                name: sub.name,
                code: sub.code ?? null,
                term: sub.term,
                is_ministerial: sub.is_ministerial,
                has_practical: sub.has_practical,
                question_count: questionsCount[sub.id] ?? 0,
              })),
            };
          }),
        };
      }),
      direct_stages: directStages.map((stg) => {
        const sSubjects = subsByStage[stg.id] ?? [];
        return {
          id: stg.id,
          name: stg.name,
          stage_number: stg.stage_number ?? null,
          subjects: sSubjects.map((sub) => ({
            id: sub.id,
            name: sub.name,
            code: sub.code ?? null,
            term: sub.term,
            is_ministerial: sub.is_ministerial,
            has_practical: sub.has_practical,
            question_count: questionsCount[sub.id] ?? 0,
          })),
        };
      }),
    };
  });

  return c.json({
    universities: tree,
    colleges: collist,
    all_colleges: collist,
    total_universities: unis.length,
    total_colleges: collist.length,
    total_programs: proglist.length,
    total_stages: stagelist.length,
    total_subjects: subjlist.length,
  });
});

// Helper: ensure a default section exists to satisfy foreign key & NOT NULL constraints on universities
async function ensureDefaultSection(db: any): Promise<string> {
  const existing = await db.select().from(schema.sections).limit(1).get();
  if (existing) return existing.id;
  const id = schema.genId();
  await db.insert(schema.sections).values({
    id,
    name: 'كليات المجموعة الطبية',
  });
  return id;
}

// ── 2. Universities CRUD ──
adminRouter.get('/academic/universities', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const type = c.req.query('type');
  const province = c.req.query('province');
  const search = c.req.query('search')?.trim().toLowerCase();

  let list = await db.select().from(schema.universities);
  if (type) list = list.filter((u) => u.type === type);
  if (province) list = list.filter((u) => u.province === province);
  if (search) list = list.filter((u) => u.name.toLowerCase().includes(search) || (u.province && u.province.toLowerCase().includes(search)));

  return c.json(list);
});

adminRouter.post('/academic/universities', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{ name: string; type?: 'government' | 'private'; province?: string; logo_url?: string; section_id?: string }>();
  if (!body.name?.trim()) return c.json({ detail: 'اسم الجامعة مطلوب' }, 400);

  const existing = await db.select().from(schema.universities).where(eq(schema.universities.name, body.name.trim())).get();
  if (existing) return c.json({ detail: 'الجامعة مسجلة مسبقاً' }, 400);

  const sectionId = body.section_id || await ensureDefaultSection(db);
  const id = schema.genId();
  await db.insert(schema.universities).values({
    id,
    name: body.name.trim(),
    type: body.type === 'private' ? 'private' : 'government',
    province: body.province?.trim() || null,
    logo_url: body.logo_url?.trim() || null,
    section_id: sectionId,
  });

  recordAuditEvent({
    event: 'ADMIN_ACADEMIC_UNIVERSITY_CREATED',
    status: 'SUCCESS',
    actorId: c.get('user')?.id,
    targetId: id,
    details: { name: body.name.trim(), type: body.type, province: body.province },
  });

  const created = await db.select().from(schema.universities).where(eq(schema.universities.id, id)).get();
  return c.json(created, 201);
});

adminRouter.put('/academic/universities/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const body = await c.req.json<{ name?: string; type?: 'government' | 'private'; province?: string; logo_url?: string }>();

  const uni = await db.select().from(schema.universities).where(eq(schema.universities.id, id)).get();
  if (!uni) return c.json({ detail: 'الجامعة غير موجودة' }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined && body.name.trim()) updates.name = body.name.trim();
  if (body.type !== undefined) updates.type = body.type;
  if (body.province !== undefined) updates.province = body.province.trim() || null;
  if (body.logo_url !== undefined) updates.logo_url = body.logo_url.trim() || null;

  if (Object.keys(updates).length) {
    await db.update(schema.universities).set(updates).where(eq(schema.universities.id, id));
  }

  const updated = await db.select().from(schema.universities).where(eq(schema.universities.id, id)).get();
  return c.json(updated);
});

adminRouter.delete('/academic/universities/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const uni = await db.select().from(schema.universities).where(eq(schema.universities.id, id)).get();
  if (!uni) return c.json({ detail: 'الجامعة غير موجودة' }, 404);

  const enrolled = await db.select().from(schema.users).where(eq(schema.users.university_id, id)).limit(1);
  if (enrolled.length > 0) return c.json({ detail: 'لا يمكن حذف الجامعة — يوجد طلاب مسجلون بها حالياً' }, 400);

  await db.delete(schema.collegePrograms).where(eq(schema.collegePrograms.university_id, id));
  await db.delete(schema.stages).where(eq(schema.stages.university_id, id));
  await db.delete(schema.universities).where(eq(schema.universities.id, id));

  recordAuditEvent({
    event: 'ADMIN_ACADEMIC_UNIVERSITY_DELETED',
    status: 'SUCCESS',
    actorId: c.get('user')?.id,
    targetId: id,
    details: { name: uni.name },
  });

  return c.json({ ok: true });
});

// ── 3. Colleges CRUD ──
adminRouter.get('/academic/colleges', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const list = await db.select().from(schema.colleges);
  return c.json(list);
});

adminRouter.post('/academic/colleges', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{ name: string; code?: string; default_stages?: number }>();
  if (!body.name?.trim()) return c.json({ detail: 'اسم الكلية مطلوب' }, 400);

  const existing = await db.select().from(schema.colleges).where(eq(schema.colleges.name, body.name.trim())).get();
  if (existing) {
    return c.json({
      detail: 'الكلية مسجلة مسبقاً',
      existing_id: existing.id,
      college: existing,
      ...existing,
    }, 400);
  }

  const id = schema.genId();
  await db.insert(schema.colleges).values({
    id,
    name: body.name.trim(),
    code: body.code?.trim().toUpperCase() || null,
    default_stages: typeof body.default_stages === 'number' && body.default_stages > 0 ? body.default_stages : 6,
  });

  const created = await db.select().from(schema.colleges).where(eq(schema.colleges.id, id)).get();
  return c.json({ ...created, college: created }, 201);
});

adminRouter.put('/academic/colleges/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const body = await c.req.json<{ name?: string; code?: string; default_stages?: number }>();

  const col = await db.select().from(schema.colleges).where(eq(schema.colleges.id, id)).get();
  if (!col) return c.json({ detail: 'الكلية غير موجودة' }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined && body.name.trim()) updates.name = body.name.trim();
  if (body.code !== undefined) updates.code = body.code.trim().toUpperCase() || null;
  if (typeof body.default_stages === 'number' && body.default_stages > 0) updates.default_stages = body.default_stages;

  if (Object.keys(updates).length) {
    await db.update(schema.colleges).set(updates).where(eq(schema.colleges.id, id));
  }

  const updated = await db.select().from(schema.colleges).where(eq(schema.colleges.id, id)).get();
  return c.json(updated);
});

adminRouter.delete('/academic/colleges/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const col = await db.select().from(schema.colleges).where(eq(schema.colleges.id, id)).get();
  if (!col) return c.json({ detail: 'الكلية غير موجودة' }, 404);

  const programs = await db.select().from(schema.collegePrograms).where(eq(schema.collegePrograms.college_id, id)).limit(1);
  if (programs.length > 0) return c.json({ detail: 'لا يمكن حذف الكلية — مرتبطة ببرامج في جامعات' }, 400);

  await db.delete(schema.colleges).where(eq(schema.colleges.id, id));
  return c.json({ ok: true });
});

// ── 4. College Programs CRUD ──
adminRouter.get('/academic/programs', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const uniId = c.req.query('university_id');
  const colId = c.req.query('college_id');

  let list = await db.select().from(schema.collegePrograms);
  if (uniId) list = list.filter((p) => p.university_id === uniId);
  if (colId) list = list.filter((p) => p.college_id === colId);

  const unis = await db.select().from(schema.universities);
  const cols = await db.select().from(schema.colleges);
  const uniMap = new Map(unis.map((u) => [u.id, u]));
  const colMap = new Map(cols.map((cl) => [cl.id, cl]));

  const result = list.map((p) => ({
    ...p,
    university_name: uniMap.get(p.university_id)?.name ?? '—',
    college_name: colMap.get(p.college_id)?.name ?? '—',
    college_code: colMap.get(p.college_id)?.code ?? null,
  }));

  return c.json(result);
});

adminRouter.post('/academic/programs', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{
    university_id: string;
    college_id: string;
    system_type?: 'modular' | 'traditional';
    total_stages?: number;
    auto_create_stages?: boolean;
  }>();

  if (!body.university_id || !body.college_id) return c.json({ detail: 'الجامعة والكلية مطلوبتان' }, 400);

  const uni = await db.select().from(schema.universities).where(eq(schema.universities.id, body.university_id)).get();
  if (!uni) return c.json({ detail: 'الجامعة غير موجودة' }, 404);

  const col = await db.select().from(schema.colleges).where(eq(schema.colleges.id, body.college_id)).get();
  if (!col) return c.json({ detail: 'الكلية غير موجودة' }, 404);

  const existing = await db.select().from(schema.collegePrograms).where(
    and(eq(schema.collegePrograms.university_id, body.university_id), eq(schema.collegePrograms.college_id, body.college_id))
  ).get();
  if (existing) {
    return c.json({
      detail: 'البرنامج مضاف مسبقاً لهذه الجامعة',
      existing_id: existing.id,
      program: existing,
      ...existing,
    }, 400);
  }

  const totalStages = typeof body.total_stages === 'number' && body.total_stages > 0 ? body.total_stages : col.default_stages;
  const programId = schema.genId();

  await db.insert(schema.collegePrograms).values({
    id: programId,
    university_id: body.university_id,
    college_id: body.college_id,
    system_type: body.system_type === 'modular' ? 'modular' : 'traditional',
    total_stages: totalStages,
  });

  if (body.auto_create_stages !== false) {
    for (let i = 1; i <= Math.min(totalStages, 6); i++) {
      const stageName = ARABIC_STAGE_NAMES[i - 1] || `المرحلة ${i}`;
      await db.insert(schema.stages).values({
        id: schema.genId(),
        name: stageName,
        stage_number: i,
        program_id: programId,
        university_id: body.university_id,
        college_id: body.college_id,
      });
    }
  }

  recordAuditEvent({
    event: 'ADMIN_ACADEMIC_PROGRAM_CREATED',
    status: 'SUCCESS',
    actorId: c.get('user')?.id,
    targetId: programId,
    details: { university_id: body.university_id, college_id: body.college_id, system_type: body.system_type },
  });

  const created = await db.select().from(schema.collegePrograms).where(eq(schema.collegePrograms.id, programId)).get();
  return c.json(created, 201);
});

adminRouter.put('/academic/programs/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const body = await c.req.json<{ system_type?: 'modular' | 'traditional'; total_stages?: number }>();

  const prog = await db.select().from(schema.collegePrograms).where(eq(schema.collegePrograms.id, id)).get();
  if (!prog) return c.json({ detail: 'البرنامج غير موجود' }, 404);

  const updates: Record<string, unknown> = {};
  if (body.system_type) updates.system_type = body.system_type;
  if (typeof body.total_stages === 'number' && body.total_stages > 0) updates.total_stages = body.total_stages;

  if (Object.keys(updates).length) {
    await db.update(schema.collegePrograms).set(updates).where(eq(schema.collegePrograms.id, id));
  }

  const updated = await db.select().from(schema.collegePrograms).where(eq(schema.collegePrograms.id, id)).get();
  return c.json(updated);
});

adminRouter.delete('/academic/programs/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const prog = await db.select().from(schema.collegePrograms).where(eq(schema.collegePrograms.id, id)).get();
  if (!prog) return c.json({ detail: 'البرنامج غير موجود' }, 404);

  const pStages = await db.select().from(schema.stages).where(eq(schema.stages.program_id, id));
  for (const stg of pStages) {
    const hasSubs = await db.select().from(schema.subjects).where(eq(schema.subjects.stage_id, stg.id)).limit(1);
    if (hasSubs.length > 0) {
      return c.json({ detail: 'لا يمكن حذف البرنامج — توجد مواد دراسية في مراحله. احذف المواد أولاً.' }, 400);
    }
  }

  await db.delete(schema.stages).where(eq(schema.stages.program_id, id));
  await db.delete(schema.collegePrograms).where(eq(schema.collegePrograms.id, id));

  return c.json({ ok: true });
});

// ── 5. Stages CRUD ──
adminRouter.get('/academic/stages', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const progId = c.req.query('program_id');
  const uniId = c.req.query('university_id');

  let list = await db.select().from(schema.stages);
  if (progId) list = list.filter((s) => s.program_id === progId);
  if (uniId) list = list.filter((s) => s.university_id === uniId);

  return c.json(list);
});

adminRouter.post('/academic/stages', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{
    name: string;
    stage_number?: number;
    program_id?: string;
    university_id?: string;
    college_id?: string;
  }>();

  if (!body.name?.trim()) return c.json({ detail: 'اسم المرحلة مطلوب' }, 400);

  let uniId = body.university_id;
  let colId = body.college_id;

  if (body.program_id) {
    const prog = await db.select().from(schema.collegePrograms).where(eq(schema.collegePrograms.id, body.program_id)).get();
    if (prog) {
      uniId = uniId || prog.university_id;
      colId = colId || prog.college_id;
    }
  }

  const id = schema.genId();
  await db.insert(schema.stages).values({
    id,
    name: body.name.trim(),
    stage_number: typeof body.stage_number === 'number' ? body.stage_number : null,
    program_id: body.program_id || null,
    university_id: uniId || null,
    college_id: colId || null,
  });

  const created = await db.select().from(schema.stages).where(eq(schema.stages.id, id)).get();
  return c.json(created, 201);
});

adminRouter.put('/academic/stages/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const body = await c.req.json<{ name?: string; stage_number?: number }>();

  const stg = await db.select().from(schema.stages).where(eq(schema.stages.id, id)).get();
  if (!stg) return c.json({ detail: 'المرحلة غير موجودة' }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined && body.name.trim()) updates.name = body.name.trim();
  if (typeof body.stage_number === 'number') updates.stage_number = body.stage_number;

  if (Object.keys(updates).length) {
    await db.update(schema.stages).set(updates).where(eq(schema.stages.id, id));
  }

  const updated = await db.select().from(schema.stages).where(eq(schema.stages.id, id)).get();
  return c.json(updated);
});

adminRouter.delete('/academic/stages/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const stg = await db.select().from(schema.stages).where(eq(schema.stages.id, id)).get();
  if (!stg) return c.json({ detail: 'المرحلة غير موجودة' }, 404);

  const childSubjects = await db.select().from(schema.subjects).where(eq(schema.subjects.stage_id, id));
  if (childSubjects.length > 0) return c.json({ detail: 'لا يمكن حذف المرحلة — تحتوي على مواد دراسية. احذفها أولاً.' }, 400);

  await db.delete(schema.stages).where(eq(schema.stages.id, id));
  return c.json({ ok: true });
});

// ── 6. Subjects CRUD ──
adminRouter.get('/academic/subjects', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const stageId = c.req.query('stage_id');
  const isMinisterial = c.req.query('is_ministerial');
  const term = c.req.query('term');

  let list = await db.select().from(schema.subjects).where(eq(schema.subjects.is_deleted, false));
  if (stageId) list = list.filter((s) => s.stage_id === stageId);
  if (isMinisterial !== undefined && isMinisterial !== '') list = list.filter((s) => String(s.is_ministerial) === isMinisterial || (isMinisterial === 'true' && s.is_ministerial));
  if (term) list = list.filter((s) => s.term === term);

  return c.json(list);
});

adminRouter.post('/academic/subjects', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{
    name: string;
    stage_id: string;
    code?: string;
    term?: 'annual' | 'semester_1' | 'semester_2' | 'modular_block';
    is_ministerial?: boolean;
    has_practical?: boolean;
  }>();

  if (!body.name?.trim() || !body.stage_id) return c.json({ detail: 'اسم المادة والمرحلة مطلوبان' }, 400);

  const stage = await db.select().from(schema.stages).where(eq(schema.stages.id, body.stage_id)).get();
  if (!stage) return c.json({ detail: 'المرحلة غير موجودة' }, 404);

  const validTerms = new Set(['annual', 'semester_1', 'semester_2', 'modular_block']);
  const term = body.term && validTerms.has(body.term) ? body.term : 'annual';

  const id = schema.genId();
  await db.insert(schema.subjects).values({
    id,
    name: body.name.trim(),
    code: body.code?.trim().toUpperCase() || null,
    stage_id: body.stage_id,
    term: term as 'annual' | 'semester_1' | 'semester_2' | 'modular_block',
    is_ministerial: !!body.is_ministerial,
    has_practical: !!body.has_practical,
    is_deleted: false,
  });

  const created = await db.select().from(schema.subjects).where(eq(schema.subjects.id, id)).get();
  return c.json(created, 201);
});

adminRouter.put('/academic/subjects/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const body = await c.req.json<{
    name?: string;
    code?: string;
    term?: 'annual' | 'semester_1' | 'semester_2' | 'modular_block';
    is_ministerial?: boolean;
    has_practical?: boolean;
  }>();

  const subj = await db.select().from(schema.subjects).where(eq(schema.subjects.id, id)).get();
  if (!subj) return c.json({ detail: 'المادة غير موجودة' }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined && body.name.trim()) updates.name = body.name.trim();
  if (body.code !== undefined) updates.code = body.code.trim().toUpperCase() || null;
  if (body.term !== undefined) updates.term = body.term;
  if (body.is_ministerial !== undefined) updates.is_ministerial = !!body.is_ministerial;
  if (body.has_practical !== undefined) updates.has_practical = !!body.has_practical;

  if (Object.keys(updates).length) {
    await db.update(schema.subjects).set(updates).where(eq(schema.subjects.id, id));
  }

  const updated = await db.select().from(schema.subjects).where(eq(schema.subjects.id, id)).get();
  return c.json(updated);
});

adminRouter.delete('/academic/subjects/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const subj = await db.select().from(schema.subjects).where(eq(schema.subjects.id, id)).get();
  if (!subj) return c.json({ detail: 'المادة غير موجودة' }, 404);

  await db.update(schema.subjects).set({
    is_deleted: true,
    deleted_at: new Date().toISOString(),
  }).where(eq(schema.subjects.id, id));

  return c.json({ ok: true });
});

// ── 7. CSV Bulk Import & Export ──
async function handleAcademicParsedRows(db: any, rows: any[], c: any) {
  let createdUnis = 0;
  let createdCols = 0;
  let createdProgs = 0;
  let createdStages = 0;
  let createdSubs = 0;
  let skipped = 0;

  const unis = await db.select().from(schema.universities);
  const uniMap = new Map(unis.map((u: any) => [u.name.trim().toLowerCase(), u]));

  const cols = await db.select().from(schema.colleges);
  const colMap = new Map(cols.map((cl: any) => [cl.name.trim().toLowerCase(), cl]));

  const progs = await db.select().from(schema.collegePrograms);
  const progMap = new Map(progs.map((p: any) => [`${p.university_id}:${p.college_id}`, p]));

  const stages = await db.select().from(schema.stages);
  const stageMap = new Map(stages.map((st: any) => [`${st.program_id || st.university_id}:${st.name.trim().toLowerCase()}`, st]));

  const subs = await db.select().from(schema.subjects).where(eq(schema.subjects.is_deleted, false));
  const subMap = new Map(subs.map((sb: any) => [`${sb.stage_id}:${sb.name.trim().toLowerCase()}`, sb]));

  const defaultSectionId = await ensureDefaultSection(db);

  for (const r of rows) {
    const uniName = (r.university || '').trim();
    if (!uniName) {
      skipped++;
      continue;
    }

    // 1. University
    let uni: any = uniMap.get(uniName.toLowerCase());
    if (!uni) {
      const uId = schema.genId();
      await db.insert(schema.universities).values({
        id: uId,
        name: uniName,
        type: r.university_type === 'private' ? 'private' : 'government',
        province: r.province?.trim() || null,
        section_id: defaultSectionId,
      });
      uni = { id: uId, name: uniName, type: r.university_type, province: r.province, section_id: defaultSectionId };
      uniMap.set(uniName.toLowerCase(), uni);
      createdUnis++;
    }

    // 2. College
    const colName = (r.college || '').trim();
    let col: any = null;
    if (colName) {
      col = colMap.get(colName.toLowerCase());
      if (!col) {
        const cId = schema.genId();
        let defaultStages = 6;
        if (colName.includes('أسنان') || colName.includes('صيدلة')) defaultStages = 5;
        else if (colName.includes('تمريض') || colName.includes('تقني') || colName.includes('مختبر')) defaultStages = 4;

        await db.insert(schema.colleges).values({
          id: cId,
          name: colName,
          default_stages: defaultStages,
        });
        col = { id: cId, name: colName, default_stages: defaultStages };
        colMap.set(colName.toLowerCase(), col);
        createdCols++;
      }
    }

    // 3. Program
    let prog: any = null;
    if (col && uni) {
      const progKey = `${uni.id}:${col.id}`;
      prog = progMap.get(progKey);
      if (!prog) {
        const pId = schema.genId();
        const sysType = r.system_type === 'modular' || r.system_type === 'تكاملي' || r.system_type === 'موديول' ? 'modular' : 'traditional';
        await db.insert(schema.collegePrograms).values({
          id: pId,
          university_id: uni.id,
          college_id: col.id,
          system_type: sysType,
          total_stages: col.default_stages || 6,
        });
        prog = { id: pId, university_id: uni.id, college_id: col.id, system_type: sysType, total_stages: col.default_stages || 6 };
        progMap.set(progKey, prog);
        createdProgs++;
      }
    }

    // 4. Stage
    const stageName = (r.stage || '').trim();
    let stage: any = null;
    if (stageName) {
      const parentId = prog ? prog.id : uni.id;
      const stageKey = `${parentId}:${stageName.toLowerCase()}`;
      stage = stageMap.get(stageKey);
      if (!stage) {
        const stId = schema.genId();
        let stageNum = null;
        if (stageName.includes('أول') || stageName.includes('1')) stageNum = 1;
        else if (stageName.includes('ثان') || stageName.includes('2')) stageNum = 2;
        else if (stageName.includes('ثالث') || stageName.includes('3')) stageNum = 3;
        else if (stageName.includes('رابع') || stageName.includes('4')) stageNum = 4;
        else if (stageName.includes('خامس') || stageName.includes('5')) stageNum = 5;
        else if (stageName.includes('سادس') || stageName.includes('6')) stageNum = 6;

        await db.insert(schema.stages).values({
          id: stId,
          name: stageName,
          stage_number: stageNum,
          program_id: prog ? prog.id : null,
          university_id: uni.id,
          college_id: col ? col.id : null,
        });
        stage = { id: stId, name: stageName, stage_number: stageNum, program_id: prog ? prog.id : null, university_id: uni.id, college_id: col ? col.id : null };
        stageMap.set(stageKey, stage);
        createdStages++;
      }
    }

    // 5. Subject
    const subName = (r.subject || '').trim();
    if (subName && stage) {
      const subKey = `${stage.id}:${subName.toLowerCase()}`;
      let sub = subMap.get(subKey);
      if (!sub) {
        const sId = schema.genId();
        let termVal: 'annual' | 'semester_1' | 'semester_2' | 'modular_block' = 'annual';
        if (r.term === 'semester_1' || r.term === 'كورس أول' || r.term === 'فصل أول') termVal = 'semester_1';
        else if (r.term === 'semester_2' || r.term === 'كورس ثاني' || r.term === 'فصل ثاني') termVal = 'semester_2';
        else if (r.term === 'modular_block' || r.term === 'موديول') termVal = 'modular_block';

        await db.insert(schema.subjects).values({
          id: sId,
          name: subName,
          stage_id: stage.id,
          term: termVal,
          is_ministerial: !!r.is_ministerial,
          has_practical: !!r.has_practical,
          is_deleted: false,
        });
        sub = { id: sId, name: subName, stage_id: stage.id };
        subMap.set(subKey, sub);
        createdSubs++;
      } else {
        skipped++;
      }
    }
  }

  recordAuditEvent({
    event: 'ADMIN_ACADEMIC_CSV_IMPORTED',
    status: 'SUCCESS',
    actorId: c.get('user')?.id,
    targetId: 'academic_bulk',
    details: { createdUnis, createdCols, createdProgs, createdStages, createdSubs, skipped },
  });

  return c.json({
    ok: true,
    created: {
      universities: createdUnis,
      colleges: createdCols,
      programs: createdProgs,
      stages: createdStages,
      subjects: createdSubs,
    },
    skipped,
  });
}

adminRouter.post('/academic/import-csv', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  let rawText = '';

  const contentType = c.req.header('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await c.req.json<{ csv?: string; rows?: any[] }>();
    if (body.csv) {
      rawText = body.csv;
    } else if (Array.isArray(body.rows)) {
      return handleAcademicParsedRows(db, body.rows, c);
    }
  } else {
    rawText = await c.req.text();
  }

  if (!rawText.trim()) return c.json({ detail: 'الملف أو النص فارغ' }, 400);

  if (rawText.charCodeAt(0) === 0xFEFF) {
    rawText = rawText.slice(1);
  }

  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return c.json({ detail: 'لا توجد بيانات للاستيراد' }, 400);

  const firstLine = lines[0];
  const isHeader = firstLine.includes('جامعة') || firstLine.includes('university') || firstLine.includes('الكلية') || firstLine.includes('college');
  const dataLines = isHeader ? lines.slice(1) : lines;

  const rowsToImport = dataLines.map((line) => {
    const cols = parseCsvLine(line);
    return {
      university: cols[0] || '',
      college: cols[1] || '',
      system_type: cols[2] || 'traditional',
      stage: cols[3] || '',
      subject: cols[4] || '',
      term: cols[5] || 'annual',
      is_ministerial: cols[6] === '1' || cols[6] === 'true' || cols[6] === 'نعم' || cols[6] === 'وزاري',
      has_practical: cols[7] === '1' || cols[7] === 'true' || cols[7] === 'نعم' || cols[7] === 'عملي',
      province: cols[8] || null,
      university_type: cols[9] === 'أهلي' || cols[9] === 'private' ? 'private' : 'government',
    };
  });

  return handleAcademicParsedRows(db, rowsToImport, c);
});

adminRouter.get('/academic/export-csv', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const unis = await db.select().from(schema.universities);
  const cols = await db.select().from(schema.colleges);
  const progs = await db.select().from(schema.collegePrograms);
  const stages = await db.select().from(schema.stages);
  const subjects = await db.select().from(schema.subjects).where(eq(schema.subjects.is_deleted, false));

  const uniMap = new Map(unis.map((u) => [u.id, u]));
  const colMap = new Map(cols.map((cl) => [cl.id, cl]));
  const progMap = new Map(progs.map((p) => [p.id, p]));
  const stageMap = new Map(stages.map((st) => [st.id, st]));

  const header = '\uFEFF' + [
    'الجامعة',
    'نوع الجامعة',
    'المحافظة',
    'الكلية',
    'رمز الكلية',
    'النظام الدراسي',
    'المرحلة',
    'رقم المرحلة',
    'المادة',
    'رمز المادة',
    'الترم',
    'وزاري تقويمي',
    'عملي سريري',
  ].map(escapeCsv).join(',') + '\r\n';

  const rows: string[] = [];

  for (const sub of subjects) {
    const stg = stageMap.get(sub.stage_id);
    const prog = stg?.program_id ? progMap.get(stg.program_id) : null;
    const uni = (prog?.university_id ? uniMap.get(prog.university_id) : null) || (stg?.university_id ? uniMap.get(stg.university_id) : null);
    const col = (prog?.college_id ? colMap.get(prog.college_id) : null) || (stg?.college_id ? colMap.get(stg.college_id) : null);

    const termAr = sub.term === 'semester_1' ? 'كورس أول' : sub.term === 'semester_2' ? 'كورس ثاني' : sub.term === 'modular_block' ? 'موديول' : 'سنوي';
    const sysAr = prog?.system_type === 'modular' ? 'نظام موديولات' : 'نظام فصلي/سنوي';
    const uniTypeAr = uni?.type === 'private' ? 'أهلي' : 'حكومي';

    rows.push([
      uni?.name ?? '—',
      uniTypeAr,
      uni?.province ?? '—',
      col?.name ?? '—',
      col?.code ?? '—',
      sysAr,
      stg?.name ?? '—',
      stg?.stage_number ?? '—',
      sub.name,
      sub.code ?? '—',
      termAr,
      sub.is_ministerial ? 'نعم' : 'لا',
      sub.has_practical ? 'نعم' : 'لا',
    ].map(escapeCsv).join(','));
  }

  const csv = header + rows.join('\r\n');
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="academic-hierarchy.csv"',
      'Cache-Control': 'no-store',
    },
  });
});

// ─────────────────────── Questions CRUD ──────────────────────────────────────
adminRouter.get('/questions', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const subjectId = c.req.query('subject_id') ?? '';
  const questions = await db.select().from(schema.questions).where(
    and(eq(schema.questions.subject_id, subjectId), eq(schema.questions.is_deleted, false))
  );
  const result = await Promise.all(questions.map(async (q) => {
    const choices = await db.select().from(schema.choices).where(eq(schema.choices.question_id, q.id));
    return { ...q, choices };
  }));
  return c.json(result);
});

adminRouter.post('/questions', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{
    subject_id: string; text: string; eyebrow?: string; rationale?: string; image_url?: string;
    choices: Array<{ text: string; is_correct: boolean }>;
  }>();

  const subject = await db.select().from(schema.subjects).where(eq(schema.subjects.id, body.subject_id)).get();
  if (!subject) return c.json({ detail: 'المادة غير موجودة' }, 404);
  if (body.choices.length < 2) return c.json({ detail: 'يجب إضافة خيارين على الأقل' }, 400);
  if (!body.choices.some((c) => c.is_correct)) return c.json({ detail: 'يجب تحديد إجابة صحيحة واحدة على الأقل' }, 400);

  const qId = schema.genId();
  await db.insert(schema.questions).values({ id: qId, subject_id: body.subject_id, text: body.text, eyebrow: body.eyebrow, rationale: body.rationale, image_url: body.image_url, is_deleted: false });
  for (let i = 0; i < body.choices.length; i++) {
    await db.insert(schema.choices).values({ id: schema.genId(), question_id: qId, text: body.choices[i].text, is_correct: body.choices[i].is_correct, order_index: i });
  }

  const q = await db.select().from(schema.questions).where(eq(schema.questions.id, qId)).get();
  const choices = await db.select().from(schema.choices).where(eq(schema.choices.question_id, qId));
  return c.json({ ...q, choices });
});

adminRouter.put('/questions/:qid', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const qId = c.req.param('qid');
  const body = await c.req.json<{
    subject_id: string; text: string; eyebrow?: string; rationale?: string; image_url?: string;
    choices: Array<{ text: string; is_correct: boolean }>;
  }>();

  const q = await db.select().from(schema.questions).where(eq(schema.questions.id, qId)).get();
  if (!q) return c.json({ detail: 'السؤال غير موجود' }, 404);
  if (body.choices.length < 2) return c.json({ detail: 'يجب إضافة خيارين على الأقل' }, 400);
  if (!body.choices.some((c) => c.is_correct)) return c.json({ detail: 'يجب تحديد إجابة صحيحة واحدة على الأقل' }, 400);

  await db.update(schema.questions).set({ text: body.text, eyebrow: body.eyebrow, rationale: body.rationale, image_url: body.image_url, subject_id: body.subject_id }).where(eq(schema.questions.id, qId));
  await db.delete(schema.choices).where(eq(schema.choices.question_id, qId));
  for (let i = 0; i < body.choices.length; i++) {
    await db.insert(schema.choices).values({ id: schema.genId(), question_id: qId, text: body.choices[i].text, is_correct: body.choices[i].is_correct, order_index: i });
  }

  const updated = await db.select().from(schema.questions).where(eq(schema.questions.id, qId)).get();
  const choices = await db.select().from(schema.choices).where(eq(schema.choices.question_id, qId));
  return c.json({ ...updated, choices });
});

adminRouter.delete('/questions/:qid', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const qId = c.req.param('qid');
  const q = await db.select().from(schema.questions).where(eq(schema.questions.id, qId)).get();
  if (!q) return c.json({ detail: 'السؤال غير موجود' }, 404);

  // Soft delete question
  await db.update(schema.questions).set({
    is_deleted: true,
    deleted_at: new Date().toISOString(),
  }).where(eq(schema.questions.id, qId));

  recordAuditEvent({
    event: 'ADMIN_QUESTION_SOFT_DELETED',
    status: 'SUCCESS',
    actorId: c.get('user')?.id,
    targetId: qId,
  });

  return c.json({ ok: true });
});

// ─────────────────────── Weak topics ────────────────────────────────────────
adminRouter.get('/weak-topics', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const limit = Math.min(parseInt(c.req.query('limit') ?? '5'), 50);
  const answers = await db.select().from(schema.studentAnswers);
  const qIds = [...new Set(answers.map((a) => a.question_id))];
  if (qIds.length === 0) return c.json([]);

  const questions = await db.select().from(schema.questions).where(inArray(schema.questions.id, qIds));
  const subjectMap: Record<string, string> = {};
  questions.forEach((q) => { if (q.subject_id) subjectMap[q.id] = q.subject_id; });

  const subjects = await db.select().from(schema.subjects).where(inArray(schema.subjects.id, [...new Set(Object.values(subjectMap))]));
  const subjectNames: Record<string, string> = {};
  subjects.forEach((s) => { subjectNames[s.id] = s.name; });

  const byTopic: Record<string, boolean[]> = {};
  for (const answer of answers) {
    const q = questions.find((q) => q.id === answer.question_id);
    const topic = q?.eyebrow || (q?.subject_id ? subjectNames[q.subject_id] : null) || 'unknown';
    byTopic[topic] ??= [];
    byTopic[topic].push(!!answer.is_correct);
  }

  const result = Object.entries(byTopic).map(([topic, results]) => ({
    topic,
    weakness_pct: Math.round(100 - 100 * results.filter(Boolean).length / results.length),
    sample_size: results.length,
  }));
  result.sort((a, b) => b.weakness_pct - a.weakness_pct);
  return c.json(result.slice(0, limit));
});

// ─────────────────────── Students (admin view) ───────────────────────────────
adminRouter.get('/students', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const students = await db.select().from(schema.users).where(eq(schema.users.role, 'student'));
  const out = await Promise.all(students.map(async (s) => {
    const answers = await db.select().from(schema.studentAnswers).where(eq(schema.studentAnswers.user_id, s.id));
    const avg = answers.length ? Math.round(100 * answers.filter((a) => a.is_correct).length / answers.length) : null;
    let universityName = '—';
    if (s.university_id) {
      const uni = await db.select().from(schema.universities).where(eq(schema.universities.id, s.university_id)).get();
      universityName = uni?.name ?? '—';
    }
    let stageName = '—';
    if (s.stage_id) {
      const stage = await db.select().from(schema.stages).where(eq(schema.stages.id, s.stage_id)).get();
      stageName = stage?.name ?? '—';
    }
    return { id: s.id, name: s.full_name, email: s.email, university: universityName, stage: stageName, is_banned: s.is_banned, avg_score: avg, answered_count: answers.length };
  }));
  return c.json(out);
});

// ─────────────────────── Media upload ────────────────────────────────────────
adminRouter.post('/media/upload', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const adminUser = c.get('user')!;
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  if (!file) return c.json({ detail: 'الملف مطلوب' }, 400);

  const contents = await file.arrayBuffer();
  if (contents.byteLength > MAX_UPLOAD_BYTES) return c.json({ detail: 'الملف أكبر من الحد المسموح (20 ميغابايت)' }, 400);

  const allExts = [...IMAGE_EXTS, ...PDF_EXTS, ...VIDEO_EXTS];
  const sig = validateFileSignature(contents, allExts);
  if (!sig.valid) {
    return c.json({ detail: 'توقيع الملف أو نوعه الداخلي غير صالح' }, 400);
  }

  const storage = createStorageService(c.env.R2_BUCKET);
  const storedName = safeUploadName(file.name, allExts, 'file');
  await storage.save(storedName, contents, file.type || 'application/octet-stream');

  const url = mediaUrl(storedName);
  try {
    await db.insert(schema.mediaFiles).values({
      id: schema.genId(),
      filename: storedName,
      url,
      content_type: file.type || 'application/octet-stream',
      size_bytes: contents.byteLength,
      uploaded_by: adminUser.id,
      is_deleted: false,
    });
  } catch (_) {}

  return c.json({ url, stored_name: storedName });
});

// ─────────────────────── Store Products & Orders ─────────────────────────────
adminRouter.get('/store/products', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  return c.json(await db.select().from(schema.products));
});

adminRouter.post('/store/products', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{ name: string; price: number; type: string; is_activation_code?: boolean; grants_subject_id?: string }>();
  if (!['digital', 'physical'].includes(body.type)) return c.json({ detail: 'نوع المنتج غير صالح' }, 400);
  const id = schema.genId();
  await db.insert(schema.products).values({ id, name: body.name.trim(), price: body.price, type: body.type as 'digital' | 'physical' | 'course', is_activation_code: body.is_activation_code ?? false, grants_subject_id: body.grants_subject_id });
  return c.json(await db.select().from(schema.products).where(eq(schema.products.id, id)).get());
});

adminRouter.put('/store/products/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const body = await c.req.json<{ name: string; price: number; type: string; is_activation_code?: boolean; grants_subject_id?: string }>();
  const product = await db.select().from(schema.products).where(eq(schema.products.id, id)).get();
  if (!product) return c.json({ detail: 'المنتج غير موجود' }, 404);
  await db.update(schema.products).set({ name: body.name.trim(), price: body.price, type: body.type as 'digital' | 'physical' | 'course', is_activation_code: body.is_activation_code ?? false, grants_subject_id: body.grants_subject_id }).where(eq(schema.products.id, id));
  return c.json(await db.select().from(schema.products).where(eq(schema.products.id, id)).get());
});

adminRouter.delete('/store/products/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const product = await db.select().from(schema.products).where(eq(schema.products.id, id)).get();
  if (!product) return c.json({ detail: 'المنتج غير موجود' }, 404);
  const items = await db.select().from(schema.orderItems).where(eq(schema.orderItems.product_id, id));
  if (items.length) return c.json({ detail: 'لا يمكن حذف منتج له طلبات مسجّلة' }, 400);
  await db.delete(schema.products).where(eq(schema.products.id, id));
  return c.json({ ok: true });
});

adminRouter.get('/store/orders', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const orders = await db.select().from(schema.orders).orderBy(desc(schema.orders.created_at));
  const out = await Promise.all(orders.map(async (o) => {
    const buyer = await db.select().from(schema.users).where(eq(schema.users.id, o.user_id)).get();
    const items = await db.select().from(schema.orderItems).where(eq(schema.orderItems.order_id, o.id));
    const itemDetails = await Promise.all(items.map(async (item) => {
      const product = item.product_id ? await db.select().from(schema.products).where(eq(schema.products.id, item.product_id)).get() : null;
      return { product_name: product?.name ?? 'منتج محذوف', qty: item.qty, price: item.price };
    }));
    return {
      id: o.id, buyer_name: buyer?.full_name ?? '—', buyer_email: buyer?.email ?? '—',
      total: o.total, status: o.status, payment_method: o.payment_method, created_at: o.created_at,
      delivery_name: o.delivery_name, delivery_phone: o.delivery_phone, delivery_address: o.delivery_address,
      items: itemDetails,
    };
  }));
  return c.json(out);
});

adminRouter.put('/store/orders/:order_id/status', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const orderId = c.req.param('order_id');
  const status = c.req.query('status') ?? '';
  const validStatuses = new Set(['pending', 'paid', 'fulfilled', 'cancelled']);
  if (!validStatuses.has(status)) return c.json({ detail: 'حالة غير صالحة' }, 400);

  const order = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get();
  if (!order) return c.json({ detail: 'الطلب غير موجود' }, 404);

  await db.update(schema.orders).set({ status: status as 'pending' | 'paid' | 'fulfilled' | 'cancelled' }).where(eq(schema.orders.id, orderId));

  // Issue activation codes if paid/fulfilled
  let granted: string[] = [];
  if (['paid', 'fulfilled'].includes(status)) {
    const alreadyIssued = await db.select().from(schema.activationCodes).where(eq(schema.activationCodes.order_id, orderId)).get();
    if (!alreadyIssued) {
      const items = await db.select().from(schema.orderItems).where(eq(schema.orderItems.order_id, orderId));
      for (const item of items) {
        const product = item.product_id ? await db.select().from(schema.products).where(eq(schema.products.id, item.product_id)).get() : null;
        if (!product?.is_activation_code) continue;
        for (let i = 0; i < item.qty; i++) {
          const hex = Array.from(crypto.getRandomValues(new Uint8Array(3))).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
          const code = `NBD-${hex}`;
          const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
          await db.insert(schema.activationCodes).values({
            id: schema.genId(), code, subject_id: product.grants_subject_id, status: 'active',
            activated_by_user_id: order.user_id, activated_at: new Date().toISOString(), expires_at: expiresAt, order_id: orderId,
          });
          granted.push(code);
        }
      }
    }
  }

  return c.json({ ok: true, granted_activation_codes: granted });
});

// ─────────────────────── Notifications ───────────────────────────────────────
adminRouter.get('/notifications', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const notifs = await db.select().from(schema.notifications).orderBy(desc(schema.notifications.created_at));
  return c.json(notifs.slice(0, 50).map((n) => ({
    id: n.id, title: n.title, body: n.body, created_at: n.created_at, user_id: n.user_id, broadcast: n.user_id === null,
  })));
});

adminRouter.post('/notifications', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const adminUser = c.get('user')!;
  const body = await c.req.json<{ title: string; body: string; user_id?: string }>();

  if (body.user_id) {
    const target = await db.select().from(schema.users).where(eq(schema.users.id, body.user_id)).get();
    if (!target) return c.json({ detail: 'المستخدم غير موجود' }, 404);
  }

  const id = schema.genId();
  await db.insert(schema.notifications).values({ id, title: body.title.trim(), body: body.body.trim(), user_id: body.user_id ?? null });
  const n = await db.select().from(schema.notifications).where(eq(schema.notifications.id, id)).get();
  return c.json({ id: n!.id, title: n!.title, body: n!.body, created_at: n!.created_at });
});

// ─────────────────────── Clinical Pearls (admin CRUD) ────────────────────────
adminRouter.get('/pearls', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const pearls = await db.select().from(schema.clinicalPearls).orderBy(desc(schema.clinicalPearls.created_at));
  return c.json(pearls);
});

adminRouter.post('/pearls', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const adminUser = c.get('user')!;
  const body = await c.req.json<{ title: string; tag?: string; body: string }>();
  if (!body.title?.trim()) return c.json({ detail: 'العنوان مطلوب' }, 400);
  const id = schema.genId();
  await db.insert(schema.clinicalPearls).values({ id, title: body.title.trim(), tag: body.tag?.trim() ?? '', body: body.body.trim(), created_by: adminUser.id });
  return c.json(await db.select().from(schema.clinicalPearls).where(eq(schema.clinicalPearls.id, id)).get());
});

adminRouter.put('/pearls/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const body = await c.req.json<{ title: string; tag?: string; body: string }>();
  const pearl = await db.select().from(schema.clinicalPearls).where(eq(schema.clinicalPearls.id, id)).get();
  if (!pearl) return c.json({ detail: 'اللمحة غير موجودة' }, 404);
  if (!body.title?.trim()) return c.json({ detail: 'العنوان مطلوب' }, 400);
  await db.update(schema.clinicalPearls).set({ title: body.title.trim(), tag: body.tag?.trim() ?? '', body: body.body.trim() }).where(eq(schema.clinicalPearls.id, id));
  return c.json(await db.select().from(schema.clinicalPearls).where(eq(schema.clinicalPearls.id, id)).get());
});

adminRouter.delete('/pearls/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const pearl = await db.select().from(schema.clinicalPearls).where(eq(schema.clinicalPearls.id, id)).get();
  if (!pearl) return c.json({ detail: 'اللمحة غير موجودة' }, 404);
  await db.delete(schema.clinicalPearls).where(eq(schema.clinicalPearls.id, id));
  return c.json({ ok: true });
});

// ─────────────────────── CSV Helpers ─────────────────────────────────────────
function escapeCsv(val: any): string {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

// ─────────────────────── Bulk Question Import (A5) ───────────────────────────
adminRouter.post('/questions/import/preview', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{
    subject_id: string;
    questions: Array<{
      text: string;
      eyebrow?: string;
      rationale?: string;
      image_url?: string;
      choices: Array<{ text: string; is_correct: boolean }>;
    }>;
  }>();

  if (!body.subject_id) return c.json({ detail: 'المادة مطلوبة' }, 400);
  const subject = await db.select().from(schema.subjects).where(
    and(eq(schema.subjects.id, body.subject_id), eq(schema.subjects.is_deleted, false))
  ).get();
  if (!subject) return c.json({ detail: 'المادة غير موجودة أو محذوفة' }, 404);

  if (!Array.isArray(body.questions) || !body.questions.length) {
    return c.json({ detail: 'قائمة الأسئلة فارغة' }, 400);
  }
  if (body.questions.length > 500) {
    return c.json({ detail: 'الحد الأقصى للاستيراد في الدفعة الواحدة هو 500 سؤال' }, 400);
  }

  // Fetch existing questions in subject to detect duplicates
  const existing = await db.select({ id: schema.questions.id, text: schema.questions.text })
    .from(schema.questions)
    .where(and(eq(schema.questions.subject_id, body.subject_id), eq(schema.questions.is_deleted, false)));

  const existingMap = new Map<string, string>();
  for (const q of existing) {
    existingMap.set(q.text.trim().toLowerCase(), q.id);
  }

  const items = body.questions.map((q, idx) => {
    const errors: string[] = [];
    const text = (q.text || '').trim();
    if (text.length < 3) errors.push('نص السؤال قصير جداً (أقل من 3 أحرف)');
    if (text.length > 2000) errors.push('نص السؤال طويل جداً (أكثر من 2000 حرف)');

    const choices = Array.isArray(q.choices) ? q.choices : [];
    if (choices.length < 2) errors.push('يجب إضافة خيارين على الأقل');
    if (choices.length > 8) errors.push('الحد الأقصى للخيارات هو 8');
    if (!choices.some((ch) => ch.is_correct)) errors.push('يجب تحديد إجابة صحيحة واحدة على الأقل');

    const duplicateOfId = existingMap.get(text.toLowerCase()) || null;

    return {
      index: idx + 1,
      text,
      eyebrow: q.eyebrow?.trim() || null,
      rationale: q.rationale?.trim() || null,
      image_url: q.image_url?.trim() || null,
      choices_count: choices.length,
      is_valid: errors.length === 0,
      is_duplicate: duplicateOfId !== null,
      duplicate_of_id: duplicateOfId,
      errors,
    };
  });

  const validCount = items.filter((i) => i.is_valid && !i.is_duplicate).length;
  const duplicateCount = items.filter((i) => i.is_duplicate).length;
  const errorCount = items.filter((i) => !i.is_valid).length;

  return c.json({
    summary: {
      total: items.length,
      valid: validCount,
      duplicates: duplicateCount,
      errors: errorCount,
    },
    items,
  });
});

adminRouter.post('/questions/import/commit', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const adminUser = c.get('user')!;
  const body = await c.req.json<{
    subject_id: string;
    questions: Array<{
      text: string;
      eyebrow?: string;
      rationale?: string;
      image_url?: string;
      choices: Array<{ text: string; is_correct: boolean }>;
    }>;
    on_duplicate?: 'skip' | 'replace' | 'keep_both';
  }>();

  if (!body.subject_id) return c.json({ detail: 'المادة مطلوبة' }, 400);
  const subject = await db.select().from(schema.subjects).where(
    and(eq(schema.subjects.id, body.subject_id), eq(schema.subjects.is_deleted, false))
  ).get();
  if (!subject) return c.json({ detail: 'المادة غير موجودة أو محذوفة' }, 404);

  const onDuplicate = body.on_duplicate ?? 'skip';

  const existing = await db.select({ id: schema.questions.id, text: schema.questions.text })
    .from(schema.questions)
    .where(and(eq(schema.questions.subject_id, body.subject_id), eq(schema.questions.is_deleted, false)));

  const existingMap = new Map<string, string>();
  for (const q of existing) {
    existingMap.set(q.text.trim().toLowerCase(), q.id);
  }

  let imported = 0;
  let replaced = 0;
  let skipped = 0;

  for (const q of body.questions) {
    const text = (q.text || '').trim();
    const choices = Array.isArray(q.choices) ? q.choices : [];
    if (text.length < 3 || choices.length < 2 || !choices.some((ch) => ch.is_correct)) {
      skipped++;
      continue;
    }

    const dupId = existingMap.get(text.toLowerCase());
    if (dupId) {
      if (onDuplicate === 'skip') {
        skipped++;
        continue;
      } else if (onDuplicate === 'replace') {
        await db.update(schema.questions).set({
          eyebrow: q.eyebrow?.trim() || '',
          rationale: q.rationale?.trim() || '',
          image_url: q.image_url?.trim() || null,
        }).where(eq(schema.questions.id, dupId));

        await db.delete(schema.choices).where(eq(schema.choices.question_id, dupId));
        for (let i = 0; i < choices.length; i++) {
          await db.insert(schema.choices).values({
            id: schema.genId(),
            question_id: dupId,
            text: choices[i].text.trim(),
            is_correct: choices[i].is_correct,
            order_index: i,
          });
        }
        replaced++;
        continue;
      }
    }

    // Insert new question
    const qId = schema.genId();
    await db.insert(schema.questions).values({
      id: qId,
      subject_id: body.subject_id,
      text,
      eyebrow: q.eyebrow?.trim() || '',
      rationale: q.rationale?.trim() || '',
      image_url: q.image_url?.trim() || null,
      is_deleted: false,
    });

    for (let i = 0; i < choices.length; i++) {
      await db.insert(schema.choices).values({
        id: schema.genId(),
        question_id: qId,
        text: choices[i].text.trim(),
        is_correct: choices[i].is_correct,
        order_index: i,
      });
    }
    existingMap.set(text.toLowerCase(), qId);
    imported++;
  }

  recordAuditEvent({
    event: 'ADMIN_QUESTIONS_IMPORTED',
    status: 'SUCCESS',
    actorId: adminUser.id,
    targetId: body.subject_id,
    details: { imported, replaced, skipped },
  });

  return c.json({ ok: true, imported, replaced, skipped });
});

// ─────────────────────── Scoped Exports (A6) ─────────────────────────────────
adminRouter.get('/export/questions', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const subjectId = c.req.query('subject_id');

  const questions = subjectId
    ? await db.select().from(schema.questions).where(and(eq(schema.questions.subject_id, subjectId), eq(schema.questions.is_deleted, false)))
    : await db.select().from(schema.questions).where(eq(schema.questions.is_deleted, false));

  const subjects = await db.select().from(schema.subjects);
  const subjectMap = new Map(subjects.map((s) => [s.id, s.name]));

  const header = '\uFEFF' + ['المعرف', 'المادة', 'نص السؤال', 'التصنيف', 'الشرح', 'الخيارات', 'الإجابة الصحيحة'].map(escapeCsv).join(',') + '\r\n';

  const rows = await Promise.all(questions.map(async (q) => {
    const choices = await db.select().from(schema.choices).where(eq(schema.choices.question_id, q.id));
    const choicesStr = choices.map((ch, idx) => `${idx + 1}. ${ch.text}`).join(' | ');
    const correctStr = choices.filter((ch) => ch.is_correct).map((ch) => ch.text).join(' | ');
    const subName = q.subject_id ? (subjectMap.get(q.subject_id) ?? '—') : '—';
    return [q.id, subName, q.text, q.eyebrow ?? '', q.rationale ?? '', choicesStr, correctStr].map(escapeCsv).join(',');
  }));

  const csv = header + rows.join('\r\n');
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="questions-export.csv"',
      'Cache-Control': 'no-store',
    },
  });
});

adminRouter.get('/export/exam-results/:exam_id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const examId = c.req.param('exam_id');
  const exam = await db.select().from(schema.exams).where(eq(schema.exams.id, examId)).get();
  if (!exam) return c.json({ detail: 'الامتحان غير موجود' }, 404);

  const attempts = await db.select().from(schema.examAttempts).where(eq(schema.examAttempts.exam_id, examId));
  const users = await db.select().from(schema.users);
  const userMap = new Map(users.map((u) => [u.id, u]));

  const unis = await db.select().from(schema.universities);
  const uniMap = new Map(unis.map((u) => [u.id, u.name]));
  const stages = await db.select().from(schema.stages);
  const stageMap = new Map(stages.map((s) => [s.id, s.name]));

  const header = '\uFEFF' + ['معرف المحاولة', 'اسم الطالب', 'البريد الإلكتروني', 'الجامعة', 'المرحلة', 'الدرجة', 'النسبة المئوية', 'تاريخ البدء', 'تاريخ الإكمال'].map(escapeCsv).join(',') + '\r\n';

  const rows = attempts.map((att) => {
    const student = userMap.get(att.user_id);
    const uniName = student?.university_id ? (uniMap.get(student.university_id) ?? '—') : '—';
    const stageName = student?.stage_id ? (stageMap.get(student.stage_id) ?? '—') : '—';
    const pct = att.total > 0 ? `${Math.round((att.score / att.total) * 100)}%` : '—';
    return [
      att.id,
      student?.full_name ?? '—',
      student?.email ?? '—',
      uniName,
      stageName,
      att.score ?? '—',
      pct,
      att.started_at ?? '—',
      att.finished_at ?? '—',
    ].map(escapeCsv).join(',');
  });

  const csv = header + rows.join('\r\n');
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="exam-${examId}-results.csv"`,
      'Cache-Control': 'no-store',
    },
  });
});

// ─────────────────────── Admin Account Events View (A4 / A7) ─────────────────
adminRouter.get('/account-events', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 100);
  const offset = parseInt(c.req.query('offset') ?? '0');
  const userId = c.req.query('user_id');
  const eventType = c.req.query('event_type');

  const events = await db.select().from(schema.accountEvents).orderBy(desc(schema.accountEvents.created_at)).limit(limit).offset(offset);

  const filtered = events.filter((e) => {
    if (userId && e.user_id !== userId) return false;
    if (eventType && e.event_type !== eventType) return false;
    return true;
  });

  const users = await db.select().from(schema.users);
  const userMap = new Map(users.map((u) => [u.id, u]));

  const out = filtered.map((e) => {
    const user = e.user_id ? userMap.get(e.user_id) : null;
    return {
      id: e.id,
      user_id: e.user_id,
      user_name: user?.full_name ?? '—',
      user_email: user?.email ?? '—',
      event_type: e.event_type,
      outcome: e.outcome,
      ip_hash: e.ip_hash,
      device_hash: e.device_hash,
      created_at: e.created_at,
      details: e.details_json ? JSON.parse(e.details_json) : null,
    };
  });

  return c.json({ total: out.length, events: out });
});

// ─────────────────────── Academic Change Requests (B1) ───────────────────────
adminRouter.get('/academic-change-requests', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const status = c.req.query('status');

  const allRequests = await db.select().from(schema.academicChangeRequests).orderBy(desc(schema.academicChangeRequests.created_at));
  const filtered = status ? allRequests.filter((r) => r.status === status) : allRequests;

  const users = await db.select().from(schema.users);
  const userMap = new Map(users.map((u) => [u.id, u]));

  const unis = await db.select().from(schema.universities);
  const uniMap = new Map(unis.map((u) => [u.id, u.name]));

  const stages = await db.select().from(schema.stages);
  const stageMap = new Map(stages.map((s) => [s.id, s.name]));

  const out = filtered.map((r) => {
    const student = userMap.get(r.user_id);
    const reviewer = r.reviewer_id ? userMap.get(r.reviewer_id) : null;
    return {
      id: r.id,
      user_id: r.user_id,
      student_name: student?.full_name ?? '—',
      student_email: student?.email ?? '—',
      current_university: r.current_university_id ? (uniMap.get(r.current_university_id) ?? '—') : '—',
      current_stage: r.current_stage_id ? (stageMap.get(r.current_stage_id) ?? '—') : '—',
      target_university: r.target_university_id ? (uniMap.get(r.target_university_id) ?? r.target_university_id) : '—',
      target_stage: r.target_stage_id ? (stageMap.get(r.target_stage_id) ?? r.target_stage_id) : '—',
      reason: r.reason,
      status: r.status,
      reviewer_name: reviewer?.full_name ?? null,
      reviewer_notes: r.reviewer_notes,
      reviewed_at: r.reviewed_at,
      created_at: r.created_at,
    };
  });

  return c.json(out);
});

adminRouter.post('/academic-change-requests/:id/review', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json<{ status: 'approved' | 'rejected'; notes?: string }>();

  if (!['approved', 'rejected'].includes(body.status)) {
    return c.json({ detail: 'حالة المراجعة غير صالحة' }, 400);
  }

  const reqRecord = await db.select().from(schema.academicChangeRequests).where(eq(schema.academicChangeRequests.id, id)).get();
  if (!reqRecord) return c.json({ detail: 'طلب التغيير غير موجود' }, 404);
  if (reqRecord.status !== 'pending') {
    return c.json({ detail: 'تمت مراجعة هذا الطلب مسبقاً' }, 409);
  }

  const now = new Date().toISOString();

  if (body.status === 'approved') {
    await db.update(schema.users).set({
      university_id: reqRecord.target_university_id,
      stage_id: reqRecord.target_stage_id,
    }).where(eq(schema.users.id, reqRecord.user_id));
  }

  await db.update(schema.academicChangeRequests).set({
    status: body.status,
    reviewer_id: adminUser.id,
    reviewer_notes: body.notes?.trim() || null,
    reviewed_at: now,
  }).where(eq(schema.academicChangeRequests.id, id));

  // Send notification to student
  const outcomeArabic = body.status === 'approved' ? 'تمت الموافقة على' : 'تم رفض';
  await db.insert(schema.notifications).values({
    id: schema.genId(),
    user_id: reqRecord.user_id,
    title: `طلب تغيير المسار الأكاديمي: ${outcomeArabic}`,
    body: body.notes ? `النتيجة: ${outcomeArabic} طلبك. ملاحظة المراجع: ${body.notes}` : `النتيجة: ${outcomeArabic} طلبك لتغيير المسار الأكاديمي.`,
  });

  recordAuditEvent({
    event: 'ADMIN_ACADEMIC_CHANGE_REVIEWED',
    status: 'SUCCESS',
    actorId: adminUser.id,
    targetId: id,
    details: { status: body.status, student_id: reqRecord.user_id },
  });

  return c.json({ ok: true, status: body.status });
});

// ─────────────────────── Academic Trash & Restore (B2) ───────────────────────
adminRouter.get('/trash', async (c) => {
  const db = drizzle(c.env.DB, { schema });

  const subjects = await db.select().from(schema.subjects).where(eq(schema.subjects.is_deleted, true));
  const courses = await db.select().from(schema.courses).where(eq(schema.courses.is_deleted, true));
  const questions = await db.select().from(schema.questions).where(eq(schema.questions.is_deleted, true));
  const media = await db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.is_deleted, true));

  return c.json({
    subjects: subjects.map((s) => ({ id: s.id, name: s.name, deleted_at: s.deleted_at })),
    courses: courses.map((co) => ({ id: co.id, title: co.title, deleted_at: co.deleted_at })),
    questions: questions.map((q) => ({ id: q.id, text: q.text, deleted_at: q.deleted_at })),
    media_files: media.map((m) => ({ id: m.id, filename: m.filename, url: m.url, deleted_at: m.deleted_at })),
  });
});

adminRouter.post('/trash/:type/:id/restore', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const adminUser = c.get('user')!;
  const type = c.req.param('type');
  const id = c.req.param('id');

  if (type === 'subject') {
    const subj = await db.select().from(schema.subjects).where(eq(schema.subjects.id, id)).get();
    if (!subj) return c.json({ detail: 'المادة غير موجودة' }, 404);
    await db.update(schema.subjects).set({ is_deleted: false, deleted_at: null }).where(eq(schema.subjects.id, id));
  } else if (type === 'question') {
    const q = await db.select().from(schema.questions).where(eq(schema.questions.id, id)).get();
    if (!q) return c.json({ detail: 'السؤال غير موجود' }, 404);
    await db.update(schema.questions).set({ is_deleted: false, deleted_at: null }).where(eq(schema.questions.id, id));
  } else if (type === 'course') {
    const co = await db.select().from(schema.courses).where(eq(schema.courses.id, id)).get();
    if (!co) return c.json({ detail: 'الكورس غير موجود' }, 404);
    await db.update(schema.courses).set({ is_deleted: false, deleted_at: null }).where(eq(schema.courses.id, id));
  } else if (type === 'media') {
    const m = await db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.id, id)).get();
    if (!m) return c.json({ detail: 'الملف غير موجود' }, 404);
    await db.update(schema.mediaFiles).set({ is_deleted: false, deleted_at: null }).where(eq(schema.mediaFiles.id, id));
  } else {
    return c.json({ detail: 'نوع غير صالح' }, 400);
  }

  recordAuditEvent({
    event: 'ADMIN_ITEM_RESTORED',
    status: 'SUCCESS',
    actorId: adminUser.id,
    targetId: id,
    details: { type },
  });

  return c.json({ ok: true, restored_type: type, id });
});

adminRouter.delete('/trash/:type/:id/purge', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const adminUser = c.get('user')!;
  const type = c.req.param('type');
  const id = c.req.param('id');

  if (type === 'subject') {
    await db.delete(schema.subjects).where(eq(schema.subjects.id, id));
  } else if (type === 'question') {
    await db.delete(schema.studentAnswers).where(eq(schema.studentAnswers.question_id, id));
    await db.delete(schema.choices).where(eq(schema.choices.question_id, id));
    await db.delete(schema.questions).where(eq(schema.questions.id, id));
  } else if (type === 'course') {
    await db.delete(schema.courses).where(eq(schema.courses.id, id));
  } else if (type === 'media') {
    const m = await db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.id, id)).get();
    if (m?.filename) {
      const storage = createStorageService(c.env.R2_BUCKET);
      await storage.delete(m.filename);
    }
    await db.delete(schema.mediaFiles).where(eq(schema.mediaFiles.id, id));
  } else {
    return c.json({ detail: 'نوع غير صالح' }, 400);
  }

  recordAuditEvent({
    event: 'ADMIN_ITEM_PURGED',
    status: 'SUCCESS',
    actorId: adminUser.id,
    targetId: id,
    details: { type },
  });

  return c.json({ ok: true, purged_type: type, id });
});

// ─────────────────────── Certificate Revocation (B6) ─────────────────────────
adminRouter.post('/certificates/:id/revoke', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json<{ reason: string }>();

  if (!body.reason?.trim()) return c.json({ detail: 'سبب الإلغاء مطلوب' }, 400);

  const cert = await db.select().from(schema.certificates).where(eq(schema.certificates.id, id)).get();
  if (!cert) return c.json({ detail: 'الشهادة غير موجودة' }, 404);

  await db.update(schema.certificates).set({
    is_revoked: true,
    revoked_at: new Date().toISOString(),
    revocation_reason: body.reason.trim(),
  }).where(eq(schema.certificates.id, id));

  recordAuditEvent({
    event: 'ADMIN_CERTIFICATE_REVOKED',
    status: 'SUCCESS',
    actorId: adminUser.id,
    targetId: id,
    details: { reason: body.reason.trim() },
  });

  return c.json({ ok: true, certificate_id: id, is_revoked: true });
});
