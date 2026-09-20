/**
 * Store routes — mirrors Python app/routers/store.py
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, inArray } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { AppEnv } from '../types';
import { requireAuth } from '../middleware/auth';

export const storeRouter = new Hono<AppEnv>();

// GET /api/store/products — no auth required for browsing
storeRouter.get('/products', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const type = c.req.query('type');
  if (type) {
    const products = await db.select().from(schema.products).where(eq(schema.products.type, type as any));
    return c.json(products);
  }
  const products = await db.select().from(schema.products);
  return c.json(products);
});

// GET /api/store/products/:id
storeRouter.get('/products/:id', async (c) => {
  const id = c.req.param('id');
  const p = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
  if (!p) return c.json({ detail: 'المنتج غير موجود' }, 404);
  return c.json(p);
});

// All order routes require auth
storeRouter.use('/orders*', requireAuth);

// POST /api/store/orders
storeRouter.post('/orders', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const body = await c.req.json<{
    items: Array<{ product_id: string; qty: number }>;
    payment_method?: string;
    delivery_name?: string;
    delivery_phone?: string;
    delivery_address?: string;
  }>().catch(() => ({} as any));

  if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ detail: 'يجب اختيار منتج واحد على الأقل' }, 400);
  }

  const productIds = body.items.map((i: { product_id: string; qty: number }) => i.product_id);
  const products = await db.select().from(schema.products).where(inArray(schema.products.id, productIds));
  const productMap: Record<string, typeof schema.products.$inferSelect> = {};
  products.forEach((p) => { productMap[p.id] = p; });

  let total = 0;
  let hasPhysical = false;
  for (const item of body.items) {
    if (!item.product_id || !item.qty || item.qty <= 0) {
      return c.json({ detail: 'الكمية يجب أن تكون أكبر من صفر' }, 400);
    }
    const product = productMap[item.product_id];
    if (!product) return c.json({ detail: `المنتج ${item.product_id} غير موجود` }, 404);
    if (product.type === 'physical') hasPhysical = true;
    total += (product.price ?? 0) * item.qty;
  }

  if (body.payment_method === 'cod' && !hasPhysical) {
    return c.json({ detail: 'الدفع عند الاستلام متاح فقط للطلبات التي تحوي منتجات ملموسة' }, 400);
  }
  if (hasPhysical && (!body.delivery_phone || !body.delivery_address)) {
    return c.json({ detail: 'رقم الهاتف وعنوان التوصيل مطلوبان للمنتجات الورقية/المادية' }, 400);
  }

  const orderId = 'ord_' + Math.random().toString(36).substring(2, 10);
  const deliveryName = body.delivery_name ?? user.full_name;

  await db.insert(schema.orders).values({
    id: orderId,
    user_id: user.id,
    total,
    payment_method: body.payment_method ?? 'zaincash',
    status: 'pending',
    delivery_name: hasPhysical ? deliveryName : null,
    delivery_phone: hasPhysical ? body.delivery_phone : null,
    delivery_address: hasPhysical ? body.delivery_address : null,
  });

  for (const item of body.items) {
    const product = productMap[item.product_id];
    await db.insert(schema.orderItems).values({
      id: schema.genId(),
      order_id: orderId,
      product_id: item.product_id,
      qty: item.qty,
      price: product.price ?? 0,
    });
  }

  const order = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get();
  const orderItems = await db.select().from(schema.orderItems).where(eq(schema.orderItems.order_id, orderId));

  return c.json({ ...order, items: orderItems }, 200);
});

// GET /api/store/orders/mine
storeRouter.get('/orders/mine', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const orders = await db.select().from(schema.orders).where(eq(schema.orders.user_id, user.id));
  return c.json(orders);
});

// GET /api/store/orders/:id
storeRouter.get('/orders/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user')!;
  const order: any = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
  if (!order) return c.json({ detail: 'الطلب غير موجود' }, 404);
  if (order.user_id !== user.id && user.role !== 'admin') return c.json({ detail: 'غير مصرح' }, 403);

  const items = await c.env.DB.prepare(`
    SELECT oi.*, p.name as product_name
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    WHERE oi.order_id = ?
  `).bind(id).all();
  return c.json({ ...order, items: items.results });
});

// POST /api/store/orders/:id/cancel
storeRouter.post('/orders/:id/cancel', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user')!;
  const order: any = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
  if (!order) return c.json({ detail: 'الطلب غير موجود' }, 404);
  if (order.user_id !== user.id && user.role !== 'admin') return c.json({ detail: 'غير مصرح' }, 403);
  if (order.status !== 'pending') {
    return c.json({ detail: 'لا يمكن إلغاء طلب مدفوع أو ملغى مسبقاً' }, 400);
  }
  await c.env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").bind(id).run();
  return c.json({ message: 'تم إلغاء الطلب بنجاح' });
});
