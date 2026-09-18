import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { apiRequest } from '../harness/app';
import mainApp from '../../src/index';

describe('Tier 1: Feature - Iraqi Medical Group Academic Hierarchy & Admin Tools', () => {
  let ctx: TestContext;
  let app: any;
  let adminToken: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = mainApp;
    adminToken = ctx.fixtures.users.admin.token;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('should fetch academic tree via GET /api/admin/academic/tree', async () => {
    const res = await apiRequest(app, 'GET', '/api/admin/academic/tree', {
      headers: { Authorization: `Bearer ${adminToken}` },
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('universities');
    expect(data).toHaveProperty('colleges');
    expect(Array.isArray(data.universities)).toBe(true);
    expect(data.universities.some((u: any) => u.name === 'جامعة بغداد')).toBe(true);
  });

  it('should create, read, update, and delete universities via /api/admin/academic/universities', async () => {
    // 1. Create government university
    const createRes = await apiRequest(app, 'POST', '/api/admin/academic/universities', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        name: 'جامعة الموصل',
        type: 'government',
        province: 'نينوى',
      },
    }, ctx);
    expect(createRes.status).toBe(201);
    const uni = await createRes.json();
    expect(uni.name).toBe('جامعة الموصل');
    expect(uni.type).toBe('government');
    expect(uni.province).toBe('نينوى');

    // 2. Query with filters
    const listRes = await apiRequest(app, 'GET', '/api/admin/academic/universities?province=نينوى', {
      headers: { Authorization: `Bearer ${adminToken}` },
    }, ctx);
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.some((u: any) => u.id === uni.id)).toBe(true);

    // 3. Update
    const updateRes = await apiRequest(app, 'PUT', `/api/admin/academic/universities/${uni.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { province: 'الموصل الحدباء' },
    }, ctx);
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.province).toBe('الموصل الحدباء');

    // 4. Delete
    const deleteRes = await apiRequest(app, 'DELETE', `/api/admin/academic/universities/${uni.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    }, ctx);
    expect(deleteRes.status).toBe(200);
    const delJson = await deleteRes.json();
    expect(delJson.ok).toBe(true);
  });

  it('should create and list medical group colleges via /api/admin/academic/colleges', async () => {
    const colRes = await apiRequest(app, 'POST', '/api/admin/academic/colleges', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        name: 'كلية طب الأسنان',
        code: 'DENT',
        default_stages: 5,
      },
    }, ctx);
    expect(colRes.status).toBe(201);
    const college = await colRes.json();
    expect(college.name).toBe('كلية طب الأسنان');
    expect(college.default_stages).toBe(5);

    const listRes = await apiRequest(app, 'GET', '/api/admin/academic/colleges', {
      headers: { Authorization: `Bearer ${adminToken}` },
    }, ctx);
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.some((c: any) => c.code === 'DENT')).toBe(true);
  });

  it('should link university to college via /api/admin/academic/programs with automatic stages creation', async () => {
    // 1. Create college
    const colRes = await apiRequest(app, 'POST', '/api/admin/academic/colleges', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { name: 'كلية الصيدلة', code: 'PHARM', default_stages: 5 },
    }, ctx);
    const college = await colRes.json();

    // 2. Link to university with modular system
    const progRes = await apiRequest(app, 'POST', '/api/admin/academic/programs', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        university_id: ctx.fixtures.universityId,
        college_id: college.id,
        system_type: 'modular',
        total_stages: 5,
        auto_create_stages: true,
      },
    }, ctx);
    expect(progRes.status).toBe(201);
    const program = await progRes.json();
    expect(program.system_type).toBe('modular');
    expect(program.total_stages).toBe(5);

    // 3. Verify that 5 stages were automatically created
    const stagesRes = await apiRequest(app, 'GET', `/api/admin/academic/stages?program_id=${program.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    }, ctx);
    expect(stagesRes.status).toBe(200);
    const stages = await stagesRes.json();
    expect(stages.length).toBe(5);
    expect(stages.map((s: any) => s.stage_number)).toEqual([1, 2, 3, 4, 5]);
  });

  it('should create and tag subjects with ministerial and practical metadata via /api/admin/academic/subjects', async () => {
    const subRes = await apiRequest(app, 'POST', '/api/admin/academic/subjects', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        name: 'علم الأمراض السريري',
        code: 'PATH301',
        stage_id: ctx.fixtures.stageId,
        term: 'semester_1',
        is_ministerial: true,
        has_practical: true,
      },
    }, ctx);
    expect(subRes.status).toBe(201);
    const subject = await subRes.json();
    expect(subject.name).toBe('علم الأمراض السريري');
    expect(subject.code).toBe('PATH301');
    expect(subject.is_ministerial).toBe(true);
    expect(subject.has_practical).toBe(true);
    expect(subject.term).toBe('semester_1');

    // Filter by ministerial
    const filterRes = await apiRequest(app, 'GET', '/api/admin/academic/subjects?is_ministerial=true', {
      headers: { Authorization: `Bearer ${adminToken}` },
    }, ctx);
    expect(filterRes.status).toBe(200);
    const filtered = await filterRes.json();
    expect(filtered.some((s: any) => s.id === subject.id)).toBe(true);
  });

  it('should import full academic structure from CSV via POST /api/admin/academic/import-csv', async () => {
    const csvContent = `الجامعة,الكلية,النظام الدراسي,المرحلة,المادة,الترم,وزاري تقويمي,عملي سريري,المحافظة,نوع الجامعة
جامعة الكوفة,كلية الطب العام,modular,المرحلة الأولى,التشريح السريري,annual,1,1,النجف,حكومي
جامعة الكوفة,كلية الطب العام,modular,المرحلة الأولى,الكيمياء الحيوية الطبية,semester_1,0,1,النجف,حكومي
جامعة الكوفة,كلية طب الأسنان,traditional,المرحلة الثانية,تشريح الفم والأسنان,annual,1,1,النجف,حكومي
الجامعة الأمريكية في بغداد,كلية الصيدلة,traditional,المرحلة الأولى,علم العقاقير,semester_1,0,0,بغداد,أهلي`;

    const res = await apiRequest(app, 'POST', '/api/admin/academic/import-csv', {
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'text/csv; charset=utf-8',
      },
      body: csvContent,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.created.universities).toBeGreaterThanOrEqual(2);
    expect(data.created.colleges).toBeGreaterThanOrEqual(3);
    expect(data.created.subjects).toBe(4);

    // Verify imported universities exist
    const treeRes = await apiRequest(app, 'GET', '/api/admin/academic/tree', {
      headers: { Authorization: `Bearer ${adminToken}` },
    }, ctx);
    const tree = await treeRes.json();
    const kufa = tree.universities.find((u: any) => u.name === 'جامعة الكوفة');
    expect(kufa).toBeDefined();
    expect(kufa.province).toBe('النجف');
    expect(kufa.type).toBe('government');
    expect(kufa.programs.length).toBe(2);
  });

  it('should export all academic entities as CSV via GET /api/admin/academic/export-csv', async () => {
    const res = await apiRequest(app, 'GET', '/api/admin/academic/export-csv', {
      headers: { Authorization: `Bearer ${adminToken}` },
    }, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('academic-hierarchy.csv');

    const buf = await res.clone().arrayBuffer();
    const bytes = new Uint8Array(buf);
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf); // UTF-8 BOM
    const csvText = await res.text();
    expect(csvText).toContain('الجامعة');
    expect(csvText).toContain('المادة');
    expect(csvText).toContain('وزاري تقويمي');
    expect(csvText).toContain('جامعة بغداد');
    expect(csvText).toContain('التشريح');
  });

  it('should support indentation text catalog import via POST /api/admin/catalog/import', async () => {
    const textData = `كليات الطب
  جامعة البصرة
    المرحلة الثالثة
      علم الأحياء المجهرية
      علم الأدوية`;

    // Preview mode
    const previewRes = await apiRequest(app, 'POST', '/api/admin/catalog/import', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { text: textData, preview: true },
    }, ctx);
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(preview.created.universities).toBe(1);
    expect(preview.created.stages).toBe(1);
    expect(preview.created.subjects).toBe(2);

    // Commit mode
    const commitRes = await apiRequest(app, 'POST', '/api/admin/catalog/import', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { text: textData, preview: false },
    }, ctx);
    expect(commitRes.status).toBe(200);
    const commit = await commitRes.json();
    expect(commit.total_created).toBeGreaterThanOrEqual(4);
  });

  it('should support bulk add and duplicate via /api/admin/catalog/bulk and /duplicate', async () => {
    // 1. Bulk add universities under section
    const bulkRes = await apiRequest(app, 'POST', '/api/admin/catalog/bulk', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        parent_type: 'section',
        parent_id: ctx.fixtures.sectionId,
        names: ['جامعة بابل', 'جامعة كربلاء'],
      },
    }, ctx);
    expect(bulkRes.status).toBe(200);
    const bulk = await bulkRes.json();
    expect(bulk.created).toBe(2);

    // 2. Duplicate stage with subjects
    const dupRes = await apiRequest(app, 'POST', '/api/admin/catalog/duplicate', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        type: 'stage',
        id: ctx.fixtures.stageId,
        new_names: ['المرحلة الثانية - شعبة ب'],
      },
    }, ctx);
    expect(dupRes.status).toBe(200);
    const dup = await dupRes.json();
    expect(dup.copies.length).toBe(1);
    expect(dup.subjects).toBeGreaterThan(0);
  });

  it('should successfully add university without section_id and auto-attach to default section (Regression fix for "حدث خطأ غير متوقع في الخادم")', async () => {
    const res = await apiRequest(app, 'POST', '/api/admin/academic/universities', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        name: 'جامعة المامون',
        type: 'private',
        province: 'بغداد',
        logo_url: null,
      },
    }, ctx);

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.name).toBe('جامعة المامون');
    expect(data.type).toBe('private');
    expect(data.province).toBe('بغداد');
    expect(data.section_id).toBeDefined();
    expect(typeof data.section_id).toBe('string');
  });

  it('should support both flat and nested college response, all_colleges alias, and duplicate metadata', async () => {
    // 1. Create a college
    const cRes = await apiRequest(app, 'POST', '/api/admin/academic/colleges', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { name: 'كلية التقنيات الطبية والتحليلات', code: 'MLT', default_stages: 4 },
    }, ctx);
    expect(cRes.status).toBe(201);
    const cData = await cRes.json();
    expect(cData.id).toBeDefined();
    expect(cData.college).toBeDefined();
    expect(cData.college.id).toBe(cData.id);

    // 2. Duplicate college returns existing metadata
    const dupRes = await apiRequest(app, 'POST', '/api/admin/academic/colleges', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { name: 'كلية التقنيات الطبية والتحليلات', code: 'MLT', default_stages: 4 },
    }, ctx);
    expect(dupRes.status).toBe(400);
    const dupData = await dupRes.json();
    expect(dupData.detail).toBe('الكلية مسجلة مسبقاً');
    expect(dupData.existing_id).toBe(cData.id);
    expect(dupData.college.id).toBe(cData.id);

    // 3. Tree endpoint returns all_colleges
    const treeRes = await apiRequest(app, 'GET', '/api/admin/academic/tree', {
      headers: { Authorization: `Bearer ${adminToken}` },
    }, ctx);
    expect(treeRes.status).toBe(200);
    const treeData = await treeRes.json();
    expect(Array.isArray(treeData.all_colleges)).toBe(true);
    expect(Array.isArray(treeData.colleges)).toBe(true);
    expect(treeData.all_colleges.length).toBe(treeData.colleges.length);

    // 4. Duplicate program returns existing metadata
    const prog1 = await apiRequest(app, 'POST', '/api/admin/academic/programs', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        university_id: ctx.fixtures.universityId,
        college_id: cData.id,
        system_type: 'modular',
        total_stages: 4,
      },
    }, ctx);
    expect(prog1.status).toBe(201);
    const pData = await prog1.json();

    const progDup = await apiRequest(app, 'POST', '/api/admin/academic/programs', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        university_id: ctx.fixtures.universityId,
        college_id: cData.id,
      },
    }, ctx);
    expect(progDup.status).toBe(400);
    const pDupData = await progDup.json();
    expect(pDupData.detail).toBe('البرنامج مضاف مسبقاً لهذه الجامعة');
    expect(pDupData.existing_id).toBe(pData.id);
  });

  it('should support academic departments (أقسام طبية) and study sections (شعب دراسية) in hierarchy and tree', async () => {
    // 1. Create a college for testing departments (الكلية التقنية الطبية)
    const cRes = await apiRequest(app, 'POST', '/api/admin/academic/colleges', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { name: 'الكلية التقنية الطبية', code: 'TMC', default_stages: 4 },
    }, ctx);
    expect(cRes.status).toBe(201);
    const college = await cRes.json();

    // 2. Link college to university
    const pRes = await apiRequest(app, 'POST', '/api/admin/academic/programs', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { university_id: ctx.fixtures.universityId, college_id: college.id, system_type: 'traditional', auto_create_stages: false },
    }, ctx);
    expect(pRes.status).toBe(201);
    const program = await pRes.json();

    // 3. Create departments under the college
    const dRes1 = await apiRequest(app, 'POST', '/api/admin/academic/departments', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { college_id: college.id, name: 'قسم تقنيات التخدير والعناية المركزة', code: 'ANES' },
    }, ctx);
    expect(dRes1.status).toBe(201);
    const dept1 = await dRes1.json();
    expect(dept1.name).toBe('قسم تقنيات التخدير والعناية المركزة');

    const dRes2 = await apiRequest(app, 'POST', '/api/admin/academic/departments', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { college_id: college.id, name: 'قسم تقنيات الأشعة والسونار', code: 'RAD' },
    }, ctx);
    expect(dRes2.status).toBe(201);
    const dept2 = await dRes2.json();

    // 4. List departments by college
    const dListRes = await apiRequest(app, 'GET', `/api/admin/academic/departments?college_id=${college.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    }, ctx);
    expect(dListRes.status).toBe(200);
    const deptList = await dListRes.json();
    expect(deptList.length).toBe(2);

    // 5. Create a stage linked to department 1
    const stgRes = await apiRequest(app, 'POST', '/api/admin/academic/stages', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        name: 'المرحلة الأولى - تخدير',
        stage_number: 1,
        program_id: program.id,
        university_id: ctx.fixtures.universityId,
        college_id: college.id,
        department_id: dept1.id,
      },
    }, ctx);
    expect(stgRes.status).toBe(201);
    const stage1 = await stgRes.json();
    expect(stage1.department_id).toBe(dept1.id);

    // 6. Create study sections (شعب دراسية) inside stage 1
    const secRes1 = await apiRequest(app, 'POST', '/api/admin/academic/study-sections', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { stage_id: stage1.id, name: 'شعبة أ (صباحي)' },
    }, ctx);
    expect(secRes1.status).toBe(201);
    const sec1 = await secRes1.json();
    expect(sec1.name).toBe('شعبة أ (صباحي)');

    const secRes2 = await apiRequest(app, 'POST', '/api/admin/academic/study-sections', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { stage_id: stage1.id, name: 'شعبة ب (مسائي)' },
    }, ctx);
    expect(secRes2.status).toBe(201);

    // 7. List study sections by stage
    const secListRes = await apiRequest(app, 'GET', `/api/admin/academic/study-sections?stage_id=${stage1.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    }, ctx);
    expect(secListRes.status).toBe(200);
    const sections = await secListRes.json();
    expect(sections.length).toBe(2);

    // 8. Verify academic tree returns departments, stages, and sections
    const treeRes = await apiRequest(app, 'GET', '/api/admin/academic/tree', {
      headers: { Authorization: `Bearer ${adminToken}` },
    }, ctx);
    expect(treeRes.status).toBe(200);
    const treeData = await treeRes.json();
    expect(treeData.total_departments).toBeGreaterThanOrEqual(2);
    expect(treeData.total_study_sections).toBeGreaterThanOrEqual(2);

    const targetUni = treeData.universities.find((u: any) => u.id === ctx.fixtures.universityId);
    expect(targetUni).toBeDefined();
    const targetProg = targetUni.programs.find((p: any) => p.college_id === college.id);
    expect(targetProg).toBeDefined();
    expect(targetProg.departments.length).toBe(2);

    const targetDept = targetProg.departments.find((d: any) => d.id === dept1.id);
    expect(targetDept).toBeDefined();
    expect(targetDept.stages.length).toBe(1);
    expect(targetDept.stages[0].sections.length).toBe(2);
    expect(targetDept.stages[0].sections[0].name).toBe('شعبة أ (صباحي)');
  });
});
