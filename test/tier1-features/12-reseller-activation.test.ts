import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';

describe('Tier 1: Feature 12 - Reseller Inventory & Activation Redemption', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('12.1 should retrieve reseller inventory via GET /api/reseller/inventory', async () => {
    const res = await apiRequest(app, 'GET', '/api/reseller/inventory', {
      token: ctx.fixtures.users.reseller.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('12.2 should retrieve reseller code metrics via GET /api/reseller/stats', async () => {
    const res = await apiRequest(app, 'GET', '/api/reseller/stats', {
      token: ctx.fixtures.users.reseller.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total_codes).toBeDefined();
    expect(data.active_codes).toBeDefined();
  });

  it('12.3 should generate a batch of activation codes via POST /api/reseller/generate', async () => {
    const res = await apiRequest(app, 'POST', '/api/reseller/generate', {
      token: ctx.fixtures.users.reseller.token,
      body: { count: 3 },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.generated_count).toBe(3);
    expect(Array.isArray(data.codes)).toBe(true);
    expect(data.codes.length).toBe(3);
  });

  it('12.4 should mark code as sold to customer via POST /api/reseller/codes/:id/sell', async () => {
    const genRes = await apiRequest(app, 'POST', '/api/reseller/generate', {
      token: ctx.fixtures.users.reseller.token,
      body: { count: 1 },
    }, ctx);
    const { codes } = await genRes.json();
    const codeRecord = await ctx.db.prepare('SELECT id FROM activation_codes WHERE code = ?').bind(codes[0]).first();

    const sellRes = await apiRequest(app, 'POST', `/api/reseller/codes/${codeRecord.id}/sell`, {
      token: ctx.fixtures.users.reseller.token,
    }, ctx);

    expect(sellRes.status).toBe(200);
    const updated = await ctx.db.prepare('SELECT sold_at FROM activation_codes WHERE id = ?').bind(codeRecord.id).first();
    expect(updated.sold_at).toBeDefined();
  });

  it('12.5 should redeem a valid VIP activation code and grant VIP access', async () => {
    const res = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: ctx.fixtures.users.student.token,
      body: { code: ctx.fixtures.activationCodes.vipIdle },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.is_vip).toBe(true);
    expect(data.expires_at).toBeDefined();

    // Verify in database
    const code = await ctx.db.prepare('SELECT status, activated_by_user_id FROM activation_codes WHERE code = ?')
      .bind(ctx.fixtures.activationCodes.vipIdle).first();
    expect(code.status).toBe('active');
    expect(code.activated_by_user_id).toBe(ctx.fixtures.users.student.id);
  });

  it('12.6 should redeem a subject-scoped activation code and grant subject access', async () => {
    const res = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: ctx.fixtures.users.student.token,
      body: { code: ctx.fixtures.activationCodes.subjectIdle },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.is_vip).toBe(false);
    expect(data.subject_id).toBe(ctx.fixtures.subjectIds.anatomy);
  });

  it('12.7 should check user active subscriptions via GET /api/activation/status', async () => {
    // Redeem VIP code
    await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: ctx.fixtures.users.student.token,
      body: { code: ctx.fixtures.activationCodes.vipIdle },
    }, ctx);

    const res = await apiRequest(app, 'GET', '/api/activation/status', {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.active_subscriptions)).toBe(true);
    expect(data.active_subscriptions.length).toBeGreaterThan(0);
  });

  it('12.8 should normalize code with trim and case-insensitivity on redeem', async () => {
    // Generate new code
    await ctx.db.prepare("INSERT INTO activation_codes (id, code, status) VALUES ('act_norm', 'NBD-TRIM-CASE', 'idle')").run();

    const res = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: ctx.fixtures.users.student.token,
      body: { code: '  nbd-trim-case  ' },
    }, ctx);

    expect(res.status).toBe(200);
  });
});
