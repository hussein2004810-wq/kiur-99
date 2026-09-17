/**
 * Academic catalog routes — mirrors Python app/routers/catalog.py
 * GET /api/catalog/tree — full nested tree (sections → universities → stages → subjects)
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';

export const catalogRouter = new Hono<AppEnv>();

catalogRouter.get('/tree', async (c) => {
  const db = drizzle(c.env.DB, { schema });

  const sections = await db.select().from(schema.sections);
  const universities = await db.select().from(schema.universities);
  const stages = await db.select().from(schema.stages);
  const subjects = await db.select().from(schema.subjects);

  // Build nested tree
  const tree = sections.map((sec) => ({
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

  return c.json(tree);
});
