-- A completed exam may safely replay the response only to the original
-- idempotency key.  This prevents a lost HTTP response from turning a retry
-- into a client-visible failure or a second state transition.
ALTER TABLE exam_attempts ADD COLUMN finish_idempotency_key TEXT;
