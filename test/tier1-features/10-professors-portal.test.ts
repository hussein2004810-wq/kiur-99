import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';

describe('Tier 1: Feature 10 - Professor Portal & Content Authoring', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('10.1 should list all professors in directory via GET /api/professors', async () => {
    const res = await apiRequest(app, 'GET', '/api/professors', {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].full_name).toContain('أحمد');
  });

  it('10.2 should return professor profile with booklets via GET /api/professors/:id', async () => {
    const res = await apiRequest(app, 'GET', `/api/professors/${ctx.fixtures.users.professor.profileId}`, {}, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(ctx.fixtures.users.professor.profileId);
    expect(Array.isArray(data.booklets)).toBe(true);
  });

  it('10.3 should retrieve authenticated professor profile via GET /api/professors/me', async () => {
    const res = await apiRequest(app, 'GET', '/api/professors/me', {
      token: ctx.fixtures.users.professor.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(ctx.fixtures.users.professor.profileId);
    expect(data.title).toBe('أستاذ مساعد');
  });

  it('10.4 should update professor title and bio via PUT /api/professors/me', async () => {
    const res = await apiRequest(app, 'PUT', '/api/professors/me', {
      token: ctx.fixtures.users.professor.token,
      body: {
        title: 'أستاذ دكتور',
        bio: 'خبرة أكثر من 15 سنة في تدريس التشريح السريري',
      },
    }, ctx);

    expect(res.status).toBe(200);
    const meRes = await apiRequest(app, 'GET', '/api/professors/me', {
      token: ctx.fixtures.users.professor.token,
    }, ctx);
    const meData = await meRes.json();
    expect(meData.title).toBe('أستاذ دكتور');
    expect(meData.bio).toContain('15 سنة');
  });

  it('10.5 should allow professor to create a booklet via POST /api/professors/booklets', async () => {
    const res = await apiRequest(app, 'POST', '/api/professors/booklets', {
      token: ctx.fixtures.users.professor.token,
      body: {
        title: 'ملزمة تشريح البطن والحوض',
        pages: 35,
        file_url: 'https://storage.nabd.app/abdomen.pdf',
      },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.title).toBe('ملزمة تشريح البطن والحوض');
    expect(data.pages).toBe(35);
  });

  it('10.6 should update an existing booklet via PUT /api/professors/booklets/:id', async () => {
    const res = await apiRequest(app, 'PUT', `/api/professors/booklets/${ctx.fixtures.bookletId}`, {
      token: ctx.fixtures.users.professor.token,
      body: {
        title: 'ملزمة التشريح المحدثة 2026',
        pages: 30,
      },
    }, ctx);

    expect(res.status).toBe(200);
    const b = await ctx.db.prepare('SELECT title FROM booklets WHERE id = ?').bind(ctx.fixtures.bookletId).first('title');
    expect(b).toBe('ملزمة التشريح المحدثة 2026');
  });

  it('10.7 should delete a booklet via DELETE /api/professors/booklets/:id', async () => {
    const createRes = await apiRequest(app, 'POST', '/api/professors/booklets', {
      token: ctx.fixtures.users.professor.token,
      body: { title: 'ملزمة قابلة للحذف', pages: 5 },
    }, ctx);
    const { id } = await createRes.json();

    const delRes = await apiRequest(app, 'DELETE', `/api/professors/booklets/${id}`, {
      token: ctx.fixtures.users.professor.token,
    }, ctx);
    expect(delRes.status).toBe(200);

    const check = await ctx.db.prepare('SELECT id FROM booklets WHERE id = ?').bind(id).first();
    expect(check).toBeNull();
  });

  it('10.8 should allow professor to author a new MCQ question with choices via POST /api/professors/questions', async () => {
    const res = await apiRequest(app, 'POST', '/api/professors/questions', {
      token: ctx.fixtures.users.professor.token,
      body: {
        subject_id: ctx.fixtures.subjectIds.anatomy,
        text: 'ما هو العصب المسؤول عن تغذية عضلات الوجه التعبيرية؟',
        rationale: 'العصب القحفي السابع (العصب الوجهي) يغذي عضلات الوجه.',
        eyebrow: 'أعصاب قحفية',
        choices: [
          { text: 'العصب مثلث التوائم', is_correct: false },
          { text: 'العصب الوجهي', is_correct: true },
          { text: 'العصب المبهم', is_correct: false },
          { text: 'العصب الإضافي', is_correct: false },
        ],
      },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBeDefined();

    const choices = await ctx.db.prepare('SELECT * FROM choices WHERE question_id = ?').bind(data.id).all();
    expect(choices.results.length).toBe(4);
  });

  it('10.9 should update question text and rationale via PUT /api/professors/questions/:id', async () => {
    const qId = ctx.fixtures.questionIds[0];
    const res = await apiRequest(app, 'PUT', `/api/professors/questions/${qId}`, {
      token: ctx.fixtures.users.professor.token,
      body: {
        text: 'نص السؤال بعد التعديل الشامل',
        rationale: 'تفسير دقيق جديد',
      },
    }, ctx);

    expect(res.status).toBe(200);
    const q = await ctx.db.prepare('SELECT text FROM questions WHERE id = ?').bind(qId).first('text');
    expect(q).toBe('نص السؤال بعد التعديل الشامل');
  });

  it('10.10 should delete a question and cascade delete choices via DELETE /api/professors/questions/:id', async () => {
    const createRes = await apiRequest(app, 'POST', '/api/professors/questions', {
      token: ctx.fixtures.users.professor.token,
      body: {
        subject_id: ctx.fixtures.subjectIds.anatomy,
        text: 'سؤال مؤقت للحذف',
        choices: [
          { text: 'خيار 1', is_correct: true },
          { text: 'خيار 2', is_correct: false },
        ],
      },
    }, ctx);
    const { id } = await createRes.json();

    const delRes = await apiRequest(app, 'DELETE', `/api/professors/questions/${id}`, {
      token: ctx.fixtures.users.professor.token,
    }, ctx);
    expect(delRes.status).toBe(200);

    const choices = await ctx.db.prepare('SELECT * FROM choices WHERE question_id = ?').bind(id).all();
    expect(choices.results.length).toBe(0);
  });

  it('10.11 should create a new exam via POST /api/professors/exams', async () => {
    const res = await apiRequest(app, 'POST', '/api/professors/exams', {
      token: ctx.fixtures.users.professor.token,
      body: {
        subject_id: ctx.fixtures.subjectIds.anatomy,
        title: 'امتحان تشريح نهائي شامل',
        duration_minutes: 60,
      },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.title).toBe('امتحان تشريح نهائي شامل');
  });

  it('10.12 should create a new video course via POST /api/professors/courses', async () => {
    const res = await apiRequest(app, 'POST', '/api/professors/courses', {
      token: ctx.fixtures.users.professor.token,
      body: {
        subject_id: ctx.fixtures.subjectIds.anatomy,
        title: 'كورس تشريح الأطراف العلوية والسفلية',
      },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.title).toBe('كورس تشريح الأطراف العلوية والسفلية');
  });

  it('10.13 should add a lecture to a course via POST /api/professors/courses/:id/lectures', async () => {
    const res = await apiRequest(app, 'POST', `/api/professors/courses/${ctx.fixtures.courseId}/lectures`, {
      token: ctx.fixtures.users.professor.token,
      body: {
        title: 'المحاضرة الرابعة: تشريح الطرف السفلي',
        duration_seconds: 1500,
        order_index: 3,
        video_url: 'https://storage.nabd.app/lec_4.mp4',
      },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.title).toContain('الطرف السفلي');
  });

  it('10.14 should retrieve professor content metrics via GET /api/professors/me/stats', async () => {
    const res = await apiRequest(app, 'GET', '/api/professors/me/stats', {
      token: ctx.fixtures.users.professor.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total_booklets).toBeDefined();
    expect(data.total_questions).toBeDefined();
    expect(data.total_courses).toBeDefined();
  });
});
