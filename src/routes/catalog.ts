/**
 * Academic catalog routes — mirrors Python app/routers/catalog.py
 * GET /api/catalog/tree — full nested tree (sections → universities → stages → subjects)
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';

export const catalogRouter = new Hono<AppEnv>();

// ── Tree ──
catalogRouter.get('/tree', async (c) => {
  const db = drizzle(c.env.DB, { schema });

  const sections = await db.select().from(schema.sections);
  const colleges = await db.select().from(schema.colleges);
  const collegePrograms = await db.select().from(schema.collegePrograms);
  const universities = await db.select().from(schema.universities);
  const stages = await db.select().from(schema.stages);
  const subjects = await db.select().from(schema.subjects).where(eq(schema.subjects.is_deleted, false));

  const uniMap = new Map(universities.map((u) => [u.id, u]));

  // 1. Traditional sections
  const sectionTree = sections.map((sec) => ({
    id: sec.id,
    name: sec.name,
    universities: universities
      .filter((u) => u.section_id === sec.id)
      .map((uni) => ({
        id: uni.id,
        name: uni.name,
        section_id: uni.section_id,
        stages: stages
          .filter((st) => st.university_id === uni.id)
          .map((stage) => ({
            id: stage.id,
            name: stage.name,
            university_id: stage.university_id,
            subjects: subjects
              .filter((sub) => sub.stage_id === stage.id)
              .map((sub) => ({ id: sub.id, name: sub.name, stage_id: sub.stage_id })),
          })),
      })),
  }));

  // 2. Modern medical college programs
  const existingSectionNames = new Set(sections.map((s) => s.name.trim().toLowerCase()));

  const collegeSections = colleges
    .filter((col) => !existingSectionNames.has(col.name.trim().toLowerCase()))
    .map((col) => {
      const progsForCol = collegePrograms.filter((cp) => cp.college_id === col.id);
      const unisForCol = progsForCol
        .map((prg) => {
          const uni = uniMap.get(prg.university_id);
          if (!uni) return null;
          const pStages = stages
            .filter((st) => st.program_id === prg.id || (st.college_id === col.id && st.university_id === uni.id))
            .sort((a, b) => (a.stage_number ?? 0) - (b.stage_number ?? 0));

          return {
            id: uni.id,
            name: uni.name,
            section_id: col.id,
            type: uni.type,
            province: uni.province,
            stages: pStages.map((stage) => ({
              id: stage.id,
              name: stage.name,
              university_id: uni.id,
              stage_number: stage.stage_number,
              subjects: subjects
                .filter((sub) => sub.stage_id === stage.id)
                .map((sub) => ({
                  id: sub.id,
                  name: sub.name,
                  code: sub.code,
                  term: sub.term,
                  is_ministerial: Boolean(sub.is_ministerial),
                  has_practical: Boolean(sub.has_practical),
                  stage_id: sub.stage_id,
                })),
            })),
          };
        })
        .filter(Boolean);

      return {
        id: col.id,
        name: col.name,
        code: col.code,
        universities: unisForCol,
      };
    })
    .filter((sec) => sec.universities.length > 0);

  const fullTree = [...sectionTree, ...collegeSections];
  return c.json(fullTree);
});

// ── Sections ──
catalogRouter.get('/sections', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const sections = await db.select().from(schema.sections);
  return c.json(sections);
});

catalogRouter.get('/sections/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const section = await db.select().from(schema.sections).where(eq(schema.sections.id, id)).get();
  if (!section) return c.json({ detail: 'القسم غير موجود' }, 404);
  const unis = await db.select().from(schema.universities).where(eq(schema.universities.section_id, id));
  return c.json({ ...section, universities: unis });
});

// ── Universities ──
catalogRouter.get('/universities', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const sectionId = c.req.query('section_id');
  const type = c.req.query('type');
  const province = c.req.query('province');

  let list = await db.select().from(schema.universities);
  if (sectionId) list = list.filter((u) => u.section_id === sectionId);
  if (type) list = list.filter((u) => u.type === type);
  if (province) list = list.filter((u) => u.province === province);

  return c.json(list);
});

catalogRouter.get('/universities/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const uni = await db.select().from(schema.universities).where(eq(schema.universities.id, id)).get();
  if (!uni) return c.json({ detail: 'الجامعة غير موجودة' }, 404);
  const stages = await db.select().from(schema.stages).where(eq(schema.stages.university_id, id));
  return c.json({ ...uni, stages });
});

// ── Colleges ──
catalogRouter.get('/colleges', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const list = await db.select().from(schema.colleges);
  return c.json(list);
});

catalogRouter.get('/colleges/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const col = await db.select().from(schema.colleges).where(eq(schema.colleges.id, id)).get();
  if (!col) return c.json({ detail: 'الكلية غير موجودة' }, 404);
  return c.json(col);
});

// ── Stages ──
catalogRouter.get('/stages', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const uniId = c.req.query('university_id');
  const progId = c.req.query('program_id');

  let list = await db.select().from(schema.stages);
  if (uniId) list = list.filter((s) => s.university_id === uniId);
  if (progId) list = list.filter((s) => s.program_id === progId);

  return c.json(list);
});

catalogRouter.get('/stages/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const stage = await db.select().from(schema.stages).where(eq(schema.stages.id, id)).get();
  if (!stage) return c.json({ detail: 'المرحلة غير موجودة' }, 404);
  const subjects = await db.select().from(schema.subjects).where(and(eq(schema.subjects.stage_id, id), eq(schema.subjects.is_deleted, false)));
  return c.json({ ...stage, subjects });
});

// ── Subjects ──
catalogRouter.get('/subjects', async (c) => {
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

catalogRouter.get('/subjects/:id', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const subject = await db.select().from(schema.subjects).where(and(eq(schema.subjects.id, id), eq(schema.subjects.is_deleted, false))).get();
  if (!subject) return c.json({ detail: 'المادة غير موجودة' }, 404);
  return c.json(subject);
});

catalogRouter.get('/subjects/:id/booklets', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param('id');
  const subject = await db.select().from(schema.subjects).where(eq(schema.subjects.id, id)).get();
  if (!subject) return c.json({ detail: 'المادة غير موجودة' }, 404);

  const profs = await db.select().from(schema.professorProfiles).where(eq(schema.professorProfiles.subject_id, id));
  if (!profs.length) return c.json([]);

  const profIds = profs.map((p) => p.id);
  const booklets = await db.select().from(schema.booklets);
  const matching = booklets.filter((b) => profIds.includes(b.professor_id));
  return c.json(matching);
});
