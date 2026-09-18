import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { apiRequest } from '../harness/app';
import mainApp from '../../src/index';

describe('Tier 1: Feature 17 - Clinical Glimpses (اللمحات السريرية) Specification', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = mainApp;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // 1. Validation & Creation
  describe('1. Validation and Draft Creation', () => {
    it('rejects glimpse draft creation without title or summary', async () => {
      const res = await apiRequest(app, 'POST', '/api/admin/glimpses', {
        token: ctx.fixtures.users.admin.token,
        body: {
          title: '',
          summary: 'قصير',
          clinicalPoint: 'نقطة سريرية مهمة',
          audienceAll: true,
        },
      }, ctx);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.detail).toContain('عنوان اللمحة');
    });

    it('rejects non-admin from creating platform-wide glimpse (audienceAll=true)', async () => {
      const res = await apiRequest(app, 'POST', '/api/admin/glimpses', {
        token: ctx.fixtures.users.professor.token,
        body: {
          title: 'لمحة عامة لجميع الطلاب',
          summary: 'ملخص سريري واضح للجميع لا يقل عن عشرة أحرف',
          clinicalPoint: 'افحص مجرى الهواء دائمًا',
          audienceAll: true,
        },
      }, ctx);

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.detail).toContain('النشر للجميع يتطلب صلاحية إدارة اللمحات');
    });

    it('creates a valid draft glimpse by admin and logs the creation', async () => {
      const res = await apiRequest(app, 'POST', '/api/admin/glimpses', {
        token: ctx.fixtures.users.admin.token,
        body: {
          title: 'لمحة الاختناق الحاد',
          summary: 'ملخص سريري واضح ومفيد للطالب يوضح كيفية التعامل السريع',
          clinicalPoint: 'افحص مجرى الهواء أولًا قبل أي تدخل آخر',
          warning: 'اطلب المساعدة الجراحية مبكرًا',
          referenceText: 'دليل الطوارئ والتخدير السريري',
          audienceAll: true,
        },
      }, ctx);

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBeDefined();

      // Check draft status in list
      const listRes = await apiRequest(app, 'GET', '/api/admin/glimpses', {
        token: ctx.fixtures.users.admin.token,
      }, ctx);
      expect(listRes.status).toBe(200);
      const list = await listRes.json();
      const created = list.data.find((g: any) => g.id === data.id);
      expect(created).toBeDefined();
      expect(created.status).toBe('draft');
      expect(created.title).toBe('لمحة الاختناق الحاد');
    });
  });

  // 2. Full Approval Lifecycle
  describe('2. Approval Lifecycle (draft -> in_review -> approved -> published)', () => {
    let glimpseId: string;

    beforeEach(async () => {
      const res = await apiRequest(app, 'POST', '/api/admin/glimpses', {
        token: ctx.fixtures.users.admin.token,
        body: {
          title: 'حالة نزيف دماغي حاد',
          summary: 'ملخص سريري للتشخيص الأولي للنزيف تحت العنكبوتية',
          clinicalPoint: 'إجراء فحص المفراس الحلزوني للدماغ دون صبغة فورًا',
          warning: 'تجنب خفض الضغط الشرياني بعنف',
          referenceText: 'أطلس جراحة الجملة العصبية',
          audienceAll: true,
        },
      }, ctx);
      const data = await res.json();
      glimpseId = data.id;
    });

    it('blocks premature publishing when glimpse is still in draft (409 Conflict)', async () => {
      const res = await apiRequest(app, 'POST', `/api/admin/glimpses/${glimpseId}/publish`, {
        token: ctx.fixtures.users.admin.token,
      }, ctx);

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.detail).toContain('يجب اعتماد اللمحة قبل نشرها');
    });

    it('blocks premature approval when glimpse is still in draft without review submission (409)', async () => {
      const res = await apiRequest(app, 'POST', `/api/admin/glimpses/${glimpseId}/approve`, {
        token: ctx.fixtures.users.admin.token,
      }, ctx);

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.detail).toContain('يجب إرسال اللمحة للمراجعة أولًا');
    });

    it('completes the entire mandatory path: draft -> in_review -> approved -> published', async () => {
      // Step 1: submit for review
      const reviewRes = await apiRequest(app, 'POST', `/api/admin/glimpses/${glimpseId}/submit-review`, {
        token: ctx.fixtures.users.admin.token,
      }, ctx);
      expect(reviewRes.status).toBe(200);
      expect((await reviewRes.json()).status).toBe('in_review');

      // Step 2: approve
      const approveRes = await apiRequest(app, 'POST', `/api/admin/glimpses/${glimpseId}/approve`, {
        token: ctx.fixtures.users.admin.token,
      }, ctx);
      expect(approveRes.status).toBe(200);
      expect((await approveRes.json()).status).toBe('approved');

      // Step 3: publish
      const publishRes = await apiRequest(app, 'POST', `/api/admin/glimpses/${glimpseId}/publish`, {
        token: ctx.fixtures.users.admin.token,
      }, ctx);
      expect(publishRes.status).toBe(200);
      expect((await publishRes.json()).status).toBe('published');

      // Verify visible in student feed
      const feedRes = await apiRequest(app, 'GET', '/api/glimpses', {
        token: ctx.fixtures.users.student.token,
      }, ctx);
      expect(feedRes.status).toBe(200);
      const feed = await feedRes.json();
      const item = feed.data.find((g: any) => g.id === glimpseId);
      expect(item).toBeDefined();
      expect(item.title).toBe('حالة نزيف دماغي حاد');
    });

    it('resets a published glimpse back to draft when edited via PATCH', async () => {
      // Move to published
      await apiRequest(app, 'POST', `/api/admin/glimpses/${glimpseId}/submit-review`, { token: ctx.fixtures.users.admin.token }, ctx);
      await apiRequest(app, 'POST', `/api/admin/glimpses/${glimpseId}/approve`, { token: ctx.fixtures.users.admin.token }, ctx);
      await apiRequest(app, 'POST', `/api/admin/glimpses/${glimpseId}/publish`, { token: ctx.fixtures.users.admin.token }, ctx);

      // Edit title
      const patchRes = await apiRequest(app, 'PATCH', `/api/admin/glimpses/${glimpseId}`, {
        token: ctx.fixtures.users.admin.token,
        body: {
          title: 'حالة نزيف دماغي حاد (محدث ومراجع)',
        },
      }, ctx);

      expect(patchRes.status).toBe(200);
      const patchData = await patchRes.json();
      expect(patchData.status).toBe('draft');
      expect(patchData.updated).toBe(true);

      // Verify no longer in student feed until approved and published again
      const feedRes = await apiRequest(app, 'GET', '/api/glimpses', {
        token: ctx.fixtures.users.student.token,
      }, ctx);
      const feed = await feedRes.json();
      const inFeed = feed.data.some((g: any) => g.id === glimpseId);
      expect(inFeed).toBe(false);
    });
  });

  // 3. Scoping & Scheduled Publishing
  describe('3. Scoping & Scheduled Publishing', () => {
    it('hides future scheduled glimpse from students until publish_at arrives', async () => {
      const futureTime = new Date(Date.now() + 3600000).toISOString(); // +1 hour

      const res = await apiRequest(app, 'POST', '/api/admin/glimpses', {
        token: ctx.fixtures.users.admin.token,
        body: {
          title: 'لمحة مستقبلية مجدولة',
          summary: 'ملخص لحالة سريرية مجدولة للنشر في المستقبل القريب',
          clinicalPoint: 'إعطاء المضاد الحيوي الوقائي قبل الشق بساعة',
          publishAt: futureTime,
          audienceAll: true,
        },
      }, ctx);
      const data = await res.json();
      const futureId = data.id;

      // Transition to published status
      await apiRequest(app, 'POST', `/api/admin/glimpses/${futureId}/submit-review`, { token: ctx.fixtures.users.admin.token }, ctx);
      await apiRequest(app, 'POST', `/api/admin/glimpses/${futureId}/approve`, { token: ctx.fixtures.users.admin.token }, ctx);
      await apiRequest(app, 'POST', `/api/admin/glimpses/${futureId}/publish`, { token: ctx.fixtures.users.admin.token }, ctx);

      // Student feed must NOT contain this future glimpse
      const feedRes = await apiRequest(app, 'GET', '/api/glimpses', {
        token: ctx.fixtures.users.student.token,
      }, ctx);
      const feed = await feedRes.json();
      expect(feed.data.some((g: any) => g.id === futureId)).toBe(false);
    });

    it('hides glimpse from student if academic track does not match targets', async () => {
      // Seed a different university and stage
      await ctx.db.exec(`
        INSERT INTO universities (id, name, section_id) VALUES ('uni_other', 'جامعة أخرى', 'sec_med');
        INSERT INTO stages (id, name, university_id) VALUES ('stg_other', 'مرحلة أخرى', 'uni_other');
      `);

      const res = await apiRequest(app, 'POST', '/api/admin/glimpses', {
        token: ctx.fixtures.users.admin.token,
        body: {
          title: 'لمحة خاصة بجامعة معينة',
          summary: 'ملخص لحالة سريرية مخصصة لطلاب المرحلة المتقدمة فقط',
          clinicalPoint: 'فحص المؤشرات الحيوية الدقيقة لمريض العناية المركزة',
          audienceAll: false,
          targets: [
            {
              universityId: 'uni_other',
              stageId: 'stg_other',
            },
          ],
        },
      }, ctx);
      const data = await res.json();
      const scopedId = data.id;

      // Publish
      await apiRequest(app, 'POST', `/api/admin/glimpses/${scopedId}/submit-review`, { token: ctx.fixtures.users.admin.token }, ctx);
      await apiRequest(app, 'POST', `/api/admin/glimpses/${scopedId}/approve`, { token: ctx.fixtures.users.admin.token }, ctx);
      await apiRequest(app, 'POST', `/api/admin/glimpses/${scopedId}/publish`, { token: ctx.fixtures.users.admin.token }, ctx);

      // Student whose university/stage does not match must not see it
      const feedRes = await apiRequest(app, 'GET', '/api/glimpses', {
        token: ctx.fixtures.users.student.token,
      }, ctx);
      const feed = await feedRes.json();
      expect(feed.data.some((g: any) => g.id === scopedId)).toBe(false);
    });
  });

  // 4. Soft-Delete (Archive), Restore & Audit Logs
  describe('4. Soft-Delete, Restore & Governance Audit Trail', () => {
    it('archives (soft-deletes) a glimpse, restores it, and deletes forever', async () => {
      const createRes = await apiRequest(app, 'POST', '/api/admin/glimpses', {
        token: ctx.fixtures.users.admin.token,
        body: {
          title: 'لمحة الحروق الجلدية',
          summary: 'ملخص حساب كمية السوائل لمريض الحروق عبر معادلة باركلاند',
          clinicalPoint: 'تطبيق معادلة باركلاند 4 مل في الوزن في النسبة',
          audienceAll: true,
        },
      }, ctx);
      const { id } = await createRes.json();

      // Publish
      await apiRequest(app, 'POST', `/api/admin/glimpses/${id}/submit-review`, { token: ctx.fixtures.users.admin.token }, ctx);
      await apiRequest(app, 'POST', `/api/admin/glimpses/${id}/approve`, { token: ctx.fixtures.users.admin.token }, ctx);
      await apiRequest(app, 'POST', `/api/admin/glimpses/${id}/publish`, { token: ctx.fixtures.users.admin.token }, ctx);

      // 1. Archive
      const archiveRes = await apiRequest(app, 'POST', `/api/admin/glimpses/${id}/archive`, {
        token: ctx.fixtures.users.admin.token,
      }, ctx);
      expect(archiveRes.status).toBe(200);
      expect((await archiveRes.json()).status).toBe('archived');

      // Must be gone from student feed
      const feedRes = await apiRequest(app, 'GET', '/api/glimpses', {
        token: ctx.fixtures.users.student.token,
      }, ctx);
      expect((await feedRes.json()).data.some((g: any) => g.id === id)).toBe(false);

      // 2. Restore (restores as draft)
      const restoreRes = await apiRequest(app, 'POST', `/api/admin/glimpses/${id}/restore`, {
        token: ctx.fixtures.users.admin.token,
      }, ctx);
      expect(restoreRes.status).toBe(200);
      expect((await restoreRes.json()).status).toBe('draft');

      // 3. Delete forever
      const deleteRes = await apiRequest(app, 'POST', `/api/admin/glimpses/${id}/delete-forever`, {
        token: ctx.fixtures.users.admin.token,
      }, ctx);
      expect(deleteRes.status).toBe(204);

      // 4. Check governance logs
      const logsRes = await apiRequest(app, 'GET', '/api/admin/glimpses/logs', {
        token: ctx.fixtures.users.admin.token,
      }, ctx);
      expect(logsRes.status).toBe(200);
      const logs = await logsRes.json();
      expect(Array.isArray(logs.data)).toBe(true);
      const glimpseLogs = logs.data.filter((l: any) => l.glimpseId === id);
      expect(glimpseLogs.length).toBeGreaterThanOrEqual(4); // create, submit, approve, publish, archive, restore, delete_forever
    });
  });
});
