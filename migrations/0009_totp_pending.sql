-- Keep an unconfirmed authenticator seed separate from the active seed.
ALTER TABLE users ADD COLUMN totp_pending_secret TEXT;
