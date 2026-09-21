-- One-time, browser-bound exchanges used after OAuth redirects.  The redirect
-- fragment carries this short-lived code rather than a long-lived JWT.
CREATE TABLE IF NOT EXISTS oauth_handoffs (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
  redirect_origin TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS oauth_handoffs_expires_at_idx ON oauth_handoffs(expires_at);
