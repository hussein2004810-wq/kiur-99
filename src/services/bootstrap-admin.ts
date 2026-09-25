/**
 * Atomically let only the configured, verified bootstrap account claim the
 * first administrator role. Once any administrator exists, this is closed.
 */
export async function claimBootstrapAdmin(
  db: D1Database,
  userId: string,
  verifiedEmail: string,
  configuredEmail: string | undefined,
): Promise<boolean> {
  const targetEmail = (configuredEmail ?? '').trim().toLowerCase();
  const accountEmail = verifiedEmail.trim().toLowerCase();
  if (!targetEmail || !accountEmail || accountEmail !== targetEmail) return false;

  const result = await db.prepare(
    "UPDATE users SET role = 'admin' WHERE id = ? AND lower(email) = ? AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')",
  ).bind(userId, targetEmail).run();

  return (result.meta.changes ?? 0) === 1;
}
