import { describe, expect, it } from 'vitest';
import { createTestContext } from '../harness/test-context';
import { claimBootstrapAdmin } from '../../src/services/bootstrap-admin';

describe('Firebase first-owner bootstrap', () => {
  it('allows only the configured account to claim admin when no admin exists', async () => {
    const ctx = await createTestContext();
    try {
      await ctx.db.prepare("DELETE FROM users WHERE role = 'admin'").run();
      await ctx.db.prepare(
        "INSERT INTO users (id, email, full_name, role, email_verified_at) VALUES (?, ?, ?, 'student', CURRENT_TIMESTAMP)",
      ).bind('owner-account', 'hussein2004810@gmail.com', 'Owner').run();

      const claimed = await claimBootstrapAdmin(
        ctx.db as unknown as D1Database,
        'owner-account',
        'HUSSEIN2004810@GMAIL.COM',
        'hussein2004810@gmail.com',
      );

      expect(claimed).toBe(true);
      const owner = await ctx.db.prepare('SELECT role FROM users WHERE id = ?')
        .bind('owner-account').first<{ role: string }>();
      expect(owner?.role).toBe('admin');
    } finally {
      ctx.cleanup();
    }
  });

  it('does not grant admin to a different email or when any admin already exists', async () => {
    const ctx = await createTestContext();
    try {
      const wrongEmail = await claimBootstrapAdmin(
        ctx.db as unknown as D1Database,
        ctx.fixtures.users.student.id,
        'someone-else@example.com',
        'hussein2004810@gmail.com',
      );
      const existingAdmin = await claimBootstrapAdmin(
        ctx.db as unknown as D1Database,
        ctx.fixtures.users.student.id,
        'hussein2004810@gmail.com',
        'hussein2004810@gmail.com',
      );

      expect(wrongEmail).toBe(false);
      expect(existingAdmin).toBe(false);
      const student = await ctx.db.prepare('SELECT role FROM users WHERE id = ?')
        .bind(ctx.fixtures.users.student.id).first<{ role: string }>();
      expect(student?.role).toBe('student');
    } finally {
      ctx.cleanup();
    }
  });
});
