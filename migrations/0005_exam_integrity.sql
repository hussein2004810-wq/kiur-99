-- Exam integrity: database-enforced single open attempt, immutable attempt
-- snapshots, and replay-safe start keys.  Applied after 0000 on existing D1.
ALTER TABLE exam_attempts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE exam_attempts ADD COLUMN start_idempotency_key TEXT;
ALTER TABLE exam_attempt_questions ADD COLUMN question_snapshot TEXT;
ALTER TABLE exam_attempt_questions ADD COLUMN choices_snapshot TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS exam_attempts_one_open_user_exam_idx
  ON exam_attempts(exam_id, user_id) WHERE finished_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS exam_attempts_start_idempotency_idx
  ON exam_attempts(user_id, exam_id, start_idempotency_key)
  WHERE start_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS exam_attempt_questions_attempt_question_idx
  ON exam_attempt_questions(attempt_id, question_id);
CREATE UNIQUE INDEX IF NOT EXISTS exam_attempt_questions_attempt_order_idx
  ON exam_attempt_questions(attempt_id, order_index);
