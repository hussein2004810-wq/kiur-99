# Exam burst acceptance test

This k6 test is for an isolated staging environment only: every virtual student creates and finishes a real exam attempt.

Prepare one entitled staging account token per virtual student, then run 600 and 1000 student passes separately:

```powershell
$env:KIUR_BASE_URL = 'https://staging.example.invalid'
$env:KIUR_EXAM_ID = 'staging-exam-id'
$env:KIUR_AUTH_TOKENS_JSON = Get-Content -Raw .\staging-tokens.json
$env:KIUR_TARGET_STUDENTS = '600'
k6 run .\load-tests\exam-burst.k6.js
```

Do not commit the token file.  The test fails closed without all required variables, applies a 30-second start burst, retries each mutating call at most once with the same idempotency key, submits one answer after ten seconds, and finishes the attempt.  Run again with `KIUR_TARGET_STUDENTS=1000` and 1,000 distinct entitled tokens.  Record the p95 metrics, success rate, duplicate attempts, partial attempts, and lost-answer checks from the staging database before claiming production readiness.
