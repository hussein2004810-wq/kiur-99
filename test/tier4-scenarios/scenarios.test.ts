import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';
import { generateTotpCode, signJwt } from '../harness/crypto-helpers';

describe('Tier 4: Real-World Application Workload Scenarios (S1-S6)', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // =========================================================================
  // SCENARIO 1: Full Student Onboarding & Auth Lifecycle
  // =========================================================================
  it('S1: Full Student Onboarding & Auth Lifecycle (Register -> Login -> Profile -> Password -> 2FA -> Device Eviction)', async () => {
    const studentEmail = 'new.medical.student@nabd.app';
    const initialPassword = 'InitialPassword2026!';
    const newPassword = 'UpgradedPassword2026!';

    // 1. Student Registration
    const regRes = await apiRequest(app, 'POST', '/auth/register', {
      body: {
        email: studentEmail,
        password: initialPassword,
        full_name: 'د. ليث حيدر',
        role: 'student',
        university_id: ctx.fixtures.universityId,
        stage_id: ctx.fixtures.stageId,
      },
    }, ctx);

    expect([200, 201]).toContain(regRes.status);
    const regData = await regRes.json();
    expect(regData.access_token).toBeDefined();
    expect(regData.role).toBe('student');

    // 2. First Login on Device A (iPhone)
    const loginA = await apiRequest(app, 'POST', '/auth/login', {
      body: {
        email: studentEmail,
        password: initialPassword,
        device_label: 'iPhone 15 Pro - Safari Mobile',
      },
    }, ctx);
    expect(loginA.status).toBe(200);
    const { access_token: tokenA } = await loginA.json();
    expect(tokenA).toBeDefined();

    // 3. Update Student Profile via /auth/me
    const updateProfileRes = await apiRequest(app, 'PUT', '/auth/me', {
      token: tokenA,
      body: {
        full_name: 'د. ليث حيدر الموسوي',
        phone: '+9647711223344',
      },
    }, ctx);
    expect(updateProfileRes.status).toBe(200);

    const getMeRes = await apiRequest(app, 'GET', '/auth/me', {
      token: tokenA,
    }, ctx);
    expect(getMeRes.status).toBe(200);
    const meData = await getMeRes.json();
    expect(meData.phone).toBe('+9647711223344');
    expect(meData.full_name).toContain('الموسوي');

    const getProfileRes = await apiRequest(app, 'GET', '/api/students/profile', {
      token: tokenA,
    }, ctx);
    expect(getProfileRes.status).toBe(200);

    // 4. Change Password
    const changePassRes = await apiRequest(app, 'POST', '/auth/change-password', {
      token: tokenA,
      body: {
        old_password: initialPassword,
        new_password: newPassword,
      },
    }, ctx);
    expect(changePassRes.status).toBe(200);

    // Verify old password fails
    const oldLoginFail = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: studentEmail, password: initialPassword },
    }, ctx);
    expect(oldLoginFail.status).toBe(401);

    // Login with new password on Device A
    const loginNewPass = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: studentEmail, password: newPassword, device_label: 'iPhone 15 Pro' },
    }, ctx);
    expect(loginNewPass.status).toBe(200);
    const { access_token: tokenA2 } = await loginNewPass.json();

    // 5. Setup & Enable 2FA (TOTP)
    const setup2faRes = await apiRequest(app, 'POST', '/auth/2fa/setup', {
      token: tokenA2,
    }, ctx);
    expect(setup2faRes.status).toBe(200);
    const setupData = await setup2faRes.json();
    expect(setupData.secret).toBeDefined();
    expect(setupData.uri).toBeDefined();
    expect(setupData.uri).toContain('otpauth://totp/Nabd:');

    // Verify TOTP code to activate 2FA
    const validTotp = await generateTotpCode(setupData.secret);
    const verify2faRes = await apiRequest(app, 'POST', '/auth/2fa/verify', {
      token: tokenA2,
      body: { code: validTotp },
    }, ctx);
    expect(verify2faRes.status).toBe(200);

    // Verify 2FA is now enabled on account
    const me2faRes = await apiRequest(app, 'GET', '/auth/me', {
      token: tokenA2,
    }, ctx);
    expect(me2faRes.status).toBe(200);
    const me2faData = await me2faRes.json();
    expect(me2faData.totp_enabled).toBe(true);

    // 6. 2FA Login Flow (Challenge -> Verification)
    const loginChallengeRes = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: studentEmail, password: newPassword },
    }, ctx);
    expect(loginChallengeRes.status).toBe(200);
    const challengeData = await loginChallengeRes.json();
    expect(challengeData.requires_2fa).toBe(true);
    expect(challengeData.pending_token).toBeDefined();

    const totpChallengeCode = await generateTotpCode(setupData.secret);
    const verifyLoginRes = await apiRequest(app, 'POST', '/auth/2fa/login', {
      body: {
        pending_token: challengeData.pending_token,
        code: totpChallengeCode,
        device_label: 'Device A - Active',
      },
    }, ctx);
    expect(verifyLoginRes.status).toBe(200);
    const { access_token: finalTokenA } = await verifyLoginRes.json();
    expect(finalTokenA).toBeDefined();

    // 7. Anti-Piracy Single-Session Eviction: Login on Device B
    const loginDeviceB = await apiRequest(app, 'POST', '/auth/login', {
      body: { email: studentEmail, password: newPassword },
    }, ctx);
    const challengeB = await loginDeviceB.json();
    const totpB = await generateTotpCode(setupData.secret);

    const verifyDeviceB = await apiRequest(app, 'POST', '/auth/2fa/login', {
      body: {
        pending_token: challengeB.pending_token,
        code: totpB,
        device_label: 'Device B - iPad Pro',
      },
    }, ctx);
    expect(verifyDeviceB.status).toBe(200);
    const { access_token: tokenB } = await verifyDeviceB.json();

    // Device B is valid
    const accessB = await apiRequest(app, 'GET', '/auth/me', { token: tokenB }, ctx);
    expect(accessB.status).toBe(200);

    // Device A is evicted with 401
    const accessA = await apiRequest(app, 'GET', '/auth/me', { token: finalTokenA }, ctx);
    expect(accessA.status).toBe(401);
    const evictionData = await accessA.json();
    expect(evictionData.detail).toContain('جهاز آخر');
  });

  // =========================================================================
  // SCENARIO 2: Curriculum Navigation & Question Practice
  // =========================================================================
  it('S2: Curriculum Navigation & Question Practice (Browse Tree -> Booklets -> Practice -> Save Notes -> Pearls)', async () => {
    const studentToken = ctx.fixtures.users.student.token;

    // 1. Browse Academic Sections
    const secRes = await apiRequest(app, 'GET', '/api/catalog/sections', {}, ctx);
    expect(secRes.status).toBe(200);
    const sections = await secRes.json();
    expect(Array.isArray(sections)).toBe(true);
    const medSection = sections.find((s: any) => s.id === ctx.fixtures.sectionId);
    expect(medSection).toBeDefined();
    expect(medSection.name).toContain('بشري');

    // 2. Select University within Section
    const uniRes = await apiRequest(app, 'GET', `/api/catalog/universities?section_id=${medSection.id}`, {}, ctx);
    expect(uniRes.status).toBe(200);
    const unis = await uniRes.json();
    const baghdadUni = unis.find((u: any) => u.id === ctx.fixtures.universityId);
    expect(baghdadUni).toBeDefined();
    expect(baghdadUni.name).toContain('بغداد');

    // 3. Select Academic Stage
    const stagesRes = await apiRequest(app, 'GET', '/api/catalog/stages', {}, ctx);
    expect(stagesRes.status).toBe(200);
    const stages = await stagesRes.json();
    const stage3 = stages.find((st: any) => st.id === ctx.fixtures.stageId);
    expect(stage3).toBeDefined();

    // 4. Select Subject within Stage
    const subRes = await apiRequest(app, 'GET', `/api/catalog/subjects?stage_id=${stage3.id}`, {}, ctx);
    expect(subRes.status).toBe(200);
    const subjects = await subRes.json();
    const anatomy = subjects.find((s: any) => s.id === ctx.fixtures.subjectIds.anatomy);
    expect(anatomy).toBeDefined();
    expect(anatomy.name).toContain('تشريح');

    // 5. Browse Booklets for Subject via /api/catalog/subjects/:id/booklets
    const bkRes = await apiRequest(app, 'GET', `/api/catalog/subjects/${anatomy.id}/booklets`, {}, ctx);
    expect(bkRes.status).toBe(200);
    const booklets = await bkRes.json();
    expect(booklets.length).toBeGreaterThan(0);
    const targetBooklet = booklets[0];
    expect(targetBooklet.title).toBeDefined();

    // 6. Practice Questions for Subject
    const qListRes = await apiRequest(app, 'GET', `/api/questions?subject_id=${anatomy.id}`, {}, ctx);
    expect(qListRes.status).toBe(200);
    const questions = await qListRes.json();
    expect(questions.length).toBeGreaterThanOrEqual(2);

    const questionToPractice = questions[0];
    expect(questionToPractice.text).toBeDefined();

    // Fetch individual question details with choices
    const singleQRes = await apiRequest(app, 'GET', `/api/questions/${questionToPractice.id}`, {}, ctx);
    expect(singleQRes.status).toBe(200);
    const singleQ = await singleQRes.json();
    expect(singleQ.text).toBe(questionToPractice.text);
    expect(Array.isArray(singleQ.choices)).toBe(true);
    expect(singleQ.choices.length).toBeGreaterThanOrEqual(2);

    // 7. Save Question for Review & Saved List
    const saveQRes = await apiRequest(app, 'POST', `/api/saved-questions/${questionToPractice.id}`, {
      token: studentToken,
    }, ctx);
    expect(saveQRes.status).toBe(200);
    const savedQData = await saveQRes.json();
    expect(savedQData.message).toBeDefined();

    // Retrieve saved questions and verify question is bookmarked
    const getSavedRes = await apiRequest(app, 'GET', '/api/saved-questions', {
      token: studentToken,
    }, ctx);
    expect(getSavedRes.status).toBe(200);
    const savedList = await getSavedRes.json();
    expect(Array.isArray(savedList)).toBe(true);
    expect(savedList.some((sq: any) => sq.id === questionToPractice.id || sq.question_id === questionToPractice.id)).toBe(true);

    // 8. Daily Pearls & Bookmarking
    const dailyPearlRes = await apiRequest(app, 'GET', '/api/pearls/daily', {}, ctx);
    expect(dailyPearlRes.status).toBe(200);
    const dailyPearl = await dailyPearlRes.json();
    expect(dailyPearl.id).toBeDefined();
    expect(dailyPearl.title).toBeDefined();

    // Bookmark the pearl
    const bmPearlRes = await apiRequest(app, 'POST', `/api/pearls/${dailyPearl.id}/bookmark`, {
      token: studentToken,
    }, ctx);
    expect(bmPearlRes.status).toBe(200);
    const bmData = await bmPearlRes.json();
    expect(bmData.message).toBeDefined();

    // Add reaction to pearl
    const reactRes = await apiRequest(app, 'POST', `/api/pearls/${dailyPearl.id}/reaction`, {
      token: studentToken,
      body: { reaction: 'like' },
    }, ctx);
    expect(reactRes.status).toBe(200);
    const reactData = await reactRes.json();
    expect(reactData.message).toBeDefined();
  });

  // =========================================================================
  // SCENARIO 3: Timed Exam Taking & Dynamic Scoring
  // =========================================================================
  it('S3: Timed Exam Taking & Dynamic Scoring (Start -> Answer 5 Qs -> Finish -> Review -> Stats Update -> Leaderboard)', async () => {
    const studentToken = ctx.fixtures.users.student.token;
    const examId = ctx.fixtures.examId;

    // 1. Check Initial Student Statistics
    const initialStatsRes = await apiRequest(app, 'GET', '/api/students/stats', {
      token: studentToken,
    }, ctx);
    expect(initialStatsRes.status).toBe(200);
    const initialStats = await initialStatsRes.json();
    expect(initialStats.answered_count).toBeDefined();
    expect(initialStats.streak_days).toBeDefined();

    // 2. Start Exam Attempt
    const startRes = await apiRequest(app, 'POST', `/api/exams/${examId}/start`, {
      token: studentToken,
    }, ctx);
    expect(startRes.status).toBe(200);
    const startData = await startRes.json();
    expect(startData.attempt_id).toBeDefined();
    expect(Array.isArray(startData.questions)).toBe(true);
    expect(startData.questions.length).toBeGreaterThanOrEqual(5);

    const attemptId = startData.attempt_id;
    const examQuestions = startData.questions.slice(0, 5);

    // 3. Submit Answers for 5 Questions (4 Correct, 1 Incorrect)
    for (let i = 0; i < examQuestions.length; i++) {
      const q = examQuestions[i];
      // Lookup correct choice from db
      const correctChoice = await ctx.db.prepare('SELECT id FROM choices WHERE question_id = ? AND is_correct = 1').bind(q.id).first('id');
      const wrongChoice = await ctx.db.prepare('SELECT id FROM choices WHERE question_id = ? AND is_correct = 0').bind(q.id).first('id');

      // Question 0-3: correct, Question 4: incorrect
      const choiceIdToSubmit = i < 4 ? correctChoice : wrongChoice;

      const ansRes = await apiRequest(app, 'POST', `/api/exams/attempts/${attemptId}/answer`, {
        token: studentToken,
        body: {
          question_id: q.id,
          choice_id: choiceIdToSubmit,
        },
      }, ctx);
      expect(ansRes.status).toBe(200);
    }

    // 4. Finish Exam Attempt & Review Score
    const finishRes = await apiRequest(app, 'POST', `/api/exams/attempts/${attemptId}/finish`, {
      token: studentToken,
    }, ctx);
    expect(finishRes.status).toBe(200);
    const scoreData = await finishRes.json();
    expect(scoreData.score).toBe(4);
    expect(scoreData.total).toBe(5);
    expect(scoreData.percentage).toBe(80); // 4 out of 5 = 80%

    // 5. Verify Student Stats & Skills Are Updated
    const updatedStatsRes = await apiRequest(app, 'GET', '/api/students/stats', {
      token: studentToken,
    }, ctx);
    expect(updatedStatsRes.status).toBe(200);
    const updatedStats = await updatedStatsRes.json();
    expect(updatedStats.answered_count).toBeDefined();
    expect(updatedStats.correct_count).toBeDefined();

    // Add & verify skill tracking
    const addSkillRes = await apiRequest(app, 'POST', '/api/students/skills', {
      token: studentToken,
      body: { text: 'تشريح القلب والأوعية السريري' },
    }, ctx);
    expect(addSkillRes.status).toBe(200);

    const skillsRes = await apiRequest(app, 'GET', '/api/students/skills', {
      token: studentToken,
    }, ctx);
    expect(skillsRes.status).toBe(200);
    const skills = await skillsRes.json();
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.some((s: any) => s.text.includes('تشريح'))).toBe(true);

    // 6. Check Exam Leaderboard
    const lbRes = await apiRequest(app, 'GET', `/api/exams/${examId}/leaderboard`, {
      token: studentToken,
    }, ctx);
    expect(lbRes.status).toBe(200);
    const lb = await lbRes.json();
    expect(Array.isArray(lb)).toBe(true);
    expect(lb.length).toBeGreaterThan(0);
    const myRank = lb.find((entry: any) => entry.user_id === ctx.fixtures.users.student.id);
    expect(myRank).toBeDefined();
    expect(myRank.score).toBe(4);
    expect(myRank.rank).toBeDefined();
  });

  // =========================================================================
  // SCENARIO 4: Professor Course Creation & Student Streaming
  // =========================================================================
  it('S4: Professor Course Creation & Student Streaming (Create Course -> Add Lectures -> Upload Media -> Stream Range 206 -> Progress & Views)', async () => {
    const profToken = ctx.fixtures.users.professor.token;
    const studentToken = ctx.fixtures.users.student.token;

    // 1. Professor Creates New Course
    const courseRes = await apiRequest(app, 'POST', '/api/professors/courses', {
      token: profToken,
      body: {
        subject_id: ctx.fixtures.subjectIds.anatomy,
        title: 'كورس التشريح الجراحي المتقدم',
        description: 'شرح مفصل لكافة الحالات الجراحية والتشريح الطبوغرافي',
      },
    }, ctx);
    expect(courseRes.status).toBe(200);
    const { id: newCourseId } = await courseRes.json();
    expect(newCourseId).toBeDefined();

    // 2. Professor Adds Lectures
    const lec1Res = await apiRequest(app, 'POST', `/api/professors/courses/${newCourseId}/lectures`, {
      token: profToken,
      body: {
        title: 'المحاضرة الأولى: مبادئ التشريح الجراحي',
        duration_seconds: 1800,
        order_index: 0,
        video_url: '/media-files/surgery_principles.mp4',
      },
    }, ctx);
    expect(lec1Res.status).toBe(200);
    const { id: lec1Id } = await lec1Res.json();

    const lec2Res = await apiRequest(app, 'POST', `/api/professors/courses/${newCourseId}/lectures`, {
      token: profToken,
      body: {
        title: 'المحاضرة الثانية: تشريح الجدار البطني',
        duration_seconds: 2400,
        order_index: 1,
        video_url: '/media-files/abdominal_wall.mp4',
      },
    }, ctx);
    expect(lec2Res.status).toBe(200);

    // 3. Upload Lecture Video Data to R2
    const videoData = new Uint8Array(16384); // 16 KB mock MP4
    for (let i = 0; i < videoData.length; i++) videoData[i] = i % 256;
    await ctx.r2.put('surgery_principles.mp4', videoData, {
      httpMetadata: { contentType: 'video/mp4' },
    });

    // 4. Student Discovers and Accesses Course
    const studentCourseRes = await apiRequest(app, 'GET', `/api/courses/${newCourseId}`, {
      token: studentToken,
    }, ctx);
    expect(studentCourseRes.status).toBe(200);
    const studentCourse = await studentCourseRes.json();
    expect(studentCourse.title).toContain('التشريح الجراحي');
    expect(studentCourse.lectures.length).toBe(2);

    // Student inspects lecture 1
    const lectureRes = await apiRequest(app, 'GET', `/api/lectures/${lec1Id}`, {
      token: studentToken,
    }, ctx);
    expect(lectureRes.status).toBe(200);
    const lectureData = await lectureRes.json();
    expect(lectureData.duration_seconds).toBe(1800);

    // 5. Student Streams Video using HTTP Range Requests (206 Partial Content)
    // Chunk 1: first 1000 bytes
    const streamRes1 = await apiRequest(app, 'GET', '/media-files/surgery_principles.mp4', {
      token: studentToken,
      headers: { Range: 'bytes=0-999' },
    }, ctx);
    expect(streamRes1.status).toBe(206);
    expect(streamRes1.headers.get('Content-Range')).toBe('bytes 0-999/16384');
    expect(streamRes1.headers.get('Content-Length')).toBe('1000');
    expect(streamRes1.headers.get('Accept-Ranges')).toBe('bytes');

    // Chunk 2: next 1000 bytes
    const streamRes2 = await apiRequest(app, 'GET', '/media-files/surgery_principles.mp4', {
      token: studentToken,
      headers: { Range: 'bytes=1000-1999' },
    }, ctx);
    expect(streamRes2.status).toBe(206);
    expect(streamRes2.headers.get('Content-Range')).toBe('bytes 1000-1999/16384');
    expect(streamRes2.headers.get('Content-Length')).toBe('1000');

    // 6. Student Updates Video Playback Progress
    const progRes = await apiRequest(app, 'POST', `/api/lectures/${lec1Id}/progress`, {
      token: studentToken,
      body: { seconds: 1250 },
    }, ctx);
    expect(progRes.status).toBe(200);
    const progData = await progRes.json();
    expect(progData.seconds).toBe(1250);

    // 7. Student Records and Inspects Recent Views
    const addRecentRes = await apiRequest(app, 'POST', '/api/recent-views', {
      token: studentToken,
      body: {
        content_type: 'lecture',
        content_id: lec1Id,
      },
    }, ctx);
    expect(addRecentRes.status).toBe(200);

    const getRecentRes = await apiRequest(app, 'GET', '/api/recent-views', {
      token: studentToken,
    }, ctx);
    expect(getRecentRes.status).toBe(200);
    const recentList = await getRecentRes.json();
    expect(recentList.some((item: any) => item.content_id === lec1Id)).toBe(true);
  });

  // =========================================================================
  // SCENARIO 5: Store Purchase to Activation Code Redemption
  // =========================================================================
  it('S5: Store Purchase to Activation Code Redemption (Order -> Mark Paid -> Issue Code -> Redeem -> Lockout on Reuse)', async () => {
    const studentToken = ctx.fixtures.users.student.token;
    const adminToken = ctx.fixtures.users.admin.token;
    const vipProductId = ctx.fixtures.productIds.vipCode;

    // 1. Student Browses Store Products
    const productsRes = await apiRequest(app, 'GET', '/api/store/products', {}, ctx);
    expect(productsRes.status).toBe(200);
    const products = await productsRes.json();
    const vipProduct = products.find((p: any) => p.id === vipProductId);
    expect(vipProduct).toBeDefined();

    // 2. Student Creates Store Order
    const orderRes = await apiRequest(app, 'POST', '/api/store/orders', {
      token: studentToken,
      body: {
        items: [
          { product_id: vipProductId, qty: 1 },
        ],
      },
    }, ctx);
    expect([200, 201]).toContain(orderRes.status);
    const orderData = await orderRes.json();
    expect(orderData.id).toBeDefined();
    expect(orderData.status).toBe('pending');
    const orderId = orderData.id;

    // 3. Admin Marks Order as Paid & Issues Activation Code
    const payRes = await apiRequest(app, 'PUT', `/api/admin/orders/${orderId}/status`, {
      token: adminToken,
      body: { status: 'paid' },
    }, ctx);
    expect(payRes.status).toBe(200);
    const paidData = await payRes.json();
    expect(paidData.status).toBe('paid');
    expect(paidData.issued_code).toBeDefined();
    const issuedCode = paidData.issued_code;

    // Verify code exists in DB with idle or active status
    const codeRow = await ctx.db.prepare('SELECT * FROM activation_codes WHERE code = ?').bind(issuedCode).first();
    expect(codeRow).toBeDefined();
    expect(['idle', 'active']).toContain(codeRow.status);

    // 4. Student Redeems the Activation Code
    const redeemRes = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: studentToken,
      body: { code: issuedCode },
    }, ctx);
    expect(redeemRes.status).toBe(200);
    const redeemData = await redeemRes.json();
    expect(redeemData.message).toContain('تفعيل');

    // Verify in DB that code is now marked redeemed or active, and linked to student
    const updatedCodeRow = await ctx.db.prepare('SELECT status, activated_by_user_id FROM activation_codes WHERE code = ?').bind(issuedCode).first();
    expect(['active', 'redeemed']).toContain(updatedCodeRow.status);
    expect(updatedCodeRow.activated_by_user_id).toBe(ctx.fixtures.users.student.id);

    // 5. Attempt Re-Redemption (Must Fail with 400 Already Redeemed)
    const reRedeemRes = await apiRequest(app, 'POST', '/api/activation/redeem', {
      token: studentToken,
      body: { code: issuedCode },
    }, ctx);
    expect(reRedeemRes.status).toBe(400);
    const reRedeemData = await reRedeemRes.json();
    expect(reRedeemData.detail).toContain('مستخدم');

    // 6. Security Stress: Attempting Multiple Invalid Codes
    for (let i = 0; i < 3; i++) {
      const invalidRes = await apiRequest(app, 'POST', '/api/activation/redeem', {
        token: studentToken,
        body: { code: `FAKE-INVALID-CODE-${i}` },
      }, ctx);
      expect(invalidRes.status).toBe(400);
    }
  });

  // =========================================================================
  // SCENARIO 6: Admin Governance, Audit Logging & User Ban
  // =========================================================================
  it('S6: Admin Governance, Audit Logging & User Ban (Overview -> Logs -> Ban User -> Immediate 403 -> Appeal -> Lift Ban)', async () => {
    const adminToken = ctx.fixtures.users.admin.token;
    const targetStudentId = ctx.fixtures.users.student.id;
    const targetStudentToken = ctx.fixtures.users.student.token;

    // 1. Admin Checks Overview Metrics
    const overviewRes = await apiRequest(app, 'GET', '/api/admin/overview', {
      token: adminToken,
    }, ctx);
    expect(overviewRes.status).toBe(200);
    const overview = await overviewRes.json();
    expect(overview.users_count).toBeGreaterThan(0);
    expect(overview.courses_count).toBeGreaterThan(0);

    // 2. Admin Inspects Audit Logs
    const logsRes = await apiRequest(app, 'GET', '/api/admin/logs', {
      token: adminToken,
    }, ctx);
    expect(logsRes.status).toBe(200);
    const logs = await logsRes.json();
    expect(Array.isArray(logs)).toBe(true);

    // 3. Admin Bans Target Student for Suspicious Activity
    const banReason = 'مشاركة بيانات الحساب مع عدة أجهزة خارجية بطريقة مخالفة للسياسة';
    const banRes = await apiRequest(app, 'POST', `/api/admin/users/${targetStudentId}/ban`, {
      token: adminToken,
      body: { reason: banReason },
    }, ctx);
    expect(banRes.status).toBe(200);

    // Verify DB records
    const userRow = await ctx.db.prepare('SELECT is_banned FROM users WHERE id = ?').bind(targetStudentId).first();
    expect(userRow.is_banned).toBe(1);

    const banRecord = await ctx.db.prepare("SELECT * FROM ban_records WHERE user_id = ? AND status = 'active'").bind(targetStudentId).first();
    expect(banRecord).toBeDefined();
    expect(banRecord.reason).toBe(banReason);

    // 4. Banned User's Existing Token is Rejected (401 session evicted or 403 banned)
    const meRes = await apiRequest(app, 'GET', '/auth/me', {
      token: targetStudentToken,
    }, ctx);
    expect([401, 403]).toContain(meRes.status);

    // Direct token without session ID hits 403 Forbidden on protected user routes
    const bannedDirectToken = signJwt({ sub: targetStudentId, role: 'student' }, ctx.bindings.JWT_SECRET);
    const forbiddenRes = await apiRequest(app, 'GET', '/auth/me', {
      token: bannedDirectToken,
    }, ctx);
    expect(forbiddenRes.status).toBe(403);
    const banError = await forbiddenRes.json();
    expect(banError.detail).toContain('محظور');

    // Banned user cannot access student workspace either
    const studentProfileRes = await apiRequest(app, 'GET', '/api/students/profile', {
      token: bannedDirectToken,
    }, ctx);
    expect(studentProfileRes.status).toBe(403);

    // 5. Banned User Submits Appeal via /api/bans/appeal
    const appealMessage = 'أعتذر بشدة عن استخدام جهاز المكتب الجامعي وأرجو قبول اعتذاري ورفع الحظر';
    const appealRes = await apiRequest(app, 'POST', '/api/bans/appeal', {
      token: bannedDirectToken,
      body: { appeal_message: appealMessage },
    }, ctx);
    expect(appealRes.status).toBe(200);

    // Verify ban record status updated to appealed
    const appealedRecord = await ctx.db.prepare('SELECT status, appeal_message FROM ban_records WHERE id = ?').bind(banRecord.id).first();
    expect(appealedRecord.status).toBe('appealed');
    expect(appealedRecord.appeal_message).toBe(appealMessage);

    // 6. Admin Reviews Ban Records & Resolves Appeal to Lift Ban
    const banListRes = await apiRequest(app, 'GET', '/api/bans/records', {
      token: adminToken,
    }, ctx);
    expect(banListRes.status).toBe(200);
    const banList = await banListRes.json();
    const foundAppealed = banList.find((b: any) => b.id === banRecord.id);
    expect(foundAppealed).toBeDefined();
    expect(foundAppealed.status).toBe('appealed');

    // Admin lifts ban
    const liftRes = await apiRequest(app, 'PUT', `/api/admin/bans/${banRecord.id}/resolve`, {
      token: adminToken,
      body: { action: 'lift' },
    }, ctx);
    expect(liftRes.status).toBe(200);

    // Verify DB user is unbanned
    const unbannedUser = await ctx.db.prepare('SELECT is_banned FROM users WHERE id = ?').bind(targetStudentId).first();
    expect(unbannedUser.is_banned).toBe(0);

    // 7. Student Access is Restored Immediately
    const restoredDirectToken = signJwt({ sub: targetStudentId, role: 'student' }, ctx.bindings.JWT_SECRET);
    const restoredMeRes = await apiRequest(app, 'GET', '/auth/me', {
      token: restoredDirectToken,
    }, ctx);
    expect(restoredMeRes.status).toBe(200);
    const restoredData = await restoredMeRes.json();
    expect(restoredData.id).toBe(targetStudentId);
  });
});
