import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import app from '../../src/index';

async function api(ctx: TestContext, method: string, path: string, token?: string, body?: any) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const req = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await app.request(req, undefined, ctx.bindings);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, data: json, headers: res.headers };
}

describe('Empirical Challenge: Worker Remediation Wave 1 Verification', () => {
  describe('1. GET /api/admin/users Pagination & Clamping Empirical Stress Tests', () => {
    let ctx: TestContext;
    let adminToken: string;

    beforeEach(async () => {
      ctx = await createTestContext();
      adminToken = ctx.fixtures.users.admin.token;

      // Seed 260 users in batches to test large-scale pagination and clamping
      const userInsertValues: string[] = [];
      for (let i = 1; i <= 260; i++) {
        const uId = `usr_test_${i.toString().padStart(4, '0')}`;
        const role = i <= 200 ? 'student' : i <= 230 ? 'professor' : 'reseller';
        userInsertValues.push(`('${uId}', 'user_${i}@example.com', 'User ${i}', 'hash', '${role}', CURRENT_TIMESTAMP)`);
      }
      await ctx.db.exec(`
        INSERT INTO users (id, email, full_name, password_hash, role, email_verified_at)
        VALUES ${userInsertValues.join(',\n')};
      `);
    });

    afterEach(() => {
      ctx.cleanup();
    });

    it('1.1 should default to 50 users when limit and offset are omitted', async () => {
      const res = await api(ctx, 'GET', '/api/admin/users', adminToken);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data)).toBe(true);
      expect(res.data.length).toBe(50);
    });

    it('1.2 should respect custom limit (10 and 75)', async () => {
      const res10 = await api(ctx, 'GET', '/api/admin/users?limit=10', adminToken);
      expect(res10.status).toBe(200);
      expect(res10.data.length).toBe(10);

      const res75 = await api(ctx, 'GET', '/api/admin/users?limit=75', adminToken);
      expect(res75.status).toBe(200);
      expect(res75.data.length).toBe(75);
    });

    it('1.3 should clamp limit > 200 to max 200', async () => {
      const res200 = await api(ctx, 'GET', '/api/admin/users?limit=200', adminToken);
      expect(res200.data.length).toBe(200);

      const res300 = await api(ctx, 'GET', '/api/admin/users?limit=300', adminToken);
      expect(res300.data.length).toBe(200);

      const resHuge = await api(ctx, 'GET', '/api/admin/users?limit=999999', adminToken);
      expect(resHuge.data.length).toBe(200);
    });

    it('1.4 should fallback to default 50 for negative, zero, or non-numeric limits', async () => {
      const resZero = await api(ctx, 'GET', '/api/admin/users?limit=0', adminToken);
      expect(resZero.data.length).toBe(50);

      const resNeg = await api(ctx, 'GET', '/api/admin/users?limit=-25', adminToken);
      expect(resNeg.data.length).toBe(50);

      const resNan = await api(ctx, 'GET', '/api/admin/users?limit=not_a_number', adminToken);
      expect(resNan.data.length).toBe(50);
    });

    it('1.5 should paginate correctly with offset and return disjoint sets', async () => {
      const page1 = await api(ctx, 'GET', '/api/admin/users?limit=20&offset=0', adminToken);
      const page2 = await api(ctx, 'GET', '/api/admin/users?limit=20&offset=20', adminToken);
      expect(page1.data.length).toBe(20);
      expect(page2.data.length).toBe(20);

      const p1Ids = new Set(page1.data.map((u: any) => u.id));
      const overlap = page2.data.filter((u: any) => p1Ids.has(u.id));
      expect(overlap.length).toBe(0);
    });

    it('1.6 should handle negative or huge offset gracefully', async () => {
      const offNeg = await api(ctx, 'GET', '/api/admin/users?limit=10&offset=-10', adminToken);
      const offZero = await api(ctx, 'GET', '/api/admin/users?limit=10&offset=0', adminToken);
      expect(offNeg.data).toEqual(offZero.data);

      const offHuge = await api(ctx, 'GET', '/api/admin/users?limit=50&offset=99999', adminToken);
      expect(Array.isArray(offHuge.data)).toBe(true);
      expect(offHuge.data.length).toBe(0);
    });

    it('1.7 should support role filtering combined with pagination', async () => {
      const profRes = await api(ctx, 'GET', '/api/admin/users?role=professor&limit=15', adminToken);
      expect(profRes.status).toBe(200);
      expect(profRes.data.length).toBe(15);
      expect(profRes.data.every((u: any) => u.role === 'professor')).toBe(true);
    });
  });

  describe('2. GET /api/admin/overview Aggregates & Batch Execution', () => {
    let ctx: TestContext;
    let adminToken: string;

    beforeEach(async () => {
      ctx = await createTestContext();
      adminToken = ctx.fixtures.users.admin.token;

      // Clean tables cleanly respecting FKs to establish exact known ground-truth state
      await ctx.db.exec(`
        PRAGMA foreign_keys = OFF;
        DELETE FROM student_answers;
        DELETE FROM order_items;
        DELETE FROM orders;
        DELETE FROM activation_codes;
        DELETE FROM ban_records;
        DELETE FROM lectures;
        DELETE FROM courses;
        DELETE FROM exams;
        DELETE FROM booklets;
        DELETE FROM choices;
        DELETE FROM questions;
        DELETE FROM professor_profiles;
        DELETE FROM user_sessions WHERE user_id NOT IN ('usr_admin', 'usr_student');
        DELETE FROM users WHERE id NOT IN ('usr_admin', 'usr_student');
        PRAGMA foreign_keys = ON;
      `);

      // Seed 8 additional users (5 students, 2 professors, 1 reseller) -> total 10 users, 6 students
      await ctx.db.exec(`
        INSERT INTO users (id, email, full_name, password_hash, role) VALUES
          ('u_s1', 's1@nabd.app', 'S1', 'h', 'student'),
          ('u_s2', 's2@nabd.app', 'S2', 'h', 'student'),
          ('u_s3', 's3@nabd.app', 'S3', 'h', 'student'),
          ('u_s4', 's4@nabd.app', 'S4', 'h', 'student'),
          ('u_s5', 's5@nabd.app', 'S5', 'h', 'student'),
          ('u_p1', 'p1@nabd.app', 'P1', 'h', 'professor'),
          ('u_p2', 'p2@nabd.app', 'P2', 'h', 'professor'),
          ('u_r1', 'r1@nabd.app', 'R1', 'h', 'reseller');
      `);

      // Courses: 3 courses
      await ctx.db.exec(`
        INSERT INTO courses (id, subject_id, professor_id, title) VALUES
          ('c_1', 'sub_anat', NULL, 'Course 1'),
          ('c_2', 'sub_anat', NULL, 'Course 2'),
          ('c_3', 'sub_phys', NULL, 'Course 3');
      `);

      // Exams: 4 exams
      await ctx.db.exec(`
        INSERT INTO exams (id, subject_id, professor_id, title, question_count, duration_minutes) VALUES
          ('ex_1', 'sub_anat', NULL, 'Exam 1', 10, 60),
          ('ex_2', 'sub_anat', NULL, 'Exam 2', 10, 60),
          ('ex_3', 'sub_phys', NULL, 'Exam 3', 10, 60),
          ('ex_4', 'sub_phys', NULL, 'Exam 4', 10, 60);
      `);

      // Orders: 5 total orders.
      // 2 paid ($120 and $45) + 1 fulfilled ($85) = $250 revenue.
      // 1 pending ($50) + 1 cancelled ($100) -> NOT in revenue.
      await ctx.db.exec(`
        INSERT INTO orders (id, user_id, total, status) VALUES
          ('ord_1', 'usr_student', 120, 'paid'),
          ('ord_2', 'usr_student', 45, 'paid'),
          ('ord_3', 'u_s1', 85, 'fulfilled'),
          ('ord_4', 'u_s2', 50, 'pending'),
          ('ord_5', 'u_s3', 100, 'cancelled');
      `);

      // Activation codes: 4 active, 2 idle, 1 expired
      await ctx.db.exec(`
        INSERT INTO activation_codes (id, code, status) VALUES
          ('act_1', 'C-1', 'active'),
          ('act_2', 'C-2', 'active'),
          ('act_3', 'C-3', 'active'),
          ('act_4', 'C-4', 'active'),
          ('act_5', 'C-5', 'idle'),
          ('act_6', 'C-6', 'idle'),
          ('act_7', 'C-7', 'expired');
      `);

      // Ban records: 3 active, 1 appealed, 1 lifted
      await ctx.db.exec(`
        INSERT INTO ban_records (id, user_id, reason, status) VALUES
          ('ban_1', 'u_s1', 'R1', 'active'),
          ('ban_2', 'u_s2', 'R2', 'active'),
          ('ban_3', 'u_s3', 'R3', 'active'),
          ('ban_4', 'u_s4', 'R4', 'appealed'),
          ('ban_5', 'u_s5', 'R5', 'lifted');
      `);

      // Insert question and choice for student answers foreign keys
      await ctx.db.exec(`
        INSERT INTO questions (id, subject_id, professor_id, text, rationale) VALUES
          ('qst_t1', 'sub_anat', NULL, 'Question for answer tests', 'Rationale');
        INSERT INTO choices (id, question_id, text, is_correct, order_index) VALUES
          ('cho_t1', 'qst_t1', 'Choice 1', 1, 0);
      `);

      // Student answers across dates
      const today = new Date().toISOString().slice(0, 10);
      const dMinus1 = new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10);
      const dMinus3 = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
      const dMinus10 = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);

      await ctx.db.exec(`
        INSERT INTO student_answers (id, user_id, question_id, choice_id, is_correct, answered_at) VALUES
          ('ans_1', 'usr_student', 'qst_t1', 'cho_t1', 1, '${today} 10:00:00'),
          ('ans_2', 'usr_student', 'qst_t1', 'cho_t1', 1, '${today} 11:00:00'),
          ('ans_3', 'u_s1', 'qst_t1', 'cho_t1', 1, '${today} 12:00:00'),
          ('ans_4', 'u_s2', 'qst_t1', 'cho_t1', 1, '${today} 13:00:00'),
          ('ans_5', 'u_s1', 'qst_t1', 'cho_t1', 1, '${dMinus1} 09:00:00'),
          ('ans_6', 'u_s2', 'qst_t1', 'cho_t1', 1, '${dMinus1} 15:00:00'),
          ('ans_7', 'u_s3', 'qst_t1', 'cho_t1', 1, '${dMinus3} 08:00:00'),
          ('ans_8', 'u_s4', 'qst_t1', 'cho_t1', 1, '${dMinus3} 12:00:00'),
          ('ans_9', 'u_s5', 'qst_t1', 'cho_t1', 1, '${dMinus3} 18:00:00'),
          ('ans_10', 'usr_student', 'qst_t1', 'cho_t1', 1, '${dMinus10} 10:00:00');
      `);
    });

    afterEach(() => {
      ctx.cleanup();
    });

    it('2.1 should compute exact aggregate counts and revenue', async () => {
      let batchStatementsReceived = 0;
      const originalBatch = ctx.bindings.DB.batch.bind(ctx.bindings.DB);
      ctx.bindings.DB.batch = async (stmts: any[]) => {
        batchStatementsReceived = stmts.length;
        return originalBatch(stmts);
      };

      const res = await api(ctx, 'GET', '/api/admin/overview', adminToken);
      expect(res.status).toBe(200);
      expect(batchStatementsReceived).toBe(9);

      const d = res.data;
      expect(d.users_count).toBe(10);
      expect(d.courses_count).toBe(3);
      expect(d.exams_count).toBe(4);
      expect(d.orders_count).toBe(5);
      expect(d.total_students).toBe(6);
      expect(d.active_activations).toBe(4);
      expect(d.pending_bans).toBe(3);
      expect(d.revenue_total).toBe(250);

      // Verify weekly activity 7-day breakdown
      expect(Array.isArray(d.weekly_activity)).toBe(true);
      expect(d.weekly_activity.length).toBe(7);

      const today = new Date().toISOString().slice(0, 10);
      const dMinus1 = new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10);
      const dMinus3 = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

      const counts: Record<string, number> = {};
      for (const item of d.weekly_activity) {
        counts[item.date] = item.count;
      }
      expect(counts[today]).toBe(4);
      expect(counts[dMinus1]).toBe(2);
      expect(counts[dMinus3]).toBe(3);
    });

    it('2.2 should handle zero-state without NaN or null errors', async () => {
      await ctx.db.exec(`
        DELETE FROM orders;
        DELETE FROM student_answers;
        DELETE FROM activation_codes;
        DELETE FROM ban_records;
      `);

      const res = await api(ctx, 'GET', '/api/admin/overview', adminToken);
      expect(res.status).toBe(200);
      expect(res.data.orders_count).toBe(0);
      expect(res.data.revenue_total).toBe(0);
      expect(res.data.active_activations).toBe(0);
      expect(res.data.pending_bans).toBe(0);
      expect(res.data.weekly_activity.length).toBe(7);
      expect(res.data.weekly_activity.every((a: any) => a.count === 0)).toBe(true);
    });
  });

  describe('3. GET /api/questions/daily Randomness Empirical Tests', () => {
    let ctx: TestContext;
    let studentToken: string;

    beforeEach(async () => {
      ctx = await createTestContext();
      studentToken = ctx.fixtures.users.student.token;

      // Seed 40 distinct questions for anatomy
      await ctx.db.exec('DELETE FROM questions;');
      await ctx.db.exec('DELETE FROM choices;');

      const qInserts: string[] = [];
      const chInserts: string[] = [];
      for (let i = 1; i <= 40; i++) {
        const qId = `qst_rnd_${i.toString().padStart(3, '0')}`;
        qInserts.push(`('${qId}', 'sub_anat', 'prof_1', 'Random question ${i}', 'Rationale ${i}')`);
        chInserts.push(
          `('ch_${i}_1', '${qId}', 'Choice A', 1, 0)`,
          `('ch_${i}_2', '${qId}', 'Choice B', 0, 1)`
        );
      }
      await ctx.db.exec(`
        INSERT INTO questions (id, subject_id, professor_id, text, rationale) VALUES ${qInserts.join(',\n')};
        INSERT INTO choices (id, question_id, text, is_correct, order_index) VALUES ${chInserts.join(',\n')};
      `);
    });

    afterEach(() => {
      ctx.cleanup();
    });

    it('3.1 should return non-deterministic dynamic question sets across requests', async () => {
      const SAMPLE_COUNT = 25;
      const seenIds = new Set<string>();
      const firstIds: string[] = [];
      const signatures: string[] = [];

      for (let i = 0; i < SAMPLE_COUNT; i++) {
        const res = await api(ctx, 'GET', '/api/questions/daily', studentToken);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.data)).toBe(true);
        expect(res.data.length).toBe(5);

        const ids = res.data.map((q: any) => q.id);
        firstIds.push(ids[0]);
        signatures.push(ids.join(','));
        for (const id of ids) {
          seenIds.add(id);
        }
      }

      // 1. Must see a broad variety of questions from the 40 candidate pool
      expect(seenIds.size).toBeGreaterThanOrEqual(15);

      // 2. The first question in the list must vary
      const uniqueFirsts = new Set(firstIds);
      expect(uniqueFirsts.size).toBeGreaterThanOrEqual(5);

      // 3. Not all signatures should be identical
      const uniqueSignatures = new Set(signatures);
      expect(uniqueSignatures.size).toBeGreaterThanOrEqual(15);
    });
  });

  describe('4. O(1) Database Query Pattern Complexity Verification', () => {
    let ctx: TestContext;
    let adminToken: string;

    beforeEach(async () => {
      ctx = await createTestContext();
      adminToken = ctx.fixtures.users.admin.token;
    });

    afterEach(() => {
      ctx.cleanup();
    });

    it('4.1 should execute constant O(1) SQL queries for GET /api/admin/professors invariant to professor count', async () => {
      let queryCount = 0;
      const origPrepare = ctx.bindings.DB.prepare.bind(ctx.bindings.DB);
      ctx.bindings.DB.prepare = (sql: string) => {
        queryCount++;
        return origPrepare(sql);
      };

      // Measure with 1 professor (2 queries for auth + 1 query for handler = 3 total)
      queryCount = 0;
      const res1 = await api(ctx, 'GET', '/api/admin/professors', adminToken);
      expect(res1.status).toBe(200);
      expect(res1.data.length).toBe(1);
      const count1 = queryCount;
      expect(count1).toBe(3); // 2 auth queries + 1 single JOIN query

      // Add 25 more professors
      for (let i = 2; i <= 26; i++) {
        const uId = `prof_u_${i}`;
        const prId = `prof_pr_${i}`;
        await ctx.db.exec(`
          INSERT INTO users (id, email, full_name, password_hash, role) VALUES ('${uId}', 'prof_${i}@nabd.app', 'Prof ${i}', 'hash', 'professor');
          INSERT INTO professor_profiles (id, user_id, title, subject_id) VALUES ('${prId}', '${uId}', 'Title ${i}', 'sub_anat');
        `);
      }

      // Measure with 26 professors
      queryCount = 0;
      const res26 = await api(ctx, 'GET', '/api/admin/professors', adminToken);
      expect(res26.status).toBe(200);
      expect(res26.data.length).toBe(26);
      const count26 = queryCount;

      // Invariant: query count does not scale with N (remains strictly 3)
      expect(count26).toBe(3);
      expect(count26).toBe(count1);
    });

    it('4.2 should execute constant O(1) SQL queries for GET /api/admin/resellers/:id/codes invariant to code count', async () => {
      const resellerId = ctx.fixtures.users.reseller.id;
      let queryCount = 0;
      const origPrepare = ctx.bindings.DB.prepare.bind(ctx.bindings.DB);
      ctx.bindings.DB.prepare = (sql: string) => {
        queryCount++;
        return origPrepare(sql);
      };

      // Seed 2 codes
      await ctx.db.exec(`
        INSERT INTO activation_codes (id, code, status, reseller_id, subject_id) VALUES
          ('rc_1', 'RC-1', 'active', '${resellerId}', 'sub_anat'),
          ('rc_2', 'RC-2', 'active', '${resellerId}', NULL);
      `);

      queryCount = 0;
      const res2 = await api(ctx, 'GET', `/api/admin/resellers/${resellerId}/codes`, adminToken);
      expect(res2.status).toBe(200);
      expect(res2.data.length).toBe(2);
      const count2 = queryCount;
      expect(count2).toBe(4); // 2 auth queries + 1 user role check + 1 JOIN query

      // Add 30 more codes
      const moreCodes: string[] = [];
      for (let i = 3; i <= 32; i++) {
        moreCodes.push(`('rc_${i}', 'RC-${i}', 'active', '${resellerId}', NULL)`);
      }
      await ctx.db.exec(`
        INSERT INTO activation_codes (id, code, status, reseller_id, subject_id) VALUES ${moreCodes.join(',\n')};
      `);

      queryCount = 0;
      const res32 = await api(ctx, 'GET', `/api/admin/resellers/${resellerId}/codes`, adminToken);
      expect(res32.status).toBe(200);
      expect(res32.data.length).toBe(32);
      const count32 = queryCount;

      // Invariant: query count is constant (4 queries total)
      expect(count32).toBe(4);
      expect(count32).toBe(count2);
    });

    it('4.3 should execute constant O(1) SQL queries for GET /api/admin/bans invariant to ban count', async () => {
      let queryCount = 0;
      const origPrepare = ctx.bindings.DB.prepare.bind(ctx.bindings.DB);
      ctx.bindings.DB.prepare = (sql: string) => {
        queryCount++;
        return origPrepare(sql);
      };

      // Measure with 1 ban (from fixture)
      queryCount = 0;
      const res1 = await api(ctx, 'GET', '/api/admin/bans', adminToken);
      expect(res1.status).toBe(200);
      expect(res1.data.length).toBe(1);
      const count1 = queryCount;
      expect(count1).toBe(3); // 2 auth queries + 1 single JOIN query

      // Add 30 more bans
      const banInserts: string[] = [];
      const userInserts: string[] = [];
      for (let i = 1; i <= 30; i++) {
        const uId = `ban_u_${i}`;
        userInserts.push(`('${uId}', 'b_${i}@nabd.app', 'Ban U ${i}', 'hash', 'student', 1)`);
        banInserts.push(`('ban_r_${i}', '${uId}', 'Reason ${i}', 'active')`);
      }
      await ctx.db.exec(`
        INSERT INTO users (id, email, full_name, password_hash, role, is_banned) VALUES ${userInserts.join(',\n')};
        INSERT INTO ban_records (id, user_id, reason, status) VALUES ${banInserts.join(',\n')};
      `);

      queryCount = 0;
      const res31 = await api(ctx, 'GET', '/api/admin/bans', adminToken);
      expect(res31.status).toBe(200);
      expect(res31.data.length).toBe(31);
      const count31 = queryCount;

      // Invariant: query count is constant (3 queries total)
      expect(count31).toBe(3);
      expect(count31).toBe(count1);
    });
  });
});
