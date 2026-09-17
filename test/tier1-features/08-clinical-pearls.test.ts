import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';

describe('Tier 1: Feature 8 - Clinical Pearls & Public Gate', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('8.1 should return clinical pearls for public visitors without body field (anti-leak gate)', async () => {
    const res = await apiRequest(app, 'GET', '/api/pearls', {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    // Crucial: Opaque test ensures unauthenticated visitors never receive body content
    expect(data[0].body).toBeUndefined();
    expect(data[0].title).toBeDefined();
    expect(data[0].tag).toBeDefined();
  });

  it('8.2 should return clinical pearls with full clinical body for authenticated students', async () => {
    const res = await apiRequest(app, 'GET', '/api/pearls', {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data[0].body).toBeDefined();
    expect(data[0].body.length).toBeGreaterThan(10);
  });

  it('8.3 should return single pearl without body for unauthenticated caller via GET /api/pearls/:id', async () => {
    const pearlId = ctx.fixtures.pearlIds[0];
    const res = await apiRequest(app, 'GET', `/api/pearls/${pearlId}`, {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(pearlId);
    expect(data.title).toBeDefined();
    expect(data.body).toBeUndefined();
  });

  it('8.4 should return single pearl with full body for authenticated student via GET /api/pearls/:id', async () => {
    const pearlId = ctx.fixtures.pearlIds[0];
    const res = await apiRequest(app, 'GET', `/api/pearls/${pearlId}`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(pearlId);
    expect(data.body).toBeDefined();
  });

  it('8.5 should return today pearl of the day via GET /api/pearls/daily', async () => {
    const res = await apiRequest(app, 'GET', '/api/pearls/daily', {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.title).toBeDefined();
  });

  it('8.6 should allow student to bookmark a clinical pearl via POST /api/pearls/:id/bookmark', async () => {
    const pearlId = ctx.fixtures.pearlIds[0];
    const res = await apiRequest(app, 'POST', `/api/pearls/${pearlId}/bookmark`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toBeDefined();
  });
});
