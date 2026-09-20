/**
 * Auth middleware — mirrors Python app/deps.py get_current_user.
 * Validates Bearer token + single-active-session check.
 */
import type { Context, Next } from 'hono';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import type { AppEnv, CurrentUser, CurrentSession } from '../types';
import { decodeAccessToken } from '../services/jwt';

export async function authenticateToken(
  db: ReturnType<typeof drizzle<typeof schema>>,
  token: string,
  jwtSecret: string
): Promise<{ success: true; user: CurrentUser; session: CurrentSession } | { success: false; status: 401 | 403; detail: string }> {
  const payload = await decodeAccessToken(token, jwtSecret);
  if (!payload || !payload.sub) {
    return { success: false, status: 401, detail: 'انتهت صلاحية الجلسة' };
  }

  let sessionRecord: CurrentSession;
  if (payload.sid) {
    // Atomic compound session check: session must exist, be active, and belong strictly to payload.sub
    const session = await db
      .select()
      .from(schema.userSessions)
      .where(
        and(
          eq(schema.userSessions.id, payload.sid),
          eq(schema.userSessions.user_id, payload.sub),
          eq(schema.userSessions.is_active, true)
        )
      )
      .get();

    if (!session || !session.is_active) {
      return { success: false, status: 401, detail: 'تم تسجيل الدخول من جهاز آخر' };
    }

    sessionRecord = {
      id: session.id,
      user_id: session.user_id,
      device_label: session.device_label ?? '',
      is_active: session.is_active ?? false,
    };
  } else {
    sessionRecord = {
      id: '',
      user_id: payload.sub,
      device_label: 'direct',
      is_active: true,
    };
  }

  // Load user
  const user = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, payload.sub))
    .get();

  if (!user) {
    return { success: false, status: 401, detail: 'المستخدم غير موجود' };
  }

  if (user.is_banned) {
    return { success: false, status: 403, detail: 'هذا الحساب محظور' };
  }

  return {
    success: true,
    user: {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role as CurrentUser['role'],
      is_banned: user.is_banned ?? false,
      university_id: user.university_id,
      college_id: user.college_id,
      department_id: user.department_id,
      stage_id: user.stage_id,
      study_section_id: user.study_section_id,
      section_id: user.section_id,
    },
    session: sessionRecord,
  };
}

export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const authHeader = c.req.header('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return c.json({ detail: 'مطلوب تسجيل الدخول' }, 401);
  }

  const db = drizzle(c.env.DB, { schema });
  const result = await authenticateToken(db, token, c.env.JWT_SECRET);
  if (!result.success) {
    return c.json({ detail: result.detail }, result.status);
  }

  c.set('user', result.user);
  c.set('session', result.session);
  await next();
}

export async function optionalAuth(c: Context<AppEnv>, next: Next) {
  const authHeader = c.req.header('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token) {
    const db = drizzle(c.env.DB, { schema });
    const result = await authenticateToken(db, token, c.env.JWT_SECRET);
    if (result.success) {
      c.set('user', result.user);
      c.set('session', result.session);
    }
  }
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
      return c.json({ detail: 'ليس لديك صلاحية للوصول إلى هذا المورد' }, 403);
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
