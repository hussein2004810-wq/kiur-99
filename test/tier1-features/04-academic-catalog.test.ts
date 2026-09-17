import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';

describe('Tier 1: Feature 4 - Academic Catalog Hierarchy', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('4.1 should return list of academic sections via GET /api/catalog/sections', async () => {
    const res = await apiRequest(app, 'GET', '/api/catalog/sections', {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].name).toBe('طب بشري');
  });

  it('4.2 should return section details with child universities via GET /api/catalog/sections/:id', async () => {
    const res = await apiRequest(app, 'GET', `/api/catalog/sections/${ctx.fixtures.sectionId}`, {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(ctx.fixtures.sectionId);
    expect(Array.isArray(data.universities)).toBe(true);
    expect(data.universities.length).toBeGreaterThan(0);
  });

  it('4.3 should return all universities via GET /api/catalog/universities', async () => {
    const res = await apiRequest(app, 'GET', '/api/catalog/universities', {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((u: any) => u.name === 'جامعة بغداد')).toBe(true);
  });

  it('4.4 should filter universities by section_id query param', async () => {
    const res = await apiRequest(app, 'GET', `/api/catalog/universities?section_id=${ctx.fixtures.sectionId}`, {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.every((u: any) => u.section_id === ctx.fixtures.sectionId)).toBe(true);
  });

  it('4.5 should return university details with child stages via GET /api/catalog/universities/:id', async () => {
    const res = await apiRequest(app, 'GET', `/api/catalog/universities/${ctx.fixtures.universityId}`, {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(ctx.fixtures.universityId);
    expect(Array.isArray(data.stages)).toBe(true);
    expect(data.stages.some((s: any) => s.name === 'المرحلة الثانية')).toBe(true);
  });

  it('4.6 should return all stages via GET /api/catalog/stages', async () => {
    const res = await apiRequest(app, 'GET', '/api/catalog/stages', {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it('4.7 should filter stages by university_id query param', async () => {
    const res = await apiRequest(app, 'GET', `/api/catalog/stages?university_id=${ctx.fixtures.universityId}`, {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.every((s: any) => s.university_id === ctx.fixtures.universityId)).toBe(true);
  });

  it('4.8 should return stage details with child subjects via GET /api/catalog/stages/:id', async () => {
    const res = await apiRequest(app, 'GET', `/api/catalog/stages/${ctx.fixtures.stageId}`, {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(ctx.fixtures.stageId);
    expect(Array.isArray(data.subjects)).toBe(true);
    expect(data.subjects.length).toBe(4);
    const subjectNames = data.subjects.map((s: any) => s.name);
    expect(subjectNames).toContain('التشريح');
    expect(subjectNames).toContain('الفسلجة');
  });

  it('4.9 should return all subjects via GET /api/catalog/subjects', async () => {
    const res = await apiRequest(app, 'GET', '/api/catalog/subjects', {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(4);
  });

  it('4.10 should return booklets for a specific subject via GET /api/catalog/subjects/:id/booklets', async () => {
    const res = await apiRequest(app, 'GET', `/api/catalog/subjects/${ctx.fixtures.subjectIds.anatomy}/booklets`, {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].title).toContain('التشريح');
  });
});
