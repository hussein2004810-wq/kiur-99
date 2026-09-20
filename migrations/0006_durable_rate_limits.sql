-- Shared fixed-window counters.  D1 makes the limit durable across Worker
-- isolates; expired rows are safely reused by their primary key.
CREATE TABLE IF NOT EXISTS rate_limit_windows (
  key TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limit_windows_reset_at_idx ON rate_limit_windows(reset_at);
