/**
 * Auth middleware — mirrors Python app/deps.py get_current_user.
 * Validates Bearer token + single-active-session check.
 */
import type { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import type { AppEnv, CurrentUser, CurrentSession } from '../types';
import { decodeAccessToken } from '../services/jwt';

export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const authHeader = c.req.header('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return c.json({ detail: 'مطلوب تسجيل الدخول' }, 401);
  }

  const jwtSecret = c.env.JWT_SECRET;
  const payload = await decodeAccessToken(token, jwtSecret);
  if (!payload || !payload.sub || !payload.sid) {
    return c.json({ detail: 'انتهت صلاحية الجلسة' }, 401);
  }

  const db = drizzle(c.env.DB, { schema });

  // Verify session is still active (anti-piracy single-session check)
  const session = await db
    .select()
    .from(schema.userSessions)
    .where(eq(schema.userSessions.id, payload.sid))
    .get();

  if (!session || !session.is_active) {
    return c.json({ detail: 'تم تسجيل الدخول من جهاز آخر' }, 401);
  }

  // Load user
  const user = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, payload.sub))
    .get();

  if (!user) {
    return c.json({ detail: 'المستخدم غير موجود' }, 401);
  }

  if (user.is_banned) {
    return c.json({ detail: 'هذا الحساب محظور' }, 403);
  }

  const currentUser: CurrentUser = {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: user.role as CurrentUser['role'],
    is_banned: user.is_banned ?? false,
    university_id: user.university_id,
    stage_id: user.stage_id,
    section_id: user.section_id,
  };

  const currentSession: CurrentSession = {
    id: session.id,
    user_id: session.user_id,
    device_label: session.device_label ?? '',
    is_active: session.is_active ?? false,
  };

  c.set('user', currentUser);
  c.set('session', currentSession);
  await next();
}

export function requireRole(...roles: string[]) {
  return async (c: Context<AppEnv>, next: Next) => {
    let user = c.get('user');
    if (!user) {
      let passed = false;
      const authRes = await requireAuth(c, async () => { passed = true; });
      if (!passed) return authRes;
      user = c.get('user');
    }
    if (!user || !roles.includes(user.role)) {
      return c.json({ detail: 'غير مصرح لك بهذا الإجراء' }, 403);
    }
    await next();
  };
}

export async function requireAdmin(c: Context<AppEnv>, next: Next) {
  return requireRole('admin')(c, next);
}

export async function requireProfessor(c: Context<AppEnv>, next: Next) {
  return requireRole('professor', 'admin')(c, next);
}

/**
 * Helper: start new session (anti-piracy — deactivates all other sessions).
 */
export async function startNewSession(
  db: ReturnType<typeof drizzle>,
  userId: string,
  deviceLabel: string
): Promise<typeof schema.userSessions.$inferSelect> {
  const id = schema.genId();

  // Atomically deactivate all existing sessions and create the new session in one transaction
  await db.batch([
    db
      .update(schema.userSessions)
      .set({ is_active: false })
      .where(eq(schema.userSessions.user_id, userId)),
    db
      .insert(schema.userSessions)
      .values({
        id,
        user_id: userId,
        device_label: deviceLabel,
        is_active: true,
      }),
  ]);

  const session = await db
    .select()
    .from(schema.userSessions)
    .where(eq(schema.userSessions.id, id))
    .get();

  return session!;
}
