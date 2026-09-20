import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { verifyJwt, verifyPassword, hashPassword, generateTotpSecret, verifyTotpCode } from './crypto-helpers';

export function createContractRouter(): Hono<{ Bindings: any; Variables: any }> {
  const app = new Hono<{ Bindings: any; Variables: any }>();

  // CORS
  app.use('*', async (c, next) => {
    return cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'Range', 'Cookie'],
      credentials: true,
    })(c, next);
  });

  // Auth Middleware
  const authMiddleware = async (c: any, next: any) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ detail: 'يجب تسجيل الدخول أولاً' }, 401);
    }
    const token = authHeader.substring(7).trim();
    if (!token) {
      return c.json({ detail: 'رمز الوصول مفقود' }, 401);
    }
    const secret = c.env?.JWT_SECRET || 'test-jwt-secret-key-32-chars-long!';
    const payload = verifyJwt<any>(token, secret);
    if (!payload || !payload.sub) {
      return c.json({ detail: 'رمز الوصول غير صالح أو منتهي الصلاحية' }, 401);
    }

    // Check session validity
    if (payload.sid) {
      const session = await c.env.DB.prepare('SELECT is_active FROM user_sessions WHERE id = ?').bind(payload.sid).first();
      if (!session || !session.is_active) {
        return c.json({ detail: 'تم تسجيل الدخول من جهاز آخر' }, 401);
      }
    }

    const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(payload.sub).first();
    if (!user) {
      return c.json({ detail: 'المستخدم غير موجود' }, 401);
    }

    // Check banned status except for ban appeal endpoints
    const path = c.req.path;
    if (user.is_banned && !path.startsWith('/api/bans')) {
      return c.json({ detail: 'هذا الحساب محظور' }, 403);
    }

    c.set('user', user);
    c.set('sessionId', payload.sid);
    await next();
  };

  const requireRole = (...roles: string[]) => {
    return async (c: any, next: any) => {
      const user = c.get('user');
      if (!user || !roles.includes(user.role)) {
        return c.json({ detail: 'لا تملك صلاحية الوصول' }, 403);
      }
      await next();
    };
  };

  // Helper for parsing JSON safely
  const parseJson = async (c: any) => {
    try {
      return await c.req.json();
    } catch {
      return null;
    }
  };

  // --- Static & Health ---
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // --- Auth Routes ---
  app.post('/auth/register', async (c) => {
    const body = await parseJson(c);
    if (!body || !body.email || !body.full_name || !body.password) {
      return c.json({ detail: 'بيانات التسجيل غير مكتملة' }, 400);
    }
    if (body.password.length < 6) {
      return c.json({ detail: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' }, 400);
    }
    if (!body.email.includes('@') || !body.email.includes('.')) {
      return c.json({ detail: 'صيغة البريد الإلكتروني غير صحيحة' }, 400);
    }

    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').bind(body.email).first();
    if (existing) {
      return c.json({ detail: 'البريد الإلكتروني مسجل بالفعل' }, 400);
    }

    const userId = 'usr_' + Math.random().toString(36).substring(2, 10);
    const pwdHash = hashPassword(body.password);
    // Mirror the production boundary: public input can never select a role.
    const role = 'student';

    await c.env.DB.prepare(`
      INSERT INTO users (id, email, full_name, password_hash, role, university_id, stage_id, section_id, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userId,
      body.email.toLowerCase(),
      body.full_name,
      pwdHash,
      role,
      body.university_id ?? null,
      body.stage_id ?? null,
      body.section_id ?? null,
      body.phone ?? null
    ).run();

    return c.json({
      ok: true,
      requires_email_verification: true,
      user_id: userId,
      role,
      message: 'تم إنشاء الحساب. يرجى توثيق بريدك الإلكتروني قبل تسجيل الدخول.',
    });
  });

  app.post('/auth/login', async (c) => {
    const body = await parseJson(c);
    if (!body || !body.email || !body.password) {
      return c.json({ detail: 'البريد وكلمة المرور مطلوبان' }, 400);
    }

    const user = await c.env.DB.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').bind(body.email).first();
    if (!user) {
      return c.json({ detail: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' }, 401);
    }

    // Check lockout
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      return c.json({ detail: 'تم قفل الحساب مؤقتاً لكثرة المحاولات الفاشلة' }, 429);
    }

    const valid = verifyPassword(body.password, user.password_hash);
    if (!valid) {
      const attempts = (user.failed_login_attempts || 0) + 1;
      let lockUntil: string | null = null;
      if (attempts >= 5) {
        lockUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }
      await c.env.DB.prepare('UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?')
        .bind(attempts, lockUntil, user.id).run();
      if (attempts >= 5) {
        return c.json({ detail: 'تم قفل الحساب مؤقتاً لكثرة المحاولات الفاشلة' }, 429);
      }
      return c.json({ detail: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' }, 401);
    }

    // Reset failed attempts
    await c.env.DB.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?')
      .bind(user.id).run();

    // Check 2FA
    if (user.totp_enabled) {
      const { signJwt } = await import('./crypto-helpers');
      const pendingToken = signJwt({ pending_2fa_user: user.id }, c.env.JWT_SECRET, 5);
      return c.json({ requires_2fa: true, pending_token: pendingToken });
    }

    // Single active session eviction
    await c.env.DB.prepare('UPDATE user_sessions SET is_active = 0 WHERE user_id = ?').bind(user.id).run();

    const sessionId = 'ses_' + Math.random().toString(36).substring(2, 10);
    await c.env.DB.prepare('INSERT INTO user_sessions (id, user_id, device_label, is_active) VALUES (?, ?, ?, 1)')
      .bind(sessionId, user.id, body.device_label ?? 'جهاز غير معروف').run();

    const { signJwt } = await import('./crypto-helpers');
    const accessToken = signJwt({ sub: user.id, role: user.role, sid: sessionId }, c.env.JWT_SECRET);

    c.header('Set-Cookie', `nabd_session=${sessionId}; Path=/auth/session; HttpOnly; SameSite=Lax; Max-Age=1209600`);
    return c.json({ access_token: accessToken, token_type: 'bearer', user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role } });
  });

  app.post('/auth/session/restore', async (c) => {
    const cookieHeader = c.req.header('Cookie') || '';
    const match = cookieHeader.match(/nabd_session=([^;]+)/);
    const body = await parseJson(c);
    const sessionId = match ? match[1] : body?.session_id;

    if (!sessionId) {
      return c.json({ detail: 'لا توجد جلسة للاستعادة' }, 401);
    }

    const session = await c.env.DB.prepare('SELECT * FROM user_sessions WHERE id = ?').bind(sessionId).first();
    if (!session || !session.is_active) {
      return c.json({ detail: 'الجلسة غير صالحة أو تم إنهاؤها' }, 401);
    }

    const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first();
    if (!user || user.is_banned) {
      return c.json({ detail: 'الحساب غير متاح' }, 401);
    }

    const { signJwt } = await import('./crypto-helpers');
    const accessToken = signJwt({ sub: user.id, role: user.role, sid: session.id }, c.env.JWT_SECRET);
    return c.json({ access_token: accessToken, token_type: 'bearer', user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role } });
  });

  app.post('/auth/logout', authMiddleware, async (c) => {
    const sessionId = c.get('sessionId');
    if (sessionId) {
      await c.env.DB.prepare('UPDATE user_sessions SET is_active = 0 WHERE id = ?').bind(sessionId).run();
    }
    c.header('Set-Cookie', 'nabd_session=; Path=/auth/session; Max-Age=0');
    return c.json({ message: 'تم تسجيل الخروج بنجاح' });
  });

  app.get('/auth/me', authMiddleware, async (c) => {
    const user = c.get('user');
    return c.json({
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      phone: user.phone,
      university_id: user.university_id,
      stage_id: user.stage_id,
      section_id: user.section_id,
      is_banned: Boolean(user.is_banned),
      totp_enabled: Boolean(user.totp_enabled),
      photo_url: user.photo_url,
      caption: user.caption,
      theme: user.theme || 'light',
      language: user.language || 'ar',
      created_at: user.created_at,
    });
  });

  app.put('/auth/me', authMiddleware, async (c) => {
    const user = c.get('user');
    const body = await parseJson(c);
    if (!body) return c.json({ detail: 'بيانات غير صالحة' }, 400);

    const fullName = body.full_name ?? user.full_name;
    const phone = body.phone !== undefined ? body.phone : user.phone;
    const caption = body.caption !== undefined ? body.caption : user.caption;
    const photoUrl = body.photo_url !== undefined ? body.photo_url : user.photo_url;
    const theme = body.theme ?? user.theme;
    const language = body.language ?? user.language;

    await c.env.DB.prepare(`
      UPDATE users SET full_name = ?, phone = ?, caption = ?, photo_url = ?, theme = ?, language = ?
      WHERE id = ?
    `).bind(fullName, phone, caption, photoUrl, theme, language, user.id).run();

    return c.json({ message: 'تم تحديث الملف الشخصي', full_name: fullName, phone, caption, photo_url: photoUrl, theme, language });
  });

  app.post('/auth/change-password', authMiddleware, async (c) => {
    const user = c.get('user');
    const body = await parseJson(c);
    if (!body || !body.old_password || !body.new_password) {
      return c.json({ detail: 'كلمة المرور القديمة والجديدة مطلوبتان' }, 400);
    }
    if (body.new_password.length < 6) {
      return c.json({ detail: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل' }, 400);
    }

    const valid = verifyPassword(body.old_password, user.password_hash);
    if (!valid) {
      return c.json({ detail: 'كلمة المرور الحالية غير صحيحة' }, 400);
    }

    const newHash = hashPassword(body.new_password);
    const now = new Date().toISOString();
    await c.env.DB.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?')
      .bind(newHash, now, user.id).run();

    // Evict sessions
    await c.env.DB.prepare('UPDATE user_sessions SET is_active = 0 WHERE user_id = ?').bind(user.id).run();

    return c.json({ message: 'تم تغيير كلمة المرور بنجاح' });
  });

  app.post('/auth/forgot-password', async (c) => {
    const body = await parseJson(c);
    if (!body || !body.email) return c.json({ detail: 'البريد الإلكتروني مطلوب' }, 400);

    const user = await c.env.DB.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').bind(body.email).first();
    if (!user) {
      return c.json({ message: 'إذا كان البريد مسجلاً، تم إرسال رابط الاستعادة' });
    }

    // Cooldown check (120 seconds)
    if (user.reset_requested_at) {
      const elapsed = (Date.now() - new Date(user.reset_requested_at).getTime()) / 1000;
      if (elapsed < 120) {
        return c.json({ detail: 'يرجى الانتظار دقيقتين قبل طلب رمز استعادة جديد' }, 429);
      }
    }

    const rawToken = 'reset_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    const crypto = await import('node:crypto');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const requestedAt = new Date().toISOString();

    await c.env.DB.prepare('UPDATE users SET reset_token_hash = ?, reset_token_expires_at = ?, reset_requested_at = ? WHERE id = ?')
      .bind(tokenHash, expiresAt, requestedAt, user.id).run();

    return c.json({ message: 'تم إرسال رابط الاستعادة بنجاح', debug_token: rawToken });
  });

  app.post('/auth/reset-password', async (c) => {
    const body = await parseJson(c);
    if (!body || !body.token || !body.new_password) {
      return c.json({ detail: 'الرمز وكلمة المرور الجديدة مطلوبان' }, 400);
    }
    if (body.new_password.length < 6) {
      return c.json({ detail: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' }, 400);
    }

    const crypto = await import('node:crypto');
    const tokenHash = crypto.createHash('sha256').update(body.token).digest('hex');

    const user = await c.env.DB.prepare('SELECT * FROM users WHERE reset_token_hash = ?').bind(tokenHash).first();
    if (!user || !user.reset_token_expires_at || new Date(user.reset_token_expires_at).getTime() < Date.now()) {
      return c.json({ detail: 'رمز الاستعادة غير صالح أو منتهي الصلاحية' }, 400);
    }

    const newHash = hashPassword(body.new_password);
    await c.env.DB.prepare(`
      UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_token_expires_at = NULL, password_changed_at = ?
      WHERE id = ?
    `).bind(newHash, new Date().toISOString(), user.id).run();

    await c.env.DB.prepare('UPDATE user_sessions SET is_active = 0 WHERE user_id = ?').bind(user.id).run();
    return c.json({ message: 'تم تعيين كلمة المرور الجديدة بنجاح' });
  });

  app.get('/auth/stats', authMiddleware, async (c) => {
    const user = c.get('user');
    const answeredCount = await c.env.DB.prepare('SELECT COUNT(*) as c FROM student_answers WHERE user_id = ?').bind(user.id).first('c');
    const correctCount = await c.env.DB.prepare('SELECT COUNT(*) as c FROM student_answers WHERE user_id = ? AND is_correct = 1').bind(user.id).first('c');
    const accuracy = answeredCount > 0 ? Math.round((Number(correctCount) / Number(answeredCount)) * 100) : 0;
    return c.json({ answered_count: Number(answeredCount), correct_count: Number(correctCount), accuracy });
  });

  // --- 2FA Endpoints ---
  app.post('/auth/2fa/setup', authMiddleware, async (c) => {
    const user = c.get('user');
    const secret = generateTotpSecret();
    await c.env.DB.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').bind(secret, user.id).run();
    const uri = `otpauth://totp/Nabd:${user.email}?secret=${secret}&issuer=Nabd`;
    return c.json({ secret, uri, qr_code: 'data:image/svg+xml;utf8,...' });
  });

  app.post('/auth/2fa/verify', authMiddleware, async (c) => {
    const user = c.get('user');
    const body = await parseJson(c);
    if (!body || !body.code) return c.json({ detail: 'رمز التحقق مطلوب' }, 400);
    if (!user.totp_secret) return c.json({ detail: 'لم يتم تهيئة المصادقة الثنائية' }, 400);

    const valid = verifyTotpCode(body.code, user.totp_secret);
    if (!valid) return c.json({ detail: 'رمز التحقق غير صحيح' }, 400);

    await c.env.DB.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').bind(user.id).run();
    return c.json({ message: 'تم تفعيل المصادقة الثنائية بنجاح' });
  });

  app.post('/auth/2fa/login', async (c) => {
    const body = await parseJson(c);
    if (!body || !body.pending_token || !body.code) {
      return c.json({ detail: 'الرمز المؤقت ورمز التحقق مطلوبان' }, 400);
    }
    const payload = verifyJwt<any>(body.pending_token, c.env.JWT_SECRET);
    if (!payload || !payload.pending_2fa_user) {
      return c.json({ detail: 'رمز التحقق المؤقت غير صالح' }, 401);
    }

    const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(payload.pending_2fa_user).first();
    if (!user || !user.totp_secret) return c.json({ detail: 'المستخدم غير صالح' }, 400);

    const valid = verifyTotpCode(body.code, user.totp_secret);
    if (!valid) return c.json({ detail: 'رمز التحقق غير صحيح' }, 400);

    await c.env.DB.prepare('UPDATE user_sessions SET is_active = 0 WHERE user_id = ?').bind(user.id).run();
    const sessionId = 'ses_' + Math.random().toString(36).substring(2, 10);
    await c.env.DB.prepare('INSERT INTO user_sessions (id, user_id, device_label, is_active) VALUES (?, ?, ?, 1)')
      .bind(sessionId, user.id, body.device_label ?? 'جهاز موثق').run();

    const { signJwt } = await import('./crypto-helpers');
    const accessToken = signJwt({ sub: user.id, role: user.role, sid: sessionId }, c.env.JWT_SECRET);
    c.header('Set-Cookie', `nabd_session=${sessionId}; Path=/auth/session; HttpOnly; SameSite=Lax; Max-Age=1209600`);
    return c.json({ access_token: accessToken, token_type: 'bearer' });
  });

  app.post('/auth/2fa/disable', authMiddleware, async (c) => {
    const user = c.get('user');
    const body = await parseJson(c);
    if (!body || !body.code) return c.json({ detail: 'رمز التحقق مطلوب' }, 400);
    if (!user.totp_secret) return c.json({ detail: 'المصادقة الثنائية غير مفعلة' }, 400);

    const valid = verifyTotpCode(body.code, user.totp_secret);
    if (!valid) return c.json({ detail: 'رمز التحقق غير صحيح' }, 400);

    await c.env.DB.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').bind(user.id).run();
    return c.json({ message: 'تم تعطيل المصادقة الثنائية بنجاح' });
  });

  // --- Catalog Routes ---
  app.get('/api/catalog/sections', async (c) => {
    const sections = await c.env.DB.prepare('SELECT * FROM sections').all();
    return c.json(sections.results);
  });

  app.get('/api/catalog/sections/:id', async (c) => {
    const id = c.req.param('id');
    const section = await c.env.DB.prepare('SELECT * FROM sections WHERE id = ?').bind(id).first();
    if (!section) return c.json({ detail: 'القسم غير موجود' }, 404);
    const universities = await c.env.DB.prepare('SELECT * FROM universities WHERE section_id = ?').bind(id).all();
    return c.json({ ...section, universities: universities.results });
  });

  app.get('/api/catalog/universities', async (c) => {
    const sectionId = c.req.query('section_id');
    let res;
    if (sectionId) {
      res = await c.env.DB.prepare('SELECT * FROM universities WHERE section_id = ?').bind(sectionId).all();
    } else {
      res = await c.env.DB.prepare('SELECT * FROM universities').all();
    }
    return c.json(res.results);
  });

  app.get('/api/catalog/universities/:id', async (c) => {
    const id = c.req.param('id');
    const uni = await c.env.DB.prepare('SELECT * FROM universities WHERE id = ?').bind(id).first();
    if (!uni) return c.json({ detail: 'الجامعة غير موجودة' }, 404);
    const stages = await c.env.DB.prepare('SELECT * FROM stages WHERE university_id = ?').bind(id).all();
    return c.json({ ...uni, stages: stages.results });
  });

  app.get('/api/catalog/stages', async (c) => {
    const uniId = c.req.query('university_id');
    let res;
    if (uniId) {
      res = await c.env.DB.prepare('SELECT * FROM stages WHERE university_id = ?').bind(uniId).all();
    } else {
      res = await c.env.DB.prepare('SELECT * FROM stages').all();
    }
    return c.json(res.results);
  });

  app.get('/api/catalog/stages/:id', async (c) => {
    const id = c.req.param('id');
    const stage = await c.env.DB.prepare('SELECT * FROM stages WHERE id = ?').bind(id).first();
    if (!stage) return c.json({ detail: 'المرحلة غير موجودة' }, 404);
    const subjects = await c.env.DB.prepare('SELECT * FROM subjects WHERE stage_id = ?').bind(id).all();
    return c.json({ ...stage, subjects: subjects.results });
  });

  app.get('/api/catalog/subjects', async (c) => {
    const stageId = c.req.query('stage_id');
    let res;
    if (stageId) {
      res = await c.env.DB.prepare('SELECT * FROM subjects WHERE stage_id = ?').bind(stageId).all();
    } else {
      res = await c.env.DB.prepare('SELECT * FROM subjects').all();
    }
    return c.json(res.results);
  });

  app.get('/api/catalog/subjects/:id/booklets', async (c) => {
    const id = c.req.param('id');
    const subject = await c.env.DB.prepare('SELECT id FROM subjects WHERE id = ?').bind(id).first();
    if (!subject) return c.json({ detail: 'المادة غير موجودة' }, 404);
    const res = await c.env.DB.prepare(`
      SELECT b.* FROM booklets b
      JOIN professor_profiles p ON b.professor_id = p.id
      WHERE p.subject_id = ?
    `).bind(id).all();
    return c.json(res.results);
  });

  // --- Questions Routes ---
  app.get('/api/questions', async (c) => {
    const subjectId = c.req.query('subject_id');
    const search = c.req.query('search');
    let query = 'SELECT * FROM questions WHERE 1=1';
    const params: any[] = [];
    if (subjectId) {
      query += ' AND subject_id = ?';
      params.push(subjectId);
    }
    if (search) {
      query += ' AND text LIKE ?';
      params.push(`%${search}%`);
    }
    const questions = await c.env.DB.prepare(query).bind(...params).all();
    return c.json(questions.results);
  });

  app.get('/api/questions/daily', async (c) => {
    const res = await c.env.DB.prepare('SELECT * FROM questions LIMIT 5').all();
    return c.json(res.results);
  });

  app.get('/api/questions/:id', async (c) => {
    const id = c.req.param('id');
    const q = await c.env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first();
    if (!q) return c.json({ detail: 'السؤال غير موجود' }, 404);
    const choices = await c.env.DB.prepare('SELECT id, text, order_index FROM choices WHERE question_id = ? ORDER BY order_index ASC').bind(id).all();
    return c.json({ ...q, choices: choices.results });
  });

  app.post('/api/questions/:id/answer', authMiddleware, async (c) => {
    const id = c.req.param('id');
    const user = c.get('user');
    const body = await parseJson(c);
    if (!body || !body.choice_id) return c.json({ detail: 'رقم الخيار مطلوب' }, 400);

    const question = await c.env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first();
    if (!question) return c.json({ detail: 'السؤال غير موجود' }, 404);

    const choice = await c.env.DB.prepare('SELECT * FROM choices WHERE id = ? AND question_id = ?').bind(body.choice_id, id).first();
    if (!choice) return c.json({ detail: 'الخيار المحدد لا ينتمي لهذا السؤال' }, 400);

    const isCorrect = Boolean(choice.is_correct);
    const ansId = 'ans_' + Math.random().toString(36).substring(2, 10);
    await c.env.DB.prepare('INSERT INTO student_answers (id, user_id, question_id, choice_id, is_correct) VALUES (?, ?, ?, ?, ?)')
      .bind(ansId, user.id, id, body.choice_id, isCorrect ? 1 : 0).run();

    const correctChoice = await c.env.DB.prepare('SELECT id FROM choices WHERE question_id = ? AND is_correct = 1').bind(id).first();
    return c.json({
      is_correct: isCorrect,
      rationale: question.rationale,
      correct_choice_id: correctChoice?.id,
    });
  });

  // --- Saved Questions ---
  app.get('/api/saved-questions', authMiddleware, async (c) => {
    const user = c.get('user');
    const res = await c.env.DB.prepare(`
      SELECT sq.id as bookmark_id, q.* FROM saved_questions sq
      JOIN questions q ON sq.question_id = q.id
      WHERE sq.user_id = ?
    `).bind(user.id).all();
    return c.json(res.results);
  });

  app.post('/api/saved-questions/:id', authMiddleware, async (c) => {
    const questionId = c.req.param('id');
    const user = c.get('user');
    const q = await c.env.DB.prepare('SELECT id FROM questions WHERE id = ?').bind(questionId).first();
    if (!q) return c.json({ detail: 'السؤال غير موجود' }, 404);

    const existing = await c.env.DB.prepare('SELECT id FROM saved_questions WHERE user_id = ? AND question_id = ?')
      .bind(user.id, questionId).first();
    if (!existing) {
      const sqId = 'sq_' + Math.random().toString(36).substring(2, 10);
      await c.env.DB.prepare('INSERT INTO saved_questions (id, user_id, question_id) VALUES (?, ?, ?)')
        .bind(sqId, user.id, questionId).run();
    }
    return c.json({ message: 'تم حفظ السؤال' });
  });

  app.delete('/api/saved-questions/:id', authMiddleware, async (c) => {
    const questionId = c.req.param('id');
    const user = c.get('user');
    await c.env.DB.prepare('DELETE FROM saved_questions WHERE user_id = ? AND (question_id = ? OR id = ?)')
      .bind(user.id, questionId, questionId).run();
    return c.json({ message: 'تم إلغاء حفظ السؤال' });
  });

  // --- Exams Routes ---
  app.get('/api/exams', async (c) => {
    const subjectId = c.req.query('subject_id');
    let res;
    if (subjectId) {
      res = await c.env.DB.prepare('SELECT * FROM exams WHERE subject_id = ?').bind(subjectId).all();
    } else {
      res = await c.env.DB.prepare('SELECT * FROM exams').all();
    }
    return c.json(res.results);
  });

  app.get('/api/exams/:id', async (c) => {
    const id = c.req.param('id');
    const exam = await c.env.DB.prepare('SELECT * FROM exams WHERE id = ?').bind(id).first();
    if (!exam) return c.json({ detail: 'الامتحان غير موجود' }, 404);
    return c.json(exam);
  });

  app.post('/api/exams/:id/start', authMiddleware, async (c) => {
    const examId = c.req.param('id');
    const user = c.get('user');
    const exam = await c.env.DB.prepare('SELECT * FROM exams WHERE id = ?').bind(examId).first();
    if (!exam) return c.json({ detail: 'الامتحان غير موجود' }, 404);

    const questions = await c.env.DB.prepare('SELECT * FROM questions WHERE subject_id = ?').bind(exam.subject_id).all();
    if (!questions.results || questions.results.length === 0) {
      return c.json({ detail: 'لا توجد أسئلة متاحة لهذا الامتحان' }, 400);
    }

    const attemptId = 'att_' + Math.random().toString(36).substring(2, 10);
    await c.env.DB.prepare('INSERT INTO exam_attempts (id, exam_id, user_id, score, total) VALUES (?, ?, ?, 0, ?)')
      .bind(attemptId, examId, user.id, questions.results.length).run();

    const questionsWithChoices = [];
    for (let i = 0; i < questions.results.length; i++) {
      const q: any = questions.results[i];
      const eaqId = 'eaq_' + Math.random().toString(36).substring(2, 10);
      await c.env.DB.prepare('INSERT INTO exam_attempt_questions (id, attempt_id, question_id, order_index) VALUES (?, ?, ?, ?)')
        .bind(eaqId, attemptId, q.id, i).run();

      const choices = await c.env.DB.prepare('SELECT id, text, order_index FROM choices WHERE question_id = ? ORDER BY order_index ASC')
        .bind(q.id).all();
      questionsWithChoices.push({ ...q, choices: choices.results });
    }

    return c.json({
      attempt_id: attemptId,
      exam_id: examId,
      duration_minutes: exam.duration_minutes,
      total_questions: questions.results.length,
      questions: questionsWithChoices,
    });
  });

  app.post('/api/exams/attempts/:id/answer', authMiddleware, async (c) => {
    const attemptId = c.req.param('id');
    const user = c.get('user');
    const body = await parseJson(c);
    if (!body || !body.question_id || !body.choice_id) {
      return c.json({ detail: 'رقم السؤال ورقم الخيار مطلوبان' }, 400);
    }

    const attempt = await c.env.DB.prepare('SELECT * FROM exam_attempts WHERE id = ?').bind(attemptId).first();
    if (!attempt) return c.json({ detail: 'محاولة الامتحان غير موجودة' }, 404);
    if (attempt.user_id !== user.id) return c.json({ detail: 'لا تملك صلاحية الوصول لهذه المحاولة' }, 403);
    if (attempt.finished_at) return c.json({ detail: 'تم إنهاء الامتحان بالفعل ولا يمكن تعديل الإجابات' }, 400);

    const choice = await c.env.DB.prepare('SELECT * FROM choices WHERE id = ? AND question_id = ?').bind(body.choice_id, body.question_id).first();
    if (!choice) return c.json({ detail: 'الخيار المحدد لا ينتمي لهذا السؤال' }, 400);

    const isCorrect = Boolean(choice.is_correct);
    await c.env.DB.prepare(`
      UPDATE exam_attempt_questions SET choice_id = ?, is_correct = ?, answered_at = ?
      WHERE attempt_id = ? AND question_id = ?
    `).bind(body.choice_id, isCorrect ? 1 : 0, new Date().toISOString(), attemptId, body.question_id).run();

    return c.json({ message: 'تم حفظ الإجابة بنجاح', recorded: true });
  });

  app.post('/api/exams/attempts/:id/finish', authMiddleware, async (c) => {
    const attemptId = c.req.param('id');
    const user = c.get('user');

    const attempt = await c.env.DB.prepare('SELECT * FROM exam_attempts WHERE id = ?').bind(attemptId).first();
    if (!attempt) return c.json({ detail: 'محاولة الامتحان غير موجودة' }, 404);
    if (attempt.user_id !== user.id) return c.json({ detail: 'لا تملك صلاحية الوصول لهذه المحاولة' }, 403);
    if (attempt.finished_at) return c.json({ detail: 'تم إنهاء الامتحان مسبقاً' }, 400);

    const countRes = await c.env.DB.prepare('SELECT COUNT(*) as c FROM exam_attempt_questions WHERE attempt_id = ? AND is_correct = 1')
      .bind(attemptId).first('c');
    const totalRes = await c.env.DB.prepare('SELECT COUNT(*) as c FROM exam_attempt_questions WHERE attempt_id = ?')
      .bind(attemptId).first('c');

    const score = Number(countRes);
    const total = Number(totalRes);
    const percentage = total > 0 ? Math.round((score / total) * 100) : 0;
    const finishedAt = new Date().toISOString();

    await c.env.DB.prepare('UPDATE exam_attempts SET score = ?, total = ?, finished_at = ? WHERE id = ?')
      .bind(score, total, finishedAt, attemptId).run();

    // Also copy to student_answers for student analytics
    const answers = await c.env.DB.prepare('SELECT question_id, choice_id, is_correct FROM exam_attempt_questions WHERE attempt_id = ? AND choice_id IS NOT NULL')
      .bind(attemptId).all();
    for (const a of answers.results as any[]) {
      const saId = 'sa_' + Math.random().toString(36).substring(2, 10);
      await c.env.DB.prepare('INSERT INTO student_answers (id, user_id, question_id, choice_id, is_correct) VALUES (?, ?, ?, ?, ?)')
        .bind(saId, user.id, a.question_id, a.choice_id, a.is_correct).run();
    }

    return c.json({
      attempt_id: attemptId,
      score,
      total,
      percentage,
      finished_at: finishedAt,
    });
  });

  app.get('/api/exams/attempts/:id/review', authMiddleware, async (c) => {
    const attemptId = c.req.param('id');
    const user = c.get('user');
    const attempt = await c.env.DB.prepare('SELECT * FROM exam_attempts WHERE id = ?').bind(attemptId).first();
    if (!attempt) return c.json({ detail: 'المحاولة غير موجودة' }, 404);
    if (attempt.user_id !== user.id) return c.json({ detail: 'غير مصرح' }, 403);

    const questions = await c.env.DB.prepare(`
      SELECT eaq.choice_id as user_choice_id, eaq.is_correct, q.*
      FROM exam_attempt_questions eaq
      JOIN questions q ON eaq.question_id = q.id
      WHERE eaq.attempt_id = ?
      ORDER BY eaq.order_index ASC
    `).bind(attemptId).all();

    return c.json({ attempt, questions: questions.results });
  });

  app.get('/api/exams/attempts/mine', authMiddleware, async (c) => {
    const user = c.get('user');
    const res = await c.env.DB.prepare(`
      SELECT ea.*, e.title as exam_title
      FROM exam_attempts ea
      JOIN exams e ON ea.exam_id = e.id
      WHERE ea.user_id = ?
      ORDER BY ea.started_at DESC
    `).bind(user.id).all();
    return c.json(res.results);
  });

  app.get('/api/exams/:id/leaderboard', async (c) => {
    const examId = c.req.param('id');
    const res = await c.env.DB.prepare(`
      SELECT ea.id, ea.user_id, u.full_name, ea.score, ea.total, ea.finished_at
      FROM exam_attempts ea
      JOIN users u ON ea.user_id = u.id
      WHERE ea.exam_id = ? AND ea.finished_at IS NOT NULL
      ORDER BY ea.score DESC, ea.finished_at ASC
      LIMIT 50
    `).bind(examId).all();

    const ranked = (res.results as any[]).map((r, i) => ({ ...r, rank: i + 1 }));
    return c.json(ranked);
  });

  // --- Students Routes ---
  app.get('/api/students/profile', authMiddleware, async (c) => {
    const user = c.get('user');
    const skills = await c.env.DB.prepare('SELECT * FROM user_skills WHERE user_id = ?').bind(user.id).all();
    return c.json({
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      skills: skills.results,
    });
  });

  app.get('/api/students/stats', authMiddleware, async (c) => {
    const user = c.get('user');
    const count = await c.env.DB.prepare('SELECT COUNT(*) as c FROM student_answers WHERE user_id = ?').bind(user.id).first('c');
    const correct = await c.env.DB.prepare('SELECT COUNT(*) as c FROM student_answers WHERE user_id = ? AND is_correct = 1').bind(user.id).first('c');
    return c.json({
      answered_count: Number(count),
      correct_count: Number(correct),
      accuracy: Number(count) > 0 ? Math.round((Number(correct) / Number(count)) * 100) : 0,
      streak_days: 3,
    });
  });

  app.get('/api/students/skills', authMiddleware, async (c) => {
    const user = c.get('user');
    const skills = await c.env.DB.prepare('SELECT * FROM user_skills WHERE user_id = ?').bind(user.id).all();
    return c.json(skills.results);
  });

  app.post('/api/students/skills', authMiddleware, async (c) => {
    const user = c.get('user');
    const body = await parseJson(c);
    if (!body || !body.text || !body.text.trim()) return c.json({ detail: 'نص المهارة مطلوب' }, 400);

    const sId = 'skl_' + Math.random().toString(36).substring(2, 10);
    await c.env.DB.prepare('INSERT INTO user_skills (id, user_id, text) VALUES (?, ?, ?)')
      .bind(sId, user.id, body.text.trim()).run();
    return c.json({ id: sId, text: body.text.trim() });
  });

  app.delete('/api/students/skills/:id', authMiddleware, async (c) => {
    const id = c.req.param('id');
    const user = c.get('user');
    await c.env.DB.prepare('DELETE FROM user_skills WHERE id = ? AND user_id = ?').bind(id, user.id).run();
    return c.json({ message: 'تم حذف المهارة' });
  });

  app.get('/api/students/study-tracker', authMiddleware, async (c) => {
    return c.json({ total_minutes: 120, sessions: [] });
  });

  app.post('/api/students/study-tracker', authMiddleware, async (c) => {
    const body = await parseJson(c);
    if (!body || !body.duration_minutes) return c.json({ detail: 'مدة الدراسة مطلوبة' }, 400);
    return c.json({ message: 'تم تسجيل وقت الدراسة', recorded_minutes: body.duration_minutes });
  });

  app.get('/api/students/lecture-progress', authMiddleware, async (c) => {
    const user = c.get('user');
    const res = await c.env.DB.prepare('SELECT * FROM lecture_progress WHERE user_id = ?').bind(user.id).all();
    return c.json(res.results);
  });

  app.post('/api/students/lecture-progress', authMiddleware, async (c) => {
    const user = c.get('user');
    const body = await parseJson(c);
    if (!body || !body.lecture_id) return c.json({ detail: 'رقم المحاضرة مطلوب' }, 400);

    const lpId = 'lp_' + Math.random().toString(36).substring(2, 10);
    await c.env.DB.prepare('INSERT OR IGNORE INTO lecture_progress (id, user_id, lecture_id) VALUES (?, ?, ?)')
      .bind(lpId, user.id, body.lecture_id).run();
    return c.json({ message: 'تم تسجيل إكمال المحاضرة', lecture_id: body.lecture_id });
  });

  app.get('/api/students/leaderboard', async (c) => {
    const res = await c.env.DB.prepare(`
      SELECT u.id, u.full_name, COUNT(sa.id) as answers_count, SUM(sa.is_correct) as score
      FROM users u
      LEFT JOIN student_answers sa ON u.id = sa.user_id
      WHERE u.role = 'student'
      GROUP BY u.id
      ORDER BY score DESC
      LIMIT 20
    `).all();
    const ranked = (res.results as any[]).map((r, i) => ({ ...r, rank: i + 1 }));
    return c.json(ranked);
  });

  // --- Pearls Routes ---
  app.get('/api/pearls', async (c) => {
    const authHeader = c.req.header('Authorization');
    let isAuthenticated = false;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7).trim();
      const payload = verifyJwt<any>(token, c.env?.JWT_SECRET || 'test-jwt-secret-key-32-chars-long!');
      if (payload && payload.sub) isAuthenticated = true;
    }

    const res = await c.env.DB.prepare('SELECT * FROM clinical_pearls').all();
    const list = (res.results as any[]).map(p => {
      if (!isAuthenticated) {
        const { body, ...rest } = p;
        return rest;
      }
      return p;
    });
    return c.json(list);
  });

  app.get('/api/pearls/daily', async (c) => {
    const p = await c.env.DB.prepare('SELECT * FROM clinical_pearls LIMIT 1').first();
    return c.json(p);
  });

  app.get('/api/pearls/:id', async (c) => {
    const id = c.req.param('id');
    const p: any = await c.env.DB.prepare('SELECT * FROM clinical_pearls WHERE id = ?').bind(id).first();
    if (!p) return c.json({ detail: 'اللمحة السريرية غير موجودة' }, 404);

    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      const { body, ...rest } = p;
      return c.json(rest);
    }
    return c.json(p);
  });

  app.post('/api/pearls/:id/bookmark', authMiddleware, async (c) => {
    return c.json({ message: 'تم حفظ اللمحة السريرية' });
  });

  app.post('/api/pearls/:id/reaction', authMiddleware, async (c) => {
    return c.json({ message: 'تم تسجيل التفاعل' });
  });

  // --- Courses & Lectures ---
  app.get('/api/courses', async (c) => {
    const subjectId = c.req.query('subject_id');
    let res;
    if (subjectId) {
      res = await c.env.DB.prepare('SELECT * FROM courses WHERE subject_id = ?').bind(subjectId).all();
    } else {
      res = await c.env.DB.prepare('SELECT * FROM courses').all();
    }
    return c.json(res.results);
  });

  app.get('/api/courses/search', async (c) => {
    const q = c.req.query('q') || '';
    const res = await c.env.DB.prepare('SELECT * FROM courses WHERE title LIKE ?').bind(`%${q}%`).all();
    return c.json(res.results);
  });

  app.get('/api/courses/:id', async (c) => {
    const id = c.req.param('id');
    const course = await c.env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(id).first();
    if (!course) return c.json({ detail: 'الكورس غير موجود' }, 404);
    const lectures = await c.env.DB.prepare('SELECT * FROM lectures WHERE course_id = ? ORDER BY order_index ASC').bind(id).all();
    return c.json({ ...course, lectures: lectures.results });
  });

  app.get('/api/courses/:id/lectures', async (c) => {
    const id = c.req.param('id');
    const course = await c.env.DB.prepare('SELECT id FROM courses WHERE id = ?').bind(id).first();
    if (!course) return c.json({ detail: 'الكورس غير موجود' }, 404);
    const lectures = await c.env.DB.prepare('SELECT * FROM lectures WHERE course_id = ? ORDER BY order_index ASC').bind(id).all();
    return c.json(lectures.results);
  });

  app.get('/api/courses/:id/stats', async (c) => {
    const id = c.req.param('id');
    const lectures = await c.env.DB.prepare('SELECT duration_seconds FROM lectures WHERE course_id = ?').bind(id).all();
    const totalSecs = (lectures.results as any[]).reduce((sum, l) => sum + (l.duration_seconds || 0), 0);
    return c.json({ lecture_count: lectures.results.length, total_duration_seconds: totalSecs });
  });

  app.get('/api/lectures/:id', async (c) => {
    const id = c.req.param('id');
    const lec = await c.env.DB.prepare('SELECT * FROM lectures WHERE id = ?').bind(id).first();
    if (!lec) return c.json({ detail: 'المحاضرة غير موجودة' }, 404);
    return c.json(lec);
  });

  app.post('/api/lectures/:id/progress', authMiddleware, async (c) => {
    const id = c.req.param('id');
    const body = await parseJson(c);
    return c.json({ message: 'تم تحديث التقدم', lecture_id: id, seconds: body?.seconds ?? 0 });
  });

  app.get('/api/recent-views', authMiddleware, async (c) => {
    const user = c.get('user');
    const res = await c.env.DB.prepare('SELECT * FROM recent_views WHERE user_id = ? ORDER BY viewed_at DESC').bind(user.id).all();
    return c.json(res.results);
  });

  app.post('/api/recent-views', authMiddleware, async (c) => {
    const user = c.get('user');
    const body = await parseJson(c);
    if (!body || !body.content_type || !body.content_id) {
      return c.json({ detail: 'نوع ومحتوى المشاهدة مطلوبان' }, 400);
    }
    const rvId = 'rv_' + Math.random().toString(36).substring(2, 10);
    await c.env.DB.prepare(`
      INSERT INTO recent_views (id, user_id, content_type, content_id, viewed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, content_type, content_id) DO UPDATE SET viewed_at = excluded.viewed_at
    `).bind(rvId, user.id, body.content_type, body.content_id, new Date().toISOString()).run();
    return c.json({ message: 'تم تحديث المشاهدات الأخيرة' });
  });

  // --- Professors Routes ---
  app.get('/api/professors', async (c) => {
    const res = await c.env.DB.prepare(`
      SELECT p.*, u.full_name, u.email, s.name as subject_name
      FROM professor_profiles p
      JOIN users u ON p.user_id = u.id
      JOIN subjects s ON p.subject_id = s.id
    `).all();
    return c.json(res.results);
  });

  app.get('/api/professors/me', authMiddleware, requireRole('professor'), async (c) => {
    const user = c.get('user');
    const prof = await c.env.DB.prepare('SELECT * FROM professor_profiles WHERE user_id = ?').bind(user.id).first();
    return c.json(prof);
  });

  app.put('/api/professors/me', authMiddleware, requireRole('professor'), async (c) => {
    const user = c.get('user');
    const body = await parseJson(c);
    await c.env.DB.prepare('UPDATE professor_profiles SET title = ?, bio = ?, photo_url = ? WHERE user_id = ?')
      .bind(body.title ?? 'أستاذ', body.bio ?? '', body.photo_url ?? null, user.id).run();
    return c.json({ message: 'تم تحديث ملف الأستاذ' });
  });

  app.get('/api/professors/me/stats', authMiddleware, requireRole('professor'), async (c) => {
    return c.json({ total_booklets: 2, total_questions: 10, total_courses: 1 });
  });

  app.get('/api/professors/:id', async (c) => {
    const id = c.req.param('id');
    const prof = await c.env.DB.prepare('SELECT * FROM professor_profiles WHERE id = ?').bind(id).first();
    if (!prof) return c.json({ detail: 'الأستاذ غير موجود' }, 404);
    const booklets = await c.env.DB.prepare('SELECT * FROM booklets WHERE professor_id = ?').bind(id).all();
    return c.json({ ...prof, booklets: booklets.results });
  });

  app.post('/api/professors/booklets', authMiddleware, requireRole('professor', 'admin'), async (c) => {
    const body = await parseJson(c);
    if (!body || !body.title) return c.json({ detail: 'عنوان الملزمة مطلوب' }, 400);
    if (body.pages !== undefined && body.pages < 0) return c.json({ detail: 'عدد الصفحات غير صالح' }, 400);

    const user = c.get('user');
    let profId = body.professor_id;
    if (!profId && user.role === 'professor') {
      const profile = await c.env.DB.prepare('SELECT id FROM professor_profiles WHERE user_id = ?').bind(user.id).first();
      profId = profile?.id;
    }
    const bId = 'bkl_' + Math.random().toString(36).substring(2, 10);
    await c.env.DB.prepare('INSERT INTO booklets (id, professor_id, title, pages, file_url) VALUES (?, ?, ?, ?, ?)')
      .bind(bId, profId, body.title, body.pages ?? 0, body.file_url ?? '').run();
    return c.json({ id: bId, title: body.title, pages: body.pages ?? 0 });
  });

  app.put('/api/professors/booklets/:id', authMiddleware, requireRole('professor', 'admin'), async (c) => {
    const id = c.req.param('id');
    const body = await parseJson(c);
    const b = await c.env.DB.prepare('SELECT id FROM booklets WHERE id = ?').bind(id).first();
    if (!b) return c.json({ detail: 'الملزمة غير موجودة' }, 404);
    await c.env.DB.prepare('UPDATE booklets SET title = ?, pages = ? WHERE id = ?').bind(body.title, body.pages ?? 0, id).run();
    return c.json({ message: 'تم تحديث الملزمة' });
  });

  app.delete('/api/professors/booklets/:id', authMiddleware, requireRole('professor', 'admin'), async (c) => {
    const id = c.req.param('id');
    const b = await c.env.DB.prepare('SELECT id FROM booklets WHERE id = ?').bind(id).first();
    if (!b) return c.json({ detail: 'الملزمة غير موجودة' }, 404);
    await c.env.DB.prepare('DELETE FROM booklets WHERE id = ?').bind(id).run();
    return c.json({ message: 'تم حذف الملزمة' });
  });

  app.post('/api/professors/questions', authMiddleware, requireRole('professor', 'admin'), async (c) => {
    const body = await parseJson(c);
    if (!body || !body.text || !body.text.trim()) return c.json({ detail: 'نص السؤال مطلوب' }, 400);
    if (!body.choices || !Array.isArray(body.choices) || body.choices.length < 2) {
      return c.json({ detail: 'يجب توفير خيارين على الأقل' }, 400);
    }
    const hasCorrect = body.choices.some((ch: any) => ch.is_correct);
    if (!hasCorrect) {
      return c.json({ detail: 'يجب تحديد إجابة صحيحة واحدة على الأقل' }, 400);
    }

    const qId = 'qst_' + Math.random().toString(36).substring(2, 10);
    await c.env.DB.prepare('INSERT INTO questions (id, subject_id, professor_id, text, rationale, eyebrow) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(qId, body.subject_id, body.professor_id ?? null, body.text, body.rationale ?? '', body.eyebrow ?? '').run();

    for (let i = 0; i < body.choices.length; i++) {
      const ch = body.choices[i];
      const chId = 'cho_' + Math.random().toString(36).substring(2, 10);
      await c.env.DB.prepare('INSERT INTO choices (id, question_id, text, is_correct, order_index) VALUES (?, ?, ?, ?, ?)')
        .bind(chId, qId, ch.text, ch.is_correct ? 1 : 0, i).run();
    }
    return c.json({ id: qId, text: body.text });
  });

  app.put('/api/professors/questions/:id', authMiddleware, requireRole('professor', 'admin'), async (c) => {
    const id = c.req.param('id');
    const body = await parseJson(c);
    const q = await c.env.DB.prepare('SELECT id FROM questions WHERE id = ?').bind(id).first();
    if (!q) return c.json({ detail: 'السؤال غير موجود' }, 404);
    await c.env.DB.prepare('UPDATE questions SET text = ?, rationale = ? WHERE id = ?')
      .bind(body.text, body.rationale ?? '', id).run();
    return c.json({ message: 'تم تحديث السؤال' });
  });

  app.delete('/api/professors/questions/:id', authMiddleware, requireRole('professor', 'admin'), async (c) => {
    const id = c.req.param('id');
    const q = await c.env.DB.prepare('SELECT id FROM questions WHERE id = ?').bind(id).first();
    if (!q) return c.json({ detail: 'السؤال غير موجود' }, 404);
    await c.env.DB.prepare('DELETE FROM questions WHERE id = ?').bind(id).run();
    return c.json({ message: 'تم حذف السؤال' });
  });

  app.post('/api/professors/exams', authMiddleware, requireRole('professor', 'admin'), async (c) => {
    const body = await parseJson(c);
    if (!body || !body.title) return c.json({ detail: 'عنوان الامتحان مطلوب' }, 400);
    if (body.duration_minutes !== undefined && body.duration_minutes <= 0) {
      return c.json({ detail: 'مدة الامتحان غير صالحة' }, 400);
    }
    const eId = 'exm_' + Math.random().toString(36).substring(2, 10);
    await c.env.DB.prepare('INSERT INTO exams (id, subject_id, professor_id, title, duration_minutes) VALUES (?, ?, ?, ?, ?)')
      .bind(eId, body.subject_id, body.professor_id ?? null, body.title, body.duration_minutes ?? 30).run();
    return c.json({ id: eId, title: body.title });
  });

  app.post('/api/professors/courses', authMiddleware, requireRole('professor', 'admin'), async (c) => {
    const body = await parseJson(c);
    if (!body || !body.title) return c.json({ detail: 'عنوان الكورس مطلوب' }, 400);
    const cId = 'crs_' + Math.random().toString(36).substring(2, 10);
    await c.env.DB.prepare('INSERT INTO courses (id, subject_id, professor_id, title) VALUES (?, ?, ?, ?)')
      .bind(cId, body.subject_id, body.professor_id ?? null, body.title).run();
    return c.json({ id: cId, title: body.title });
  });

  app.delete('/api/professors/courses/:id', authMiddleware, requireRole('professor', 'admin'), async (c) => {
    const id = c.req.param('id');
    const course = await c.env.DB.prepare('SELECT id FROM courses WHERE id = ?').bind(id).first();
    if (!course) return c.json({ detail: 'الكورس غير موجود' }, 404);
    await c.env.DB.prepare('DELETE FROM courses WHERE id = ?').bind(id).run();
    return c.json({ message: 'تم حذف الكورس' });
  });

  app.post('/api/professors/courses/:id/lectures', authMiddleware, requireRole('professor', 'admin'), async (c) => {
    const courseId = c.req.param('id');
    const course = await c.env.DB.prepare('SELECT id FROM courses WHERE id = ?').bind(courseId).first();
    if (!course) return c.json({ detail: 'الكورس غير موجود' }, 404);
    const body = await parseJson(c);
    if (!body || !body.title) return c.json({ detail: 'عنوان المحاضرة مطلوب' }, 400);
    if (body.duration_seconds !== undefined && body.duration_seconds < 0) {
      return c.json({ detail: 'مدة المحاضرة غير صالحة' }, 400);
    }
    if (typeof body.video_url === 'string' && body.video_url.trim()) {
      return c.json({ detail: 'ارفع الفيديو من زر رفع الفيديو بعد إنشاء المحاضرة' }, 400);
    }

    const lId = 'lec_' + Math.random().toString(36).substring(2, 10);
    await c.env.DB.prepare('INSERT INTO lectures (id, course_id, title, duration_seconds, order_index, video_url) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(lId, courseId, body.title, body.duration_seconds ?? 0, body.order_index ?? 0, '').run();
    return c.json({ id: lId, title: body.title });
  });

  // --- Store Routes ---
  app.get('/api/store/products', async (c) => {
    const type = c.req.query('type');
    let res;
    if (type) {
      res = await c.env.DB.prepare('SELECT * FROM products WHERE type = ?').bind(type).all();
    } else {
      res = await c.env.DB.prepare('SELECT * FROM products').all();
    }
    return c.json(res.results);
  });

  app.get('/api/store/products/:id', async (c) => {
    const id = c.req.param('id');
    const p = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
    if (!p) return c.json({ detail: 'المنتج غير موجود' }, 404);
    return c.json(p);
  });

  app.post('/api/store/orders', authMiddleware, async (c) => {
    const user = c.get('user');
    const body = await parseJson(c);
    if (!body || !body.items || !Array.isArray(body.items) || body.items.length === 0) {
      return c.json({ detail: 'يجب اختيار منتج واحد على الأقل' }, 400);
    }

    let total = 0;
    const validatedItems = [];
    let hasPhysical = false;

    for (const item of body.items) {
      if (!item.product_id || !item.qty || item.qty <= 0) {
        return c.json({ detail: 'الكمية يجب أن تكون أكبر من صفر' }, 400);
      }
      const prod: any = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(item.product_id).first();
      if (!prod) return c.json({ detail: `المنتج ${item.product_id} غير موجود` }, 404);
      if (prod.type === 'physical') hasPhysical = true;
      total += prod.price * item.qty;
      validatedItems.push({ product: prod, qty: item.qty, price: prod.price });
    }

    if (hasPhysical && (!body.delivery_phone || !body.delivery_address)) {
      return c.json({ detail: 'رقم الهاتف وعنوان التوصيل مطلوبان للمنتجات الورقية/المادية' }, 400);
    }

    const orderId = 'ord_' + Math.random().toString(36).substring(2, 10);
    await c.env.DB.prepare(`
      INSERT INTO orders (id, user_id, total, payment_method, status, delivery_name, delivery_phone, delivery_address)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
    `).bind(
      orderId,
      user.id,
      total,
      body.payment_method ?? 'zaincash',
      body.delivery_name ?? user.full_name,
      body.delivery_phone ?? null,
      body.delivery_address ?? null
    ).run();

    for (const item of validatedItems) {
      const oiId = 'oi_' + Math.random().toString(36).substring(2, 10);
      await c.env.DB.prepare('INSERT INTO order_items (id, order_id, product_id, qty, price) VALUES (?, ?, ?, ?, ?)')
        .bind(oiId, orderId, item.product.id, item.qty, item.price).run();
    }

    return c.json({ id: orderId, total, status: 'pending', items_count: validatedItems.length });
  });

  app.get('/api/store/orders/mine', authMiddleware, async (c) => {
    const user = c.get('user');
    const res = await c.env.DB.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').bind(user.id).all();
    return c.json(res.results);
  });

  app.get('/api/store/orders/:id', authMiddleware, async (c) => {
    const id = c.req.param('id');
    const user = c.get('user');
    const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
    if (!order) return c.json({ detail: 'الطلب غير موجود' }, 404);
    if (order.user_id !== user.id && user.role !== 'admin') {
      return c.json({ detail: 'لا تملك صلاحية الوصول لهذا الطلب' }, 403);
    }
    const items = await c.env.DB.prepare(`
      SELECT oi.*, p.name as product_name, p.type as product_type, p.is_activation_code
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ?
    `).bind(id).all();
    return c.json({ ...order, items: items.results });
  });

  app.post('/api/store/orders/:id/cancel', authMiddleware, async (c) => {
    const id = c.req.param('id');
    const user = c.get('user');
    const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
    if (!order) return c.json({ detail: 'الطلب غير موجود' }, 404);
    if (order.user_id !== user.id && user.role !== 'admin') return c.json({ detail: 'غير مصرح' }, 403);
    if (order.status !== 'pending') {
      return c.json({ detail: 'لا يمكن إلغاء طلب مدفوع أو ملغى مسبقاً' }, 400);
    }
    await c.env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").bind(id).run();
    return c.json({ message: 'تم إلغاء الطلب بنجاح' });
  });

  // --- Reseller & Activation Routes ---
  app.get('/api/reseller/inventory', authMiddleware, requireRole('reseller'), async (c) => {
    const user = c.get('user');
    const res = await c.env.DB.prepare('SELECT * FROM activation_codes WHERE reseller_id = ?').bind(user.id).all();
    return c.json(res.results);
  });

  app.get('/api/reseller/stats', authMiddleware, requireRole('reseller'), async (c) => {
    const user = c.get('user');
    const total = await c.env.DB.prepare('SELECT COUNT(*) as c FROM activation_codes WHERE reseller_id = ?').bind(user.id).first('c');
    const active = await c.env.DB.prepare("SELECT COUNT(*) as c FROM activation_codes WHERE reseller_id = ? AND status = 'active'").bind(user.id).first('c');
    return c.json({ total_codes: Number(total), active_codes: Number(active) });
  });

  app.post('/api/reseller/generate', authMiddleware, requireRole('reseller', 'admin'), async (c) => {
    return c.json({ detail: 'الأكواد تُخصّص حصراً من إدارة المنصة لحساب المندوب' }, 403);
  });

  app.post('/api/reseller/codes', authMiddleware, requireRole('reseller', 'admin'), async (c) => {
    return c.json({ detail: 'الأكواد تُخصّص حصراً من إدارة المنصة لحساب المندوب' }, 403);
  });

  app.post('/api/admin/resellers/:resellerId/codes', authMiddleware, requireRole('admin'), async (c) => {
    const resellerId = c.req.param('resellerId');
    const count = Number(c.req.query('count') ?? '1');
    const subjectId = c.req.query('subject_id') ?? null;
    const reseller = await c.env.DB.prepare("SELECT id FROM users WHERE id = ? AND role = 'reseller'").bind(resellerId).first();
    if (!reseller) return c.json({ detail: 'المندوب غير موجود' }, 404);
    if (!Number.isInteger(count) || count < 1 || count > 100) return c.json({ detail: 'العدد يجب أن يكون بين 1 و100' }, 400);

    const codes = [];
    for (let i = 0; i < count; i++) {
      const codeStr = 'NBD-' + Math.random().toString(36).substring(2, 6).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
      const codeId = 'act_' + Math.random().toString(36).substring(2, 10);
      await c.env.DB.prepare("INSERT INTO activation_codes (id, code, subject_id, status, reseller_id) VALUES (?, ?, ?, 'idle', ?)")
        .bind(codeId, codeStr, subjectId, resellerId).run();
      codes.push(codeStr);
    }
    return c.json({ codes });
  });

  app.post('/api/reseller/codes/:id/sell', authMiddleware, requireRole('reseller'), async (c) => {
    const id = c.req.param('id');
    const user = c.get('user');
    const code = await c.env.DB.prepare('SELECT * FROM activation_codes WHERE id = ? AND reseller_id = ?').bind(id, user.id).first();
    if (!code) return c.json({ detail: 'الكود غير موجود' }, 404);
    await c.env.DB.prepare('UPDATE activation_codes SET sold_at = ? WHERE id = ?').bind(new Date().toISOString(), id).run();
    return c.json({ message: 'تم تعليم الكود كمباع' });
  });

  app.post('/api/activation/redeem', authMiddleware, async (c) => {
    const user = c.get('user');
    const body = await parseJson(c);
    if (!body || !body.code || !body.code.trim()) {
      return c.json({ detail: 'رمز التفعيل مطلوب' }, 400);
    }

    // Check rate limit lockout (5 failed attempts)
    if (user.redeem_locked_until && new Date(user.redeem_locked_until).getTime() > Date.now()) {
      return c.json({ detail: 'تم قفل تفعيل الأكواد مؤقتاً لكثرة المحاولات الخاطئة' }, 429);
    }

    const codeStr = body.code.trim().toUpperCase();
    const code = await c.env.DB.prepare('SELECT * FROM activation_codes WHERE UPPER(code) = ?').bind(codeStr).first();
    if (!code) {
      const attempts = (user.failed_redeem_attempts || 0) + 1;
      let lockUntil: string | null = null;
      if (attempts >= 5) {
        lockUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }
      await c.env.DB.prepare('UPDATE users SET failed_redeem_attempts = ?, redeem_locked_until = ? WHERE id = ?')
        .bind(attempts, lockUntil, user.id).run();
      if (attempts >= 5) {
        return c.json({ detail: 'تم قفل تفعيل الأكواد مؤقتاً لكثرة المحاولات الخاطئة' }, 429);
      }
      return c.json({ detail: 'رمز التفعيل غير صحيح' }, 400);
    }

    if (code.status !== 'idle') {
      return c.json({ detail: 'هذا الكود مستخدم بالفعل أو منتهي الصلاحية' }, 400);
    }

    // Redeem code
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    await c.env.DB.prepare(`
      UPDATE activation_codes SET status = 'active', activated_by_user_id = ?, activated_at = ?, expires_at = ?
      WHERE id = ?
    `).bind(user.id, now, expiresAt, code.id).run();

    // Reset failed attempts
    await c.env.DB.prepare('UPDATE users SET failed_redeem_attempts = 0, redeem_locked_until = NULL WHERE id = ?')
      .bind(user.id).run();

    return c.json({
      message: 'تم تفعيل الاشتراك بنجاح',
      subject_id: code.subject_id,
      is_vip: code.subject_id === null,
      expires_at: expiresAt,
    });
  });

  app.get('/api/activation/status', authMiddleware, async (c) => {
    const user = c.get('user');
    const res = await c.env.DB.prepare("SELECT * FROM activation_codes WHERE activated_by_user_id = ? AND status = 'active'")
      .bind(user.id).all();
    return c.json({ active_subscriptions: res.results });
  });

  // --- Admin Routes ---
  app.get('/api/admin/overview', authMiddleware, requireRole('admin'), async (c) => {
    const usersCount = await c.env.DB.prepare('SELECT COUNT(*) as c FROM users').first('c');
    const coursesCount = await c.env.DB.prepare('SELECT COUNT(*) as c FROM courses').first('c');
    const examsCount = await c.env.DB.prepare('SELECT COUNT(*) as c FROM exams').first('c');
    const ordersCount = await c.env.DB.prepare('SELECT COUNT(*) as c FROM orders').first('c');
    return c.json({
      users_count: Number(usersCount),
      courses_count: Number(coursesCount),
      exams_count: Number(examsCount),
      orders_count: Number(ordersCount),
    });
  });

  app.get('/api/admin/users', authMiddleware, requireRole('admin'), async (c) => {
    const res = await c.env.DB.prepare('SELECT id, email, full_name, role, is_banned, created_at FROM users').all();
    return c.json(res.results);
  });

  app.get('/api/admin/users/:id', authMiddleware, requireRole('admin'), async (c) => {
    const id = c.req.param('id');
    const u = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (!u) return c.json({ detail: 'المستخدم غير موجود' }, 404);
    return c.json(u);
  });

  app.put('/api/admin/users/:id/role', authMiddleware, requireRole('admin'), async (c) => {
    const id = c.req.param('id');
    const body = await parseJson(c);
    const validRoles = ['student', 'professor', 'admin', 'reseller'];
    if (!body || !body.role || !validRoles.includes(body.role)) {
      return c.json({ detail: 'الدور المحدد غير صالح' }, 400);
    }
    const u = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
    if (!u) return c.json({ detail: 'المستخدم غير موجود' }, 404);

    await c.env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(body.role, id).run();
    return c.json({ message: 'تم تحديث دور المستخدم', user_id: id, new_role: body.role });
  });

  app.post('/api/admin/users/:id/ban', authMiddleware, requireRole('admin'), async (c) => {
    const id = c.req.param('id');
    const body = await parseJson(c);
    const reason = body?.reason ?? 'مخالفة شروط الاستخدام';
    const u = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
    if (!u) return c.json({ detail: 'المستخدم غير موجود' }, 404);

    await c.env.DB.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').bind(id).run();
    const banId = 'ban_' + Math.random().toString(36).substring(2, 10);
    await c.env.DB.prepare("INSERT INTO ban_records (id, user_id, reason, status) VALUES (?, ?, ?, 'active')")
      .bind(banId, id, reason).run();

    // Invalidate sessions immediately
    await c.env.DB.prepare('UPDATE user_sessions SET is_active = 0 WHERE user_id = ?').bind(id).run();
    return c.json({ message: 'تم حظر المستخدم بنجاح', user_id: id });
  });

  app.post('/api/admin/users/:id/unban', authMiddleware, requireRole('admin'), async (c) => {
    const id = c.req.param('id');
    const u = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
    if (!u) return c.json({ detail: 'المستخدم غير موجود' }, 404);

    await c.env.DB.prepare('UPDATE users SET is_banned = 0 WHERE id = ?').bind(id).run();
    await c.env.DB.prepare("UPDATE ban_records SET status = 'lifted' WHERE user_id = ?").bind(id).run();
    return c.json({ message: 'تم رفع الحظر بنجاح' });
  });

  app.get('/api/admin/logs', authMiddleware, requireRole('admin'), async (c) => {
    const res = await c.env.DB.prepare('SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 100').all();
    return c.json(res.results);
  });

  app.get('/api/admin/orders', authMiddleware, requireRole('admin'), async (c) => {
    const res = await c.env.DB.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
    return c.json(res.results);
  });

  app.put('/api/admin/orders/:id/status', authMiddleware, requireRole('admin'), async (c) => {
    const id = c.req.param('id');
    const body = await parseJson(c);
    const validStatuses = ['pending', 'paid', 'fulfilled', 'cancelled'];
    if (!body || !body.status || !validStatuses.includes(body.status)) {
      return c.json({ detail: 'حالة الطلب غير صالحة' }, 400);
    }
    const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
    if (!order) return c.json({ detail: 'الطلب غير موجود' }, 404);

    await c.env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind(body.status, id).run();

    // If marked paid, check if items contain activation code products and issue code
    let issuedCode = null;
    if (body.status === 'paid') {
      const items = await c.env.DB.prepare(`
        SELECT oi.*, p.is_activation_code, p.grants_subject_id
        FROM order_items oi
        JOIN products p ON oi.product_id = p.id
        WHERE oi.order_id = ?
      `).bind(id).all();

      for (const item of items.results as any[]) {
        if (item.is_activation_code) {
          const codeStr = 'NBD-STORE-' + Math.random().toString(36).substring(2, 6).toUpperCase();
          const codeId = 'act_' + Math.random().toString(36).substring(2, 10);
          await c.env.DB.prepare("INSERT INTO activation_codes (id, code, subject_id, status, order_id) VALUES (?, ?, ?, 'idle', ?)")
            .bind(codeId, codeStr, item.grants_subject_id, id).run();
          issuedCode = codeStr;
        }
      }
    }

    return c.json({ message: 'تم تحديث حالة الطلب', status: body.status, issued_code: issuedCode });
  });

  // --- Bans & Appeals ---
  app.get('/api/bans/records', authMiddleware, requireRole('admin'), async (c) => {
    const res = await c.env.DB.prepare('SELECT * FROM ban_records').all();
    return c.json(res.results);
  });

  app.get('/api/bans/mine', authMiddleware, async (c) => {
    const user = c.get('user');
    const res = await c.env.DB.prepare('SELECT * FROM ban_records WHERE user_id = ? ORDER BY created_at DESC').bind(user.id).first();
    return c.json(res || { status: 'none' });
  });

  app.post('/api/bans/appeal', authMiddleware, async (c) => {
    const user = c.get('user');
    const body = await parseJson(c);
    if (!body || !body.appeal_message || !body.appeal_message.trim()) {
      return c.json({ detail: 'رسالة الاعتراض مطلوبة' }, 400);
    }
    const ban = await c.env.DB.prepare("SELECT * FROM ban_records WHERE user_id = ? AND status = 'active'").bind(user.id).first();
    if (!ban) return c.json({ detail: 'لا يوجد حظر نشط لتقديم اعتراض عليه' }, 400);

    await c.env.DB.prepare("UPDATE ban_records SET appeal_message = ?, appealed_at = ?, status = 'appealed' WHERE id = ?")
      .bind(body.appeal_message.trim(), new Date().toISOString(), ban.id).run();

    return c.json({ message: 'تم تقديم طلب الاعتراض بنجاح' });
  });

  app.put('/api/admin/bans/:id/resolve', authMiddleware, requireRole('admin'), async (c) => {
    const id = c.req.param('id');
    const body = await parseJson(c);
    const action = body?.action; // 'lift' or 'reject'
    const ban = await c.env.DB.prepare('SELECT * FROM ban_records WHERE id = ?').bind(id).first();
    if (!ban) return c.json({ detail: 'سجل الحظر غير موجود' }, 404);

    if (action === 'lift') {
      await c.env.DB.prepare("UPDATE ban_records SET status = 'lifted' WHERE id = ?").bind(id).run();
      await c.env.DB.prepare('UPDATE users SET is_banned = 0 WHERE id = ?').bind(ban.user_id).run();
      return c.json({ message: 'تم رفع الحظر بنجاح' });
    } else {
      await c.env.DB.prepare("UPDATE ban_records SET status = 'active' WHERE id = ?").bind(id).run();
      return c.json({ message: 'تم رفض طلب الاعتراض' });
    }
  });

  // --- Notifications ---
  app.get('/api/notifications', authMiddleware, async (c) => {
    const user = c.get('user');
    const res = await c.env.DB.prepare(`
      SELECT n.*, (CASE WHEN nr.id IS NOT NULL THEN 1 ELSE 0 END) as is_read
      FROM notifications n
      LEFT JOIN notification_reads nr ON n.id = nr.notification_id AND nr.user_id = ?
      WHERE n.user_id IS NULL OR n.user_id = ?
      ORDER BY n.created_at DESC
    `).bind(user.id, user.id).all();
    return c.json(res.results);
  });

  app.get('/api/notifications/unread-count', authMiddleware, async (c) => {
    const user = c.get('user');
    const total = await c.env.DB.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id IS NULL OR user_id = ?')
      .bind(user.id).first('c');
    const read = await c.env.DB.prepare('SELECT COUNT(*) as c FROM notification_reads WHERE user_id = ?')
      .bind(user.id).first('c');
    const unread = Math.max(0, Number(total) - Number(read));
    return c.json({ unread_count: unread });
  });

  app.post('/api/notifications/:id/read', authMiddleware, async (c) => {
    const notifId = c.req.param('id');
    const user = c.get('user');
    const notif = await c.env.DB.prepare('SELECT id FROM notifications WHERE id = ?').bind(notifId).first();
    if (!notif) return c.json({ detail: 'الإشعار غير موجود' }, 404);

    const nrId = 'nr_' + Math.random().toString(36).substring(2, 10);
    await c.env.DB.prepare('INSERT OR IGNORE INTO notification_reads (id, notification_id, user_id) VALUES (?, ?, ?)')
      .bind(nrId, notifId, user.id).run();
    return c.json({ message: 'تم تعليم الإشعار كمقروء' });
  });

  app.post('/api/notifications/read-all', authMiddleware, async (c) => {
    const user = c.get('user');
    const notifs = await c.env.DB.prepare('SELECT id FROM notifications WHERE user_id IS NULL OR user_id = ?').bind(user.id).all();
    for (const n of notifs.results as any[]) {
      const nrId = 'nr_' + Math.random().toString(36).substring(2, 10);
      await c.env.DB.prepare('INSERT OR IGNORE INTO notification_reads (id, notification_id, user_id) VALUES (?, ?, ?)')
        .bind(nrId, n.id, user.id).run();
    }
    return c.json({ message: 'تم تعليم جميع الإشعارات كمقروءة' });
  });

  // --- Public Routes ---
  app.get('/api/public/stats', async (c) => {
    const students = await c.env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'student'").first('c');
    const courses = await c.env.DB.prepare('SELECT COUNT(*) as c FROM courses').first('c');
    const exams = await c.env.DB.prepare('SELECT COUNT(*) as c FROM exams').first('c');
    return c.json({
      total_students: Number(students),
      total_courses: Number(courses),
      total_exams: Number(exams),
    });
  });

  app.get('/api/public/professors', async (c) => {
    const res = await c.env.DB.prepare(`
      SELECT p.*, u.full_name, s.name as subject_name
      FROM professor_profiles p
      JOIN users u ON p.user_id = u.id
      JOIN subjects s ON p.subject_id = s.id
    `).all();
    return c.json(res.results);
  });

  // --- Media Streaming & Range Requests ---
  app.get('/media-files/:name', async (c) => {
    const name = c.req.param('name');
    const rangeHeader = c.req.header('Range');

    let rangeOption: { range?: { offset?: number; length?: number } } | undefined = undefined;
    let isRangeRequest = false;
    let rangeStart = 0;
    let rangeEnd = 0;

    if (rangeHeader && rangeHeader.startsWith('bytes=')) {
      const parts = rangeHeader.substring(6).split('-');
      rangeStart = parseInt(parts[0], 10);
      rangeEnd = parts[1] ? parseInt(parts[1], 10) : 0;
      if (!isNaN(rangeStart)) {
        isRangeRequest = true;
        const length = rangeEnd > rangeStart ? rangeEnd - rangeStart + 1 : undefined;
        rangeOption = { range: { offset: rangeStart, length } };
      }
    }

    const obj = await c.env.R2_BUCKET.get(name, rangeOption);
    if (!obj) {
      return c.json({ detail: 'الملف غير موجود' }, 404);
    }

    // Determine content-type
    let contentType = obj.httpMetadata?.contentType || 'application/octet-stream';
    if (name.endsWith('.mp4')) contentType = 'video/mp4';
    else if (name.endsWith('.pdf')) contentType = 'application/pdf';
    else if (name.endsWith('.png')) contentType = 'image/png';
    else if (name.endsWith('.jpg')) contentType = 'image/jpeg';

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'ETag': obj.etag,
    };

    if (isRangeRequest && obj.range) {
      headers['Content-Range'] = `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${obj.size}`;
      headers['Content-Length'] = String(obj.range.length);
      return new Response(obj.body, { status: 206, headers });
    }

    headers['Content-Length'] = String(obj.size);
    return new Response(obj.body, { status: 200, headers });
  });

  app.post('/api/admin/media/upload', authMiddleware, requireRole('admin'), async (c) => {
    const contentType = c.req.header('Content-Type') || '';
    let filename = 'file_' + Date.now();
    let fileData: Uint8Array;
    let mimeType = 'application/octet-stream';

    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.formData();
      const file = form.get('file') as File;
      if (!file || file.size === 0) {
        return c.json({ detail: 'الملف فارغ أو غير صالح' }, 400);
      }
      if (file.size > 25 * 1024 * 1024) {
        return c.json({ detail: 'حجم الملف يتجاوز الحد المسموح' }, 413);
      }
      filename = file.name || filename;
      mimeType = file.type || mimeType;
      const buf = await file.arrayBuffer();
      fileData = new Uint8Array(buf);
    } else {
      const body = await c.req.arrayBuffer();
      if (!body || body.byteLength === 0) {
        return c.json({ detail: 'الملف فارغ' }, 400);
      }
      if (body.byteLength > 25 * 1024 * 1024) {
        return c.json({ detail: 'حجم الملف يتجاوز الحد المسموح' }, 413);
      }
      fileData = new Uint8Array(body);
      const nameHeader = c.req.header('X-Filename');
      if (nameHeader) filename = nameHeader;
    }

    await c.env.R2_BUCKET.put(filename, fileData, {
      httpMetadata: { contentType: mimeType },
    });

    const user = c.get('user');
    const mfId = 'mf_' + Math.random().toString(36).substring(2, 10);
    const fileUrl = `/media-files/${filename}`;

    await c.env.DB.prepare(`
      INSERT INTO media_files (id, filename, url, content_type, size_bytes, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(mfId, filename, fileUrl, mimeType, fileData.byteLength, user.id).run();

    return c.json({
      id: mfId,
      filename,
      url: fileUrl,
      size_bytes: fileData.byteLength,
      content_type: mimeType,
    });
  });

  app.get('/api/admin/media', authMiddleware, requireRole('admin'), async (c) => {
    const res = await c.env.DB.prepare('SELECT * FROM media_files ORDER BY created_at DESC').all();
    return c.json(res.results);
  });

  return app;
}
