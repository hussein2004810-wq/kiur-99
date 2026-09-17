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
  stages.forEach((s) => { stagesByUni[s.university_id] ??= []; stagesByUni[s.university_id].push(s); });

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
