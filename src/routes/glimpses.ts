/**
 * Clinical Glimpses (اللمحات السريرية) Routes
 * Implements full governance workflow: draft -> in_review -> approved -> published.
 * Student feed, 3D card payloads, targets scoping, audit logs.
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and, or, isNull, lte, desc, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv, CurrentUser } from '../types';
import { requireAuth, requireRole } from '../middleware/auth';
import { recordAuditEvent } from '../services/audit';

export const glimpsesRouter = new Hono<AppEnv>();
export const adminGlimpsesRouter = new Hono<AppEnv>();

function responseError(code: string, message: string, status: 400 | 401 | 403 | 404 | 409 = 400) {
  return {
    status,
    body: {
      error: { code, message },
      detail: message,
    },
  };
}

// ============================================================================
// STUDENT FEED: GET /api/glimpses
// ============================================================================
glimpsesRouter.get('/', requireAuth, async (c) => {
  const user = c.get('user') as CurrentUser;
  const db = drizzle(c.env.DB, { schema });

  // Student feed: must be published, not soft-deleted, and publish_at <= now (or null)
  const now = new Date().toISOString();

  // Query published glimpses
  const rows = await db
    .select({
      id: schema.clinicalGlimpses.id,
      title: schema.clinicalGlimpses.title,
      summary: schema.clinicalGlimpses.summary,
      clinicalPoint: schema.clinicalGlimpses.clinical_point,
      warning: schema.clinicalGlimpses.warning,
      referenceText: schema.clinicalGlimpses.reference_text,
      publishAt: schema.clinicalGlimpses.publish_at,
      publishedAt: schema.clinicalGlimpses.published_at,
      imageId: schema.clinicalGlimpses.image_id,
      audienceAll: schema.clinicalGlimpses.audience_all,
      authorName: schema.users.full_name,
    })
    .from(schema.clinicalGlimpses)
    .leftJoin(schema.users, eq(schema.users.id, schema.clinicalGlimpses.created_by))
    .where(
      and(
        eq(schema.clinicalGlimpses.status, 'published'),
        isNull(schema.clinicalGlimpses.deleted_at),
        or(
          isNull(schema.clinicalGlimpses.publish_at),
          lte(schema.clinicalGlimpses.publish_at, now)
        )
      )
    )
    .orderBy(desc(schema.clinicalGlimpses.published_at))
    .limit(50);

  // Filter based on audience scope
  const filtered = [];
  for (const item of rows) {
    if (item.audienceAll) {
      filtered.push(item);
      continue;
    }

    // Check targets matching user's academic stage, college, department or university
    const targets = await db
      .select()
      .from(schema.clinicalGlimpseTargets)
      .where(eq(schema.clinicalGlimpseTargets.glimpse_id, item.id));

    const matched = targets.some((t) => {
      const matchUni = !t.university_id || t.university_id === user.university_id;
      const matchCollege = !t.college_id || t.college_id === user.college_id;
      const matchDept = !t.department_id || t.department_id === user.department_id;
      const matchStage =
        (!t.stage_id && !t.phase_id) ||
        t.stage_id === user.stage_id ||
        t.phase_id === user.stage_id;
      return matchUni && matchCollege && matchDept && matchStage;
    });

    if (matched) {
      filtered.push(item);
    }
  }

  // Cap at 30 items
  const data = filtered.slice(0, 30).map((r) => ({
    id: r.id,
    title: r.title,
    summary: r.summary,
    clinicalPoint: r.clinicalPoint,
    warning: r.warning ?? null,
    referenceText: r.referenceText ?? null,
    publishAt: r.publishAt ?? null,
    publishedAt: r.publishedAt ?? null,
    imageId: r.imageId ?? null,
    imageUrl: r.imageId ? `/api/media/${encodeURIComponent(r.imageId)}` : null,
    authorName: r.authorName ?? 'KIUR',
  }));

  return c.json({ data });
});

// ============================================================================
// ADMIN / STAFF ENDPOINTS: /api/admin/glimpses
// ============================================================================
adminGlimpsesRouter.use('*', requireRole('admin', 'professor'));

// Helper: check if glimpse exists
async function getGlimpseOr404(db: ReturnType<typeof drizzle>, id: string) {
  return await db
    .select()
    .from(schema.clinicalGlimpses)
    .where(eq(schema.clinicalGlimpses.id, id))
    .get();
}

// Log helper
async function logGlimpseAction(
  db: ReturnType<typeof drizzle>,
  glimpseId: string,
  action: schema.ClinicalGlimpseAction,
  userId: string,
  details: Record<string, unknown> = {}
) {
  await db.insert(schema.clinicalGlimpseLogs).values({
    glimpse_id: glimpseId,
    action,
    by_user_id: userId,
    details_json: JSON.stringify(details),
  });
}

// 1. GET /api/admin/glimpses/logs — MUST come before /:id routes
adminGlimpsesRouter.get('/logs', async (c) => {
  const user = c.get('user') as CurrentUser;
  const db = drizzle(c.env.DB, { schema });

  const logs = await db
    .select({
      id: schema.clinicalGlimpseLogs.id,
      glimpseId: schema.clinicalGlimpseLogs.glimpse_id,
      action: schema.clinicalGlimpseLogs.action,
      at: schema.clinicalGlimpseLogs.at,
      detailsJson: schema.clinicalGlimpseLogs.details_json,
      actorName: schema.users.full_name,
      title: schema.clinicalGlimpses.title,
    })
    .from(schema.clinicalGlimpseLogs)
    .leftJoin(schema.users, eq(schema.users.id, schema.clinicalGlimpseLogs.by_user_id))
    .leftJoin(schema.clinicalGlimpses, eq(schema.clinicalGlimpses.id, schema.clinicalGlimpseLogs.glimpse_id))
    .orderBy(desc(schema.clinicalGlimpseLogs.at))
    .limit(200);

  const data = logs.map((l) => ({
    id: l.id,
    glimpseId: l.glimpseId,
    action: l.action,
    at: l.at,
    actorName: l.actorName ?? 'النظام',
    title: l.title ?? l.glimpseId,
    details: l.detailsJson ? JSON.parse(l.detailsJson) : {},
  }));

  return c.json({ data });
});

// 2. GET /api/admin/glimpses — list glimpses within scope
adminGlimpsesRouter.get('/', async (c) => {
  const user = c.get('user') as CurrentUser;
  const db = drizzle(c.env.DB, { schema });

  const isOwner = user.role === 'admin';

  let query = db
    .select({
      id: schema.clinicalGlimpses.id,
      title: schema.clinicalGlimpses.title,
      summary: schema.clinicalGlimpses.summary,
      clinicalPoint: schema.clinicalGlimpses.clinical_point,
      warning: schema.clinicalGlimpses.warning,
      referenceText: schema.clinicalGlimpses.reference_text,
      publishAt: schema.clinicalGlimpses.publish_at,
      publishedAt: schema.clinicalGlimpses.published_at,
      status: schema.clinicalGlimpses.status,
      audienceAll: schema.clinicalGlimpses.audience_all,
      imageId: schema.clinicalGlimpses.image_id,
      createdBy: schema.clinicalGlimpses.created_by,
      updatedBy: schema.clinicalGlimpses.updated_by,
      deletedAt: schema.clinicalGlimpses.deleted_at,
      creatorName: schema.users.full_name,
    })
    .from(schema.clinicalGlimpses)
    .leftJoin(schema.users, eq(schema.users.id, schema.clinicalGlimpses.created_by))
    .orderBy(desc(schema.clinicalGlimpses.updated_at))
    .limit(300);

  const rows = await query;

  // Filter soft-deleted if not admin
  const visible = rows.filter((r) => isOwner || !r.deletedAt);

  const data = await Promise.all(
    visible.map(async (row) => {
      const targets = await db
        .select({
          universityId: schema.clinicalGlimpseTargets.university_id,
          collegeId: schema.clinicalGlimpseTargets.college_id,
          departmentId: schema.clinicalGlimpseTargets.department_id,
          phaseId: schema.clinicalGlimpseTargets.phase_id,
          stageId: schema.clinicalGlimpseTargets.stage_id,
        })
        .from(schema.clinicalGlimpseTargets)
        .where(eq(schema.clinicalGlimpseTargets.glimpse_id, row.id));

      return {
        ...row,
        audienceAll: Boolean(row.audienceAll),
        targets,
        imageUrl: row.imageId && !row.deletedAt ? `/api/media/${encodeURIComponent(row.imageId)}` : null,
      };
    })
  );

  return c.json({ data });
});

// 3. POST /api/admin/glimpses — create draft
adminGlimpsesRouter.post('/', async (c) => {
  const user = c.get('user') as CurrentUser;
  const db = drizzle(c.env.DB, { schema });

  const body = await c.req.json().catch(() => ({}));

  const title = String(body.title || '').trim();
  const summary = String(body.summary || '').trim();
  const clinicalPoint = String(body.clinicalPoint || body.clinical_point || '').trim();
  const warning = body.warning ? String(body.warning).trim() : null;
  const referenceText = body.referenceText ? String(body.referenceText).trim() : null;
  const publishAt = body.publishAt ? String(body.publishAt).trim() : null;
  const imageId = body.imageId ? String(body.imageId).trim() : null;
  const audienceAll = Boolean(body.audienceAll);
  const targets = Array.isArray(body.targets) ? body.targets : [];

  // Validation
  if (title.length < 3 || title.length > 160) {
    const err = responseError('VALIDATION', 'عنوان اللمحة يجب أن يكون بين 3 و160 حرفًا', 400);
    return c.json(err.body, err.status);
  }
  if (summary.length < 10 || summary.length > 1000) {
    const err = responseError('VALIDATION', 'الملخص يجب أن يكون بين 10 و1000 حرف', 400);
    return c.json(err.body, err.status);
  }
  if (clinicalPoint.length < 5) {
    const err = responseError('VALIDATION', 'النقطة السريرية مطلوبة (بحد أدنى 5 أحرف)', 400);
    return c.json(err.body, err.status);
  }
  if (publishAt && isNaN(Date.parse(publishAt))) {
    const err = responseError('VALIDATION', 'تاريخ النشر غير صالح', 400);
    return c.json(err.body, err.status);
  }

  // Check audienceAll permission
  if (audienceAll && user.role !== 'admin') {
    const err = responseError('FORBIDDEN', 'النشر للجميع يتطلب صلاحية إدارة اللمحات على مستوى المنصة', 403);
    return c.json(err.body, err.status);
  }

  if (!audienceAll && (!targets.length || targets.length > 50)) {
    const err = responseError('VALIDATION', 'أضف نطاقًا أكاديميًا واحدًا على الأقل (حتى 50 نطاقًا)', 400);
    return c.json(err.body, err.status);
  }

  // Check image exists if imageId provided
  if (imageId) {
    const img = await db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.id, imageId)).get();
    if (!img || img.is_deleted) {
      const err = responseError('FORBIDDEN', 'الصورة المختارة غير متاحة ضمن نطاق مكتبتك', 403);
      return c.json(err.body, err.status);
    }
  }

  const id = schema.genId();

  await db.insert(schema.clinicalGlimpses).values({
    id,
    title,
    summary,
    clinical_point: clinicalPoint,
    warning,
    reference_text: referenceText,
    publish_at: publishAt,
    image_id: imageId,
    status: 'draft',
    audience_all: audienceAll,
    created_by: user.id,
    updated_by: user.id,
  });

  if (!audienceAll && targets.length) {
    for (const t of targets) {
      await db.insert(schema.clinicalGlimpseTargets).values({
        id: schema.genId(),
        glimpse_id: id,
        university_id: t.universityId || t.university_id || null,
        college_id: t.collegeId || t.college_id || null,
        department_id: t.departmentId || t.department_id || null,
        phase_id: t.phaseId || t.phase_id || null,
        stage_id: t.stageId || t.stage_id || t.phaseId || null,
      });
    }
  }

  await logGlimpseAction(db, id, 'create', user.id, { audienceAll });

  recordAuditEvent({
    event: 'ADMIN_GLIMPSE_CREATED',
    actorId: user.id,
    targetId: id,
    status: 'SUCCESS',
    details: { type: 'clinical_glimpse', title },
  });

  return c.json({ id }, 201);
});

// 4. PATCH /api/admin/glimpses/:id — edit and reset to draft
adminGlimpsesRouter.patch('/:id', async (c) => {
  const user = c.get('user') as CurrentUser;
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');

  const glimpse = await getGlimpseOr404(db, id);
  if (!glimpse) {
    const err = responseError('NOT_FOUND', 'اللمحة غير موجودة', 404);
    return c.json(err.body, err.status);
  }

  if (glimpse.deleted_at) {
    const err = responseError('FORBIDDEN', 'لا يمكنك تعديل لمحة محذوفة', 403);
    return c.json(err.body, err.status);
  }

  // Professors can only edit their own glimpses unless admin
  if (user.role !== 'admin' && glimpse.created_by !== user.id) {
    const err = responseError('FORBIDDEN', 'لا تملك صلاحية تعديل هذه اللمحة', 403);
    return c.json(err.body, err.status);
  }

  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title ?? glimpse.title).trim();
  const summary = String(body.summary ?? glimpse.summary).trim();
  const clinicalPoint = String(body.clinicalPoint ?? body.clinical_point ?? glimpse.clinical_point).trim();
  const warning = body.warning !== undefined ? (body.warning ? String(body.warning).trim() : null) : glimpse.warning;
  const referenceText = body.referenceText !== undefined ? (body.referenceText ? String(body.referenceText).trim() : null) : glimpse.reference_text;
  const publishAt = body.publishAt !== undefined ? (body.publishAt ? String(body.publishAt).trim() : null) : glimpse.publish_at;
  const imageId = body.imageId !== undefined ? (body.imageId ? String(body.imageId).trim() : null) : glimpse.image_id;
  const audienceAll = body.audienceAll !== undefined ? Boolean(body.audienceAll) : Boolean(glimpse.audience_all);
  const targets = Array.isArray(body.targets) ? body.targets : null;

  if (title.length < 3 || title.length > 160) {
    const err = responseError('VALIDATION', 'عنوان اللمحة يجب أن يكون بين 3 و160 حرفًا', 400);
    return c.json(err.body, err.status);
  }
  if (summary.length < 10 || summary.length > 1000) {
    const err = responseError('VALIDATION', 'الملخص يجب أن يكون بين 10 و1000 حرف', 400);
    return c.json(err.body, err.status);
  }
  if (clinicalPoint.length < 5) {
    const err = responseError('VALIDATION', 'النقطة السريرية مطلوبة (بحد أدنى 5 أحرف)', 400);
    return c.json(err.body, err.status);
  }
  if (publishAt && isNaN(Date.parse(publishAt))) {
    const err = responseError('VALIDATION', 'تاريخ النشر غير صالح', 400);
    return c.json(err.body, err.status);
  }

  if (audienceAll && user.role !== 'admin') {
    const err = responseError('FORBIDDEN', 'النشر للجميع يتطلب صلاحية إدارة اللمحات على مستوى المنصة', 403);
    return c.json(err.body, err.status);
  }

  // Any edit resets to draft and clears approval/publish records
  await db
    .update(schema.clinicalGlimpses)
    .set({
      title,
      summary,
      clinical_point: clinicalPoint,
      warning,
      reference_text: referenceText,
      publish_at: publishAt,
      image_id: imageId,
      status: 'draft',
      audience_all: audienceAll,
      updated_by: user.id,
      updated_at: sql`(CURRENT_TIMESTAMP)`,
      reviewed_by: null,
      reviewed_at: null,
      approved_by: null,
      approved_at: null,
      published_by: null,
      published_at: null,
    })
    .where(eq(schema.clinicalGlimpses.id, id));

  if (targets !== null) {
    await db.delete(schema.clinicalGlimpseTargets).where(eq(schema.clinicalGlimpseTargets.glimpse_id, id));
    if (!audienceAll) {
      for (const t of targets) {
        await db.insert(schema.clinicalGlimpseTargets).values({
          id: schema.genId(),
          glimpse_id: id,
          university_id: t.universityId || t.university_id || null,
          college_id: t.collegeId || t.college_id || null,
          department_id: t.departmentId || t.department_id || null,
          phase_id: t.phaseId || t.phase_id || null,
          stage_id: t.stageId || t.stage_id || t.phaseId || null,
        });
      }
    }
  }

  await logGlimpseAction(db, id, 'update', user.id, { resetToDraft: true });

  return c.json({ updated: true, status: 'draft' });
});

// 5. POST /api/admin/glimpses/:id/submit-review
adminGlimpsesRouter.post('/:id/submit-review', async (c) => {
  const user = c.get('user') as CurrentUser;
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');

  const glimpse = await getGlimpseOr404(db, id);
  if (!glimpse) {
    const err = responseError('NOT_FOUND', 'اللمحة غير موجودة', 404);
    return c.json(err.body, err.status);
  }
  if (glimpse.deleted_at) {
    const err = responseError('NOT_FOUND', 'اللمحة محذوفة', 404);
    return c.json(err.body, err.status);
  }

  if (glimpse.status !== 'draft') {
    const err = responseError('INVALID_STATE', 'يجب أن تكون اللمحة مسودة لتسليمها للمراجعة', 409);
    return c.json(err.body, err.status);
  }

  // Ownership check: only creator professor or admin can submit review
  if (user.role !== 'admin' && glimpse.created_by !== user.id) {
    const err = responseError('FORBIDDEN', 'لا تملك صلاحية تسليم هذه اللمحة للمراجعة', 403);
    return c.json(err.body, err.status);
  }

  await db
    .update(schema.clinicalGlimpses)
    .set({
      status: 'in_review',
      reviewed_by: user.id,
      reviewed_at: sql`(CURRENT_TIMESTAMP)`,
      updated_by: user.id,
      updated_at: sql`(CURRENT_TIMESTAMP)`,
    })
    .where(and(
      eq(schema.clinicalGlimpses.id, id),
      eq(schema.clinicalGlimpses.status, 'draft'),
      user.role === 'admin' ? sql`1=1` : eq(schema.clinicalGlimpses.created_by, user.id)
    ));

  await logGlimpseAction(db, id, 'submit_review', user.id);

  return c.json({ status: 'in_review' });
});

// 6. POST /api/admin/glimpses/:id/return-draft
adminGlimpsesRouter.post('/:id/return-draft', async (c) => {
  const user = c.get('user') as CurrentUser;
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');

  const glimpse = await getGlimpseOr404(db, id);
  if (!glimpse) {
    const err = responseError('NOT_FOUND', 'اللمحة غير موجودة', 404);
    return c.json(err.body, err.status);
  }
  if (glimpse.deleted_at) {
    const err = responseError('NOT_FOUND', 'اللمحة محذوفة', 404);
    return c.json(err.body, err.status);
  }

  if (!['in_review', 'approved'].includes(glimpse.status)) {
    const err = responseError('INVALID_STATE', 'لا يمكن إرجاع اللمحة من حالتها الحالية', 409);
    return c.json(err.body, err.status);
  }

  // Ownership check: only creator professor or admin can return to draft
  if (user.role !== 'admin' && glimpse.created_by !== user.id) {
    const err = responseError('FORBIDDEN', 'لا تملك صلاحية إرجاع هذه اللمحة إلى مسودة', 403);
    return c.json(err.body, err.status);
  }

  await db
    .update(schema.clinicalGlimpses)
    .set({
      status: 'draft',
      approved_by: null,
      approved_at: null,
      updated_by: user.id,
      updated_at: sql`(CURRENT_TIMESTAMP)`,
    })
    .where(and(
      eq(schema.clinicalGlimpses.id, id),
      user.role === 'admin' ? sql`1=1` : eq(schema.clinicalGlimpses.created_by, user.id)
    ));

  await logGlimpseAction(db, id, 'return_draft', user.id);

  return c.json({ status: 'draft' });
});

// 7. POST /api/admin/glimpses/:id/approve
adminGlimpsesRouter.post('/:id/approve', async (c) => {
  const user = c.get('user') as CurrentUser;
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');

  if (user.role !== 'admin') {
    const err = responseError('FORBIDDEN', 'اعتماد اللمحات متاح لمالك المنصة فقط', 403);
    return c.json(err.body, err.status);
  }

  const glimpse = await getGlimpseOr404(db, id);
  if (!glimpse) {
    const err = responseError('NOT_FOUND', 'اللمحة غير موجودة', 404);
    return c.json(err.body, err.status);
  }
  if (glimpse.deleted_at) {
    const err = responseError('NOT_FOUND', 'اللمحة محذوفة', 404);
    return c.json(err.body, err.status);
  }

  if (glimpse.status !== 'in_review') {
    const err = responseError('INVALID_STATE', 'يجب إرسال اللمحة للمراجعة أولًا', 409);
    return c.json(err.body, err.status);
  }

  await db
    .update(schema.clinicalGlimpses)
    .set({
      status: 'approved',
      approved_by: user.id,
      approved_at: sql`(CURRENT_TIMESTAMP)`,
      updated_by: user.id,
      updated_at: sql`(CURRENT_TIMESTAMP)`,
    })
    .where(eq(schema.clinicalGlimpses.id, id));

  await logGlimpseAction(db, id, 'approve', user.id);

  return c.json({ status: 'approved' });
});

// 8. POST /api/admin/glimpses/:id/publish
adminGlimpsesRouter.post('/:id/publish', async (c) => {
  const user = c.get('user') as CurrentUser;
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');

  if (user.role !== 'admin') {
    const err = responseError('FORBIDDEN', 'نشر اللمحات متاح لمالك المنصة فقط', 403);
    return c.json(err.body, err.status);
  }

  const glimpse = await getGlimpseOr404(db, id);
  if (!glimpse) {
    const err = responseError('NOT_FOUND', 'اللمحة غير موجودة', 404);
    return c.json(err.body, err.status);
  }
  if (glimpse.deleted_at) {
    const err = responseError('NOT_FOUND', 'اللمحة محذوفة', 404);
    return c.json(err.body, err.status);
  }

  // Pre-mature publish is strictly rejected with 409
  if (glimpse.status !== 'approved') {
    const err = responseError('INVALID_STATE', 'يجب اعتماد اللمحة قبل نشرها', 409);
    return c.json(err.body, err.status);
  }

  await db
    .update(schema.clinicalGlimpses)
    .set({
      status: 'published',
      published_by: user.id,
      published_at: sql`(CURRENT_TIMESTAMP)`,
      updated_by: user.id,
      updated_at: sql`(CURRENT_TIMESTAMP)`,
    })
    .where(eq(schema.clinicalGlimpses.id, id));

  await logGlimpseAction(db, id, 'publish', user.id);

  recordAuditEvent({
    event: 'ADMIN_GLIMPSE_PUBLISHED',
    actorId: user.id,
    targetId: id,
    status: 'SUCCESS',
    details: { type: 'clinical_glimpse', title: glimpse.title },
  });

  return c.json({ status: 'published' });
});

// 9. POST /api/admin/glimpses/:id/archive (Soft-Delete)
adminGlimpsesRouter.post('/:id/archive', async (c) => {
  const user = c.get('user') as CurrentUser;
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');

  const glimpse = await getGlimpseOr404(db, id);
  if (!glimpse) {
    const err = responseError('NOT_FOUND', 'اللمحة غير موجودة', 404);
    return c.json(err.body, err.status);
  }

  // Ownership check: only creator professor or admin can archive
  if (user.role !== 'admin' && glimpse.created_by !== user.id) {
    const err = responseError('FORBIDDEN', 'لا تملك صلاحية أرشفة هذه اللمحة', 403);
    return c.json(err.body, err.status);
  }

  await db
    .update(schema.clinicalGlimpses)
    .set({
      status: 'archived',
      deleted_at: sql`(CURRENT_TIMESTAMP)`,
      deleted_by: user.id,
      updated_by: user.id,
      updated_at: sql`(CURRENT_TIMESTAMP)`,
    })
    .where(and(
      eq(schema.clinicalGlimpses.id, id),
      user.role === 'admin' ? sql`1=1` : eq(schema.clinicalGlimpses.created_by, user.id)
    ));

  await logGlimpseAction(db, id, 'archive', user.id);

  return c.json({ status: 'archived' });
});

// 10. POST /api/admin/glimpses/:id/restore
adminGlimpsesRouter.post('/:id/restore', async (c) => {
  const user = c.get('user') as CurrentUser;
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');

  if (user.role !== 'admin') {
    const err = responseError('FORBIDDEN', 'الاستعادة متاحة لمالك المنصة فقط', 403);
    return c.json(err.body, err.status);
  }

  const glimpse = await getGlimpseOr404(db, id);
  if (!glimpse) {
    const err = responseError('NOT_FOUND', 'اللمحة غير موجودة', 404);
    return c.json(err.body, err.status);
  }

  await db
    .update(schema.clinicalGlimpses)
    .set({
      deleted_at: null,
      deleted_by: null,
      status: 'draft',
      updated_by: user.id,
      updated_at: sql`(CURRENT_TIMESTAMP)`,
    })
    .where(eq(schema.clinicalGlimpses.id, id));

  await logGlimpseAction(db, id, 'restore', user.id);

  return c.json({ status: 'draft' });
});

// 11. POST /api/admin/glimpses/:id/delete-forever
adminGlimpsesRouter.post('/:id/delete-forever', async (c) => {
  const user = c.get('user') as CurrentUser;
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');

  if (user.role !== 'admin') {
    const err = responseError('FORBIDDEN', 'الحذف النهائي متاح لمالك المنصة فقط', 403);
    return c.json(err.body, err.status);
  }

  const glimpse = await getGlimpseOr404(db, id);
  if (!glimpse) {
    const err = responseError('NOT_FOUND', 'اللمحة غير موجودة', 404);
    return c.json(err.body, err.status);
  }

  await logGlimpseAction(db, id, 'delete_forever', user.id);

  await db.delete(schema.clinicalGlimpses).where(eq(schema.clinicalGlimpses.id, id));

  return new Response(null, { status: 204 });
});
