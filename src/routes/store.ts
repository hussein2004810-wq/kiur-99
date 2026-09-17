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

const CODE_VALIDITY_DAYS = 365;

// GET /api/store/products — no auth required for browsing
storeRouter.get('/products', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const products = await db.select().from(schema.products);
  return c.json(products);
});

// All order routes require auth
storeRouter.use('/orders*', requireAuth);

// POST /api/store/orders
storeRouter.post('/orders', async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const body = await c.req.json<{
    items: Array<{ product_id: string; qty: number }>;
    payment_method: string;
    delivery_name?: string;
    delivery_phone?: string;
    delivery_address?: string;
  }>();

  if (!body.items || body.items.length === 0) return c.json({ detail: 'السلة فارغة' }, 400);

  const productIds = body.items.map((i) => i.product_id);
  const products = await db.select().from(schema.products).where(inArray(schema.products.id, productIds));
  const productMap: Record<string, typeof schema.products.$inferSelect> = {};
  products.forEach((p) => { productMap[p.id] = p; });

  let total = 0;
  let hasPhysical = false;
  for (const item of body.items) {
    const product = productMap[item.product_id];
    if (!product) return c.json({ detail: `منتج غير موجود: ${item.product_id}` }, 404);
    if (product.type === 'physical') hasPhysical = true;
    total += (product.price ?? 0) * item.qty;
  }

  if (body.payment_method === 'cod' && !hasPhysical) {
    return c.json({ detail: 'الدفع عند الاستلام متاح فقط للطلبات التي تحوي منتجات ملموسة' }, 400);
  }
  if (hasPhysical && !(body.delivery_name && body.delivery_phone && body.delivery_address)) {
    return c.json({ detail: 'معلومات التوصيل (الاسم، الهاتف، العنوان) مطلوبة للطلبات التي تحوي منتجات ملموسة' }, 400);
  }

  const orderId = schema.genId();
  await db.insert(schema.orders).values({
    id: orderId,
    user_id: user.id,
    total,
    payment_method: body.payment_method,
    status: 'pending',
    delivery_name: hasPhysical ? body.delivery_name : null,
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

  return c.json({ ...order, items: orderItems }, 201);
});

// GET /api/store/orders/mine
storeRouter.get('/orders/mine', requireAuth, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const user = c.get('user')!;
  const orders = await db.select().from(schema.orders).where(eq(schema.orders.user_id, user.id));
  return c.json(orders);
});
