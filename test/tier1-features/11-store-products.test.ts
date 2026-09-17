import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';

describe('Tier 1: Feature 11 - Store, Products & Order Processing', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('11.1 should return all store products via GET /api/store/products', async () => {
    const res = await apiRequest(app, 'GET', '/api/store/products', {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(3);
  });

  it('11.2 should filter store products by type query param', async () => {
    const res = await apiRequest(app, 'GET', '/api/store/products?type=digital', {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.every((p: any) => p.type === 'digital')).toBe(true);
  });

  it('11.3 should return single product details via GET /api/store/products/:id', async () => {
    const res = await apiRequest(app, 'GET', `/api/store/products/${ctx.fixtures.productIds.vipCode}`, {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(ctx.fixtures.productIds.vipCode);
    expect(data.price).toBe(50000);
    expect(data.is_activation_code).toBe(1);
  });

  it('11.4 should create a new digital product order via POST /api/store/orders', async () => {
    const res = await apiRequest(app, 'POST', '/api/store/orders', {
      token: ctx.fixtures.users.student.token,
      body: {
        payment_method: 'zaincash',
        items: [
          { product_id: ctx.fixtures.productIds.vipCode, qty: 1 },
        ],
      },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.total).toBe(50000);
    expect(data.status).toBe('pending');
  });

  it('11.5 should calculate total price correctly for multiple items in an order', async () => {
    const res = await apiRequest(app, 'POST', '/api/store/orders', {
      token: ctx.fixtures.users.student.token,
      body: {
        payment_method: 'zaincash',
        items: [
          { product_id: ctx.fixtures.productIds.vipCode, qty: 2 },     // 50,000 * 2 = 100,000
          { product_id: ctx.fixtures.productIds.subjectCode, qty: 1 }, // 15,000 * 1 = 15,000
        ],
      },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(115000);
  });

  it('11.6 should require delivery phone and address for physical products order', async () => {
    const res = await apiRequest(app, 'POST', '/api/store/orders', {
      token: ctx.fixtures.users.student.token,
      body: {
        payment_method: 'cash_on_delivery',
        delivery_phone: '07709876543',
        delivery_address: 'بغداد - المنصور - شارع 14 رمضان',
        items: [
          { product_id: ctx.fixtures.productIds.physical, qty: 1 },
        ],
      },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(35000);
  });

  it('11.7 should list student personal orders via GET /api/store/orders/mine', async () => {
    await apiRequest(app, 'POST', '/api/store/orders', {
      token: ctx.fixtures.users.student.token,
      body: {
        items: [{ product_id: ctx.fixtures.productIds.vipCode, qty: 1 }],
      },
    }, ctx);

    const res = await apiRequest(app, 'GET', '/api/store/orders/mine', {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it('11.8 should retrieve single order with item details via GET /api/store/orders/:id', async () => {
    const orderRes = await apiRequest(app, 'POST', '/api/store/orders', {
      token: ctx.fixtures.users.student.token,
      body: {
        items: [{ product_id: ctx.fixtures.productIds.vipCode, qty: 1 }],
      },
    }, ctx);
    const { id } = await orderRes.json();

    const res = await apiRequest(app, 'GET', `/api/store/orders/${id}`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(id);
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.items[0].product_name).toContain('VIP');
  });

  it('11.9 should allow student to cancel a pending order via POST /api/store/orders/:id/cancel', async () => {
    const orderRes = await apiRequest(app, 'POST', '/api/store/orders', {
      token: ctx.fixtures.users.student.token,
      body: {
        items: [{ product_id: ctx.fixtures.productIds.vipCode, qty: 1 }],
      },
    }, ctx);
    const { id } = await orderRes.json();

    const cancelRes = await apiRequest(app, 'POST', `/api/store/orders/${id}/cancel`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    expect(cancelRes.status).toBe(200);
    const order = await ctx.db.prepare('SELECT status FROM orders WHERE id = ?').bind(id).first('status');
    expect(order).toBe('cancelled');
  });

  it('11.10 should persist order items in order_items table with correct foreign key', async () => {
    const orderRes = await apiRequest(app, 'POST', '/api/store/orders', {
      token: ctx.fixtures.users.student.token,
      body: {
        items: [{ product_id: ctx.fixtures.productIds.vipCode, qty: 3 }],
      },
    }, ctx);
    const { id } = await orderRes.json();

    const items = await ctx.db.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(id).all();
    expect(items.results.length).toBe(1);
    const item: any = items.results[0];
    expect(item.qty).toBe(3);
    expect(item.price).toBe(50000);
  });
});
