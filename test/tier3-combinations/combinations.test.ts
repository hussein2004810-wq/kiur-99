import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';
import { generateTotpCode } from '../harness/crypto-helpers';

describe('Tier 3: Cross-Feature Combinations & Sequential Interactions', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('C3.1 [Auth + Anti-Piracy]: Login on Device A then Device B should evict Device A session with 401', async () => {
    // Device A Login
    const loginA = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: ctx.fixtures.users.student.email, password: 'Nabd@2026', device_label: 'Device A' },
    }, ctx);
    const tokenA = (await loginA.json()).access_token;

    // Device A can access profile
    const resA1 = await apiRequest(app, 'GET', '/auth/me', { token: tokenA }, ctx);
    expect(resA1.status).toBe(200);

    // Device B Login (causes single-session eviction)
    const loginB = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: ctx.fixtures.users.student.email, password: 'Nabd@2026', device_label: 'Device B' },
    }, ctx);
    const tokenB = (await loginB.json()).access_token;

    // Device B works
    const resB = await apiRequest(app, 'GET', '/auth/me', { token: tokenB }, ctx);
    expect(resB.status).toBe(200);

    // Device A is evicted (401 with Arabic eviction message)
    const resA2 = await apiRequest(app, 'GET', '/auth/me', { token: tokenA }, ctx);
    expect(resA2.status).toBe(401);
    const dataA2 = await resA2.json();
    expect(dataA2.detail).toContain('جهاز آخر');
  });

  it('C3.2 [Password Change + Session Eviction]: Changing password should immediately invalidate current session', async () => {
    const loginRes = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: ctx.fixtures.users.student.email, password: 'Nabd@2026' },
    }, ctx);
    const token = (await loginRes.json()).access_token;

    // Change password
    const chgRes = await apiRequest(app, 'POST', '/auth/change-password', {
      token,
      body: { old_password: 'Nabd@2026', new_password: 'BrandNewPassword2026!' },
    }, ctx);
    expect(chgRes.status).toBe(200);

    // Token should now be rejected
    const meRes = await apiRequest(app, 'GET', '/auth/me', { token }, ctx);
    expect(meRes.status).toBe(401);

    // Login with new password works
    const newLoginRes = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: ctx.fixtures.users.student.email, password: 'BrandNewPassword2026!' },
    }, ctx);
    expect(newLoginRes.status).toBe(200);
  });

  it('C3.3 [Password Reset + Login Flow]: Forgot password -> Reset password -> Login with new credentials', async () => {
    // 1. Request reset
    const forgotRes = await apiRequest(app, 'POST', '/auth/forgot-password', {
      body: { email: ctx.fixtures.users.student.email },
    }, ctx);
    expect(forgotRes.status).toBe(200);
    const rawToken = (await forgotRes.json()).debug_token;

    // 2. Perform reset
    const resetRes = await apiRequest(app, 'POST', '/auth/reset-password', {
      body: { token: rawToken, new_password: 'RecoveredPassword123!' },
    }, ctx);
    expect(resetRes.status).toBe(200);

    // 3. Login with old password fails
    const oldLogin = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: ctx.fixtures.users.student.email, password: 'Nabd@2026' },
    }, ctx);
    expect(oldLogin.status).toBe(401);

    // 4. Login with new password succeeds
    const newLogin = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: ctx.fixtures.users.student.email, password: 'RecoveredPassword123!' },
    }, ctx);
    expect(newLogin.status).toBe(200);
  });

  it('C3.4 [2FA Setup + Login Challenge]: Enable 2FA -> Login challenge -> Verify code -> Establish active session', async () => {
    // 1. Setup 2FA
    const setupRes = await apiRequest(app, 'POST', '/auth/2fa/setup', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { secret } = await setupRes.json();
    const setupCode = generateTotpCode(secret);

    // 2. Enable 2FA
    const verifyRes = await apiRequest(app, 'POST', '/auth/2fa/verify', {
      token: ctx.fixtures.users.student.token,
      body: { code: setupCode },
    }, ctx);
    expect(verifyRes.status).toBe(200);

    // 3. Next Login yields challenge
    const challengeRes = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: ctx.fixtures.users.student.email, password: 'Nabd@2026' },
    }, ctx);
    expect(challengeRes.status).toBe(200);
    const { requires_2fa, pending_token } = await challengeRes.json();
    expect(requires_2fa).toBe(true);

    // 4. Submit 2FA Code
    const code = generateTotpCode(secret);
    const login2Res = await apiRequest(app, 'POST', '/auth/2fa/login', {
      body: { pending_token, code },
    }, ctx);
    expect(login2Res.status).toBe(200);
    const finalToken = (await login2Res.json()).access_token;

    // 5. Authenticated call
    const meRes = await apiRequest(app, 'GET', '/auth/me', { token: finalToken }, ctx);
    expect(meRes.status).toBe(200);
  });

  it('C3.5 [2FA Disable + Direct Login]: Disable 2FA -> Login returns access token without 2FA prompt', async () => {
    // Setup and enable
    const setupRes = await apiRequest(app, 'POST', '/auth/2fa/setup', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { secret } = await setupRes.json();
    await apiRequest(app, 'POST', '/auth/2fa/verify', {
      token: ctx.fixtures.users.student.token,
      body: { code: generateTotpCode(secret) },
    }, ctx);

    // Disable 2FA
    const disableRes = await apiRequest(app, 'POST', '/auth/2fa/disable', {
      token: ctx.fixtures.users.student.token,
      body: { code: generateTotpCode(secret) },
    }, ctx);
    expect(disableRes.status).toBe(200);

    // Direct Login
    const directLogin = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: ctx.fixtures.users.student.email, password: 'Nabd@2026' },
    }, ctx);
    expect(directLogin.status).toBe(200);
    const data = await directLogin.json();
    expect(data.access_token).toBeDefined();
    expect(data.requires_2fa).toBeUndefined();
  });

  it('C3.6 [Registration + Profile Match]: Registered student profile matches submitted academic metadata', async () => {
    const regRes = await apiRequest(app, 'POST', '/auth/register', {
      body: {
        email: 'meta_student@test.com',
        full_name: 'طالب التسجيل المتكامل',
        password: 'Password123!',
        university_id: ctx.fixtures.universityId,
        stage_id: ctx.fixtures.stageId,
        section_id: ctx.fixtures.sectionId,
        phone: '07705554433',
      },
    }, ctx);
    expect(regRes.status).toBe(200);
    const registration = await regRes.json();
    expect(registration.requires_email_verification).toBe(true);
    const me = await ctx.db.prepare('SELECT full_name, university_id, stage_id, phone FROM users WHERE id = ?').bind(registration.user_id).first<any>();
    expect(me.full_name).toBe('طالب التسجيل المتكامل');
    expect(me.university_id).toBe(ctx.fixtures.universityId);
    expect(me.stage_id).toBe(ctx.fixtures.stageId);
    expect(me.phone).toBe('07705554433');
  });

  it('C3.7 [Catalog Tree Navigation]: Traverse Section -> University -> Stage -> Subject -> Booklets list', async () => {
    // 1. Sections
    const secRes = await apiRequest(app, 'GET', '/api/catalog/sections', {}, ctx);
    const secId = (await secRes.json())[0].id;

    // 2. University
    const uniRes = await apiRequest(app, 'GET', `/api/catalog/universities?section_id=${secId}`, {}, ctx);
    const uniId = (await uniRes.json())[0].id;

    // 3. Stage
    const stgRes = await apiRequest(app, 'GET', `/api/catalog/stages?university_id=${uniId}`, {}, ctx);
    const stgId = (await stgRes.json())[0].id;

    // 4. Subject
    const subRes = await apiRequest(app, 'GET', `/api/catalog/subjects?stage_id=${stgId}`, {}, ctx);
    const subId = (await subRes.json())[0].id;

    // 5. Booklets
    const bklRes = await apiRequest(app, 'GET', `/api/catalog/subjects/${subId}/booklets`, {}, ctx);
    expect(bklRes.status).toBe(200);
    const booklets = await bklRes.json();
    expect(Array.isArray(booklets)).toBe(true);
    expect(booklets.length).toBeGreaterThan(0);
  });

  it('C3.8 [Question Practice + Stats]: Answering question correctly increments correct_count and answered_count', async () => {
    const statsBefore = await (await apiRequest(app, 'GET', '/api/students/stats', { token: ctx.fixtures.users.student.token }, ctx)).json();

    const qId = ctx.fixtures.questionIds[0];
    const correctChoice = await ctx.db.prepare('SELECT id FROM choices WHERE question_id = ? AND is_correct = 1').bind(qId).first('id');

    const ansRes = await apiRequest(app, 'POST', `/api/questions/${qId}/answer`, {
      token: ctx.fixtures.users.student.token,
      body: { choice_id: correctChoice },
    }, ctx);
    expect(ansRes.status).toBe(200);

    const statsAfter = await (await apiRequest(app, 'GET', '/api/students/stats', { token: ctx.fixtures.users.student.token }, ctx)).json();
    expect(statsAfter.answered_count).toBe(statsBefore.answered_count + 1);
    expect(statsAfter.correct_count).toBe(statsBefore.correct_count + 1);
  });

  it('C3.9 [Exam Attempt Flow + Score Calculation]: Start Attempt -> Submit 5 answers -> Finish -> Check Score', async () => {
    // 1. Start attempt
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id, questions } = await startRes.json();

    // 2. Submit answers (4 correct, 1 incorrect)
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const correctCh = await ctx.db.prepare('SELECT id FROM choices WHERE question_id = ? AND is_correct = 1').bind(q.id).first('id');
      const wrongCh = await ctx.db.prepare('SELECT id FROM choices WHERE question_id = ? AND is_correct = 0').bind(q.id).first('id');

      await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/answer`, {
        token: ctx.fixtures.users.student.token,
        body: { question_id: q.id, choice_id: i < 4 ? correctCh : wrongCh },
      }, ctx);
    }

    // 3. Finish attempt
    const finishRes = await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/finish`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(finishRes.status).toBe(200);
    const data = await finishRes.json();
    expect(data.score).toBe(4);
    expect(data.total).toBe(5);
    expect(data.percentage).toBe(80);
  });

  it('C3.10 [Exam Leaderboard Update]: Finished attempt appears in exam leaderboard with score and rank', async () => {
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id } = await startRes.json();

    await ctx.db.prepare("UPDATE exam_attempts SET score = 5, total = 5, finished_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), attempt_id).run();

    const leaderRes = await apiRequest(app, 'GET', `/api/exams/${ctx.fixtures.examId}/leaderboard`, {}, ctx);
    expect(leaderRes.status).toBe(200);
    const list = await leaderRes.json();
    const myEntry = list.find((e: any) => e.id === attempt_id);
    expect(myEntry).toBeDefined();
    expect(myEntry.score).toBe(5);
  });

  it('C3.11 [Exam Finish + Analytics]: Finishing exam updates overall student answers analytics', async () => {
    const startRes = await apiRequest(app, 'POST', `/api/exams/${ctx.fixtures.examId}/start`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const { attempt_id, questions } = await startRes.json();

    const q = questions[0];
    const ch = await ctx.db.prepare('SELECT id FROM choices WHERE question_id = ?').bind(q.id).first('id');
    await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/answer`, {
      token: ctx.fixtures.users.student.token,
      body: { question_id: q.id, choice_id: ch },
    }, ctx);

    await apiRequest(app, 'POST', `/api/exams/attempts/${attempt_id}/finish`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);

    const stats = await (await apiRequest(app, 'GET', '/api/students/stats', { token: ctx.fixtures.users.student.token }, ctx)).json();
    expect(stats.answered_count).toBeGreaterThan(0);
  });

  it('C3.12 [Question Bookmark Lifecycle]: Bookmark -> Verify in Saved Questions -> Delete -> Verify Empty', async () => {
    const qId = ctx.fixtures.questionIds[0];

    // Bookmark
    await apiRequest(app, 'POST', `/api/saved-questions/${qId}`, { token: ctx.fixtures.users.student.token }, ctx);

    // Verify in list
    const list1 = await (await apiRequest(app, 'GET', '/api/saved-questions', { token: ctx.fixtures.users.student.token }, ctx)).json();
    expect(list1.some((s: any) => s.id === qId || s.question_id === qId)).toBe(true);

    // Delete
    await apiRequest(app, 'DELETE', `/api/saved-questions/${qId}`, { token: ctx.fixtures.users.student.token }, ctx);

    // Verify removed
    const list2 = await (await apiRequest(app, 'GET', '/api/saved-questions', { token: ctx.fixtures.users.student.token }, ctx)).json();
    expect(list2.some((s: any) => s.id === qId || s.question_id === qId)).toBe(false);
  });

  it('C3.13 [Professor Course + Syllabus Creation]: Professor creates course and adds 3 ordered lectures', async () => {
    const courseRes = await apiRequest(app, 'POST', '/api/professors/courses', {
      token: ctx.fixtures.users.professor.token,
      body: { subject_id: ctx.fixtures.subjectIds.physiology, title: 'كورس فسلجة القلب' },
    }, ctx);
    const { id: courseId } = await courseRes.json();

    // Add 3 lectures
    for (let i = 0; i < 3; i++) {
      await apiRequest(app, 'POST', `/api/professors/courses/${courseId}/lectures`, {
        token: ctx.fixtures.users.professor.token,
        body: { title: `محاضرة فسلجة ${i + 1}`, duration_seconds: 1800, order_index: i },
      }, ctx);
    }

    const syllabusRes = await apiRequest(app, 'GET', `/api/courses/${courseId}/lectures`, {}, ctx);
    expect(syllabusRes.status).toBe(200);
    const lectures = await syllabusRes.json();
    expect(lectures.length).toBe(3);
    expect(lectures[0].order_index).toBe(0);
    expect(lectures[2].order_index).toBe(2);
  });

  it('C3.14 [Student Course Consumption + Completion]: Student watches lecture and marks progress complete', async () => {
    const lecId = ctx.fixtures.lectureIds[0];

    // Progress update
    const progRes = await apiRequest(app, 'POST', `/api/lectures/${lecId}/progress`, {
      token: ctx.fixtures.users.student.token,
      body: { seconds: 1200 },
    }, ctx);
    expect(progRes.status).toBe(200);

    // Mark complete
    const compRes = await apiRequest(app, 'POST', '/api/students/lecture-progress', {
      token: ctx.fixtures.users.student.token,
      body: { lecture_id: lecId },
    }, ctx);
    expect(compRes.status).toBe(200);

    // Check completed lectures
    const listRes = await apiRequest(app, 'GET', '/api/students/lecture-progress', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const list = await listRes.json();
    expect(list.some((l: any) => l.lecture_id === lecId)).toBe(true);
  });

  it('C3.15 [Lecture View -> Recent Views]: Watching lecture records it in recent views list', async () => {
    const lecId = ctx.fixtures.lectureIds[1];
    await apiRequest(app, 'POST', '/api/recent-views', {
      token: ctx.fixtures.users.student.token,
      body: { content_type: 'lecture', content_id: lecId },
    }, ctx);

    const res = await apiRequest(app, 'GET', '/api/recent-views', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const views = await res.json();
    expect(views.some((v: any) => v.content_id === lecId)).toBe(true);
  });

  it('C3.16 [Booklet View -> Recent Views]: Viewing booklet records it in recent views list', async () => {
    const bklId = ctx.fixtures.bookletId;
    await apiRequest(app, 'POST', '/api/recent-views', {
      token: ctx.fixtures.users.student.token,
      body: { content_type: 'booklet', content_id: bklId },
    }, ctx);

    const res = await apiRequest(app, 'GET', '/api/recent-views', {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    const views = await res.json();
    expect(views.some((v: any) => v.content_id === bklId)).toBe(true);
  });

  it('C3.17 [Order Creation -> Integrity]: Order items created with correct quantities and totals', async () => {
    const res = await apiRequest(app, 'POST', '/api/store/orders', {
      token: ctx.fixtures.users.student.token,
      body: {
        payment_method: 'zaincash',
        items: [
          { product_id: ctx.fixtures.productIds.vipCode, qty: 1 },
          { product_id: ctx.fixtures.productIds.subjectCode, qty: 2 },
        ],
      },
    }, ctx);
    expect(res.status).toBe(200);
    const order = await res.json();
    expect(order.total).toBe(50000 + 15000 * 2);

    const items = await ctx.db.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(order.id).all();
    expect(items.results.length).toBe(2);
  });

  it('C3.18 [Order -> Admin Paid -> Code Generation]: Marking order paid issues activation code', async () => {
    const ordRes = await apiRequest(app, 'POST', '/api/store/orders', {
      token: ctx.fixtures.users.student.token,
      body: { items: [{ product_id: ctx.fixtures.productIds.vipCode, qty: 1 }] },
    }, ctx);
    const { id: orderId } = await ordRes.json();

    const paidRes = await apiRequest(app, 'PUT', `/api/admin/orders/${orderId}/status`, {
      token: ctx.fixtures.users.admin.token,
      body: { status: 'paid' },
    }, ctx);
    expect(paidRes.status).toBe(200);
    const { issued_code } = await paidRes.json();
    expect(issued_code).toBeDefined();

    const codeRec = await ctx.db.prepare('SELECT * FROM activation_codes WHERE code = ?').bind(issued_code).first();
    expect(codeRec).toBeDefined();
    expect(codeRec.order_id).toBe(orderId);
  });

  it('C3.19 [Issued Code -> Student Redemption]: Student redeems code generated by order fulfillment', async () => {
    // 1. Create and fulfill order
    const ordRes = await apiRequest(app, 'POST', '/api/store/orders', {
      token: ctx.fixtures.users.student.token,
      body: { items: [{ product_id: ctx.fixtures.productIds.vipCode, qty: 1 }] },
    }, ctx);
    const { id: orderId } = await ordRes.json();
    const { issued_code } = await (await apiRequest(app, 'PUT', `/api/admin/orders/${orderId}/status`, {
      token: ctx.fixtures.users.admin.token,
      body: { status: 'paid' },
    }, ctx)).json();

    // 2. Redeem code
    const redeemRes = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: ctx.fixtures.users.student.token,
      body: { code: issued_code },
    }, ctx);
    expect(redeemRes.status).toBe(200);
    const data = await redeemRes.json();
    expect(data.is_vip).toBe(true);
  });

  it('C3.20 [Activation Code Double-Redemption Block]: Attempting to redeem already redeemed code fails', async () => {
    // First redemption
    await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: ctx.fixtures.users.student.token,
      body: { code: ctx.fixtures.activationCodes.vipIdle },
    }, ctx);

    // Second redemption attempt
    const res2 = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: ctx.fixtures.users.student.token,
      body: { code: ctx.fixtures.activationCodes.vipIdle },
    }, ctx);
    expect(res2.status).toBe(400);
    const data = await res2.json();
    expect(data.detail).toContain('مستخدم بالفعل');
  });

  it('C3.21 [Reseller Generation -> Sold -> Redeemed]: Complete reseller distribution pipeline', async () => {
    // 1. Reseller generates codes
    const genRes = await apiRequest(app, 'POST', '/api/reseller/generate', {
      token: ctx.fixtures.users.reseller.token,
      body: { count: 1, subject_id: ctx.fixtures.subjectIds.anatomy },
    }, ctx);
    const { codes } = await genRes.json();
    const codeStr = codes[0];

    // 2. Reseller marks code sold
    const codeRec = await ctx.db.prepare('SELECT id FROM activation_codes WHERE code = ?').bind(codeStr).first();
    await apiRequest(app, 'POST', `/api/reseller/codes/${codeRec.id}/sell`, {
      token: ctx.fixtures.users.reseller.token,
    }, ctx);

    // 3. Student redeems code
    const redRes = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: ctx.fixtures.users.student.token,
      body: { code: codeStr },
    }, ctx);
    expect(redRes.status).toBe(200);
    const data = await redRes.json();
    expect(data.subject_id).toBe(ctx.fixtures.subjectIds.anatomy);
  });

  it('C3.22 [Admin Ban -> Immediate Token Revocation]: Admin bans user, active token rejected on next call', async () => {
    const studentSess = await ctx.createSession(ctx.fixtures.users.student.id, 'Active Student');

    // Access before ban
    const beforeRes = await apiRequest(app, 'GET', '/auth/me', { token: studentSess.token }, ctx);
    expect(beforeRes.status).toBe(200);

    // Admin bans user
    const banRes = await apiRequest(app, 'POST', `/api/admin/users/${ctx.fixtures.users.student.id}/ban`, {
      token: ctx.fixtures.users.admin.token,
      body: { reason: 'انتهاك صارخ للقواعد' },
    }, ctx);
    expect(banRes.status).toBe(200);

    // Immediate next call rejected with 401 (session evicted) or 403 (banned)
    const afterRes = await apiRequest(app, 'GET', '/auth/me', { token: studentSess.token }, ctx);
    expect([401, 403]).toContain(afterRes.status);
  });

  it('C3.23 [Ban Appeal -> Admin Lift -> Access Restored]: Banned user appeals, admin lifts, user restored', async () => {
    // 1. Submit appeal
    const appRes = await apiRequest(app, 'POST', '/api/bans/appeal', {
      token: ctx.fixtures.users.bannedStudent.token,
      body: { appeal_message: 'أرجو رفع الحظر وسألتزم بالشروط' },
    }, ctx);
    expect(appRes.status).toBe(200);

    // 2. Admin lifts ban
    const resolveRes = await apiRequest(app, 'PUT', `/api/admin/bans/${ctx.fixtures.users.bannedStudent.banRecordId}/resolve`, {
      token: ctx.fixtures.users.admin.token,
      body: { action: 'lift' },
    }, ctx);
    expect(resolveRes.status).toBe(200);

    // 3. User can now login cleanly
    const loginRes = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: ctx.fixtures.users.bannedStudent.email, password: 'Nabd@2026' },
    }, ctx);
    expect(loginRes.status).toBe(200);
    const token = (await loginRes.json()).access_token;

    const meRes = await apiRequest(app, 'GET', '/auth/me', { token }, ctx);
    expect(meRes.status).toBe(200);
    expect((await meRes.json()).is_banned).toBe(false);
  });

  it('C3.24 [Admin Media Upload -> Booklet Attachment]: Upload PDF to R2 and link to booklet', async () => {
    const dummyPdf = new TextEncoder().encode('%PDF-1.5 Clinical Notes');
    const upRes = await apiRequest(app, 'POST', '/api/admin/media/upload', {
      token: ctx.fixtures.users.admin.token,
      headers: { 'X-Filename': 'heart_anatomy.pdf' },
      body: dummyPdf,
    }, ctx);
    expect(upRes.status).toBe(200);
    const { url } = await upRes.json();

    // Attach to booklet
    const bklRes = await apiRequest(app, 'POST', '/api/professors/booklets', {
      token: ctx.fixtures.users.admin.token,
      body: { title: 'ملزمة القلب', file_url: url, pages: 18, professor_id: ctx.fixtures.users.professor.profileId },
    }, ctx);
    expect(bklRes.status).toBe(200);

    // Verify media accessible
    const getMedia = await apiRequest(app, 'GET', url, {}, ctx);
    expect(getMedia.status).toBe(200);
  });

  it('C3.25 [Video Upload -> Stream with Range]: Upload MP4 and stream via Range bytes=0-500', async () => {
    const dummyVideo = new Uint8Array(2000).fill(123);
    await ctx.r2.put('cardio_lecture.mp4', dummyVideo, {
      httpMetadata: { contentType: 'video/mp4' },
    });

    const streamRes = await apiRequest(app, 'GET', '/media-files/cardio_lecture.mp4', {
      headers: { Range: 'bytes=0-500' },
    }, ctx);
    expect(streamRes.status).toBe(206);
    expect(streamRes.headers.get('Content-Range')).toBe('bytes 0-500/2000');
  });

  it('C3.26 [Clinical Pearl Visibility Gate]: Public visitor cannot view body, authenticated student sees full body', async () => {
    const pearl = await ctx.db.prepare('SELECT id FROM clinical_pearls LIMIT 1').first();

    // Public view
    const pubRes = await apiRequest(app, 'GET', `/api/pearls/${pearl.id}`, {}, ctx);
    expect(pubRes.status).toBe(200);
    const pubData = await pubRes.json();
    expect(pubData.title).toBeDefined();
    expect(pubData.body).toBeUndefined();

    // Authenticated view
    const authRes = await apiRequest(app, 'GET', `/api/pearls/${pearl.id}`, {
      token: ctx.fixtures.users.student.token,
    }, ctx);
    expect(authRes.status).toBe(200);
    const authData = await authRes.json();
    expect(authData.body).toBeDefined();
    expect(authData.body.length).toBeGreaterThan(10);
  });
});
