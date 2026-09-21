# KIUR staging load acceptance

These scripts make real mutations (sessions, attempts, answers, and finishes).
They are intentionally blocked unless `KIUR_CONFIRM_STAGING=YES` is set. Never
run them against production and never commit credentials, tokens, or attempt IDs.

## Required isolated staging data

- A Worker, D1 database, and R2 bucket separate from production.
- One entitled account and token per simulated student.
- A dedicated exam with at least one question and one answer choice.
- A pre-test D1 backup and a disposable test window; all scripts leave real
  staging records behind.

## 1. Distributed login ramp

This checks that 600 students can sign in across 30 minutes, including users
behind the same university NAT. `staging-credentials.json` is an array of
`{ "email": "...", "password": "..." }` records.

```powershell
$env:KIUR_CONFIRM_STAGING = 'YES'
$env:KIUR_BASE_URL = 'https://staging.example.invalid'
$env:KIUR_TARGET_STUDENTS = '600'
$env:KIUR_WINDOW_MINUTES = '30'
$env:KIUR_CREDENTIALS_JSON = Get-Content -Raw .\staging-credentials.json
k6 run .\load-tests\login-ramp.k6.js
```

## 2. Normal 30-minute exam session

This spreads 600 starts over 30 minutes, waits before an answer, then safely
finishes. It retries a failed mutation once using the same idempotency key.

```powershell
$env:KIUR_CONFIRM_STAGING = 'YES'
$env:KIUR_BASE_URL = 'https://staging.example.invalid'
$env:KIUR_EXAM_ID = 'staging-exam-id'
$env:KIUR_TARGET_STUDENTS = '600'
$env:KIUR_WINDOW_MINUTES = '30'
$env:KIUR_ANSWER_DELAY_SECONDS = '45'
$env:KIUR_AUTH_TOKENS_JSON = Get-Content -Raw .\staging-tokens.json
k6 run .\load-tests\exam-session-600.k6.js
```

## 3. Start burst and finish burst

`exam-burst.k6.js` is the severe start test: it starts all students during a
30-second window. Use it only after the normal session passes.

```powershell
$env:KIUR_CONFIRM_STAGING = 'YES'
$env:KIUR_BASE_URL = 'https://staging.example.invalid'
$env:KIUR_EXAM_ID = 'staging-exam-id'
$env:KIUR_TARGET_STUDENTS = '600'
$env:KIUR_AUTH_TOKENS_JSON = Get-Content -Raw .\staging-tokens.json
k6 run .\load-tests\exam-burst.k6.js
```

For the final herd, create unfinished attempts in staging first. The file is
an array of `{ "token": "...", "attempt_id": "..." }` records.

```powershell
$env:KIUR_CONFIRM_STAGING = 'YES'
$env:KIUR_BURST_SECONDS = '120'
$env:KIUR_ATTEMPTS_JSON = Get-Content -Raw .\staging-attempts.json
k6 run .\load-tests\exam-finish-burst.k6.js
```

## Acceptance and evidence

Run each scenario three times. Do not claim readiness until every run meets:

| Metric | Target |
| --- | --- |
| HTTP failures | less than 0.1% |
| Login p95 | less than 1.5 seconds |
| Exam start and finish p95 | less than 2 seconds |
| Answer p95 | less than 750 ms |
| Duplicate open attempts, duplicate finishes, lost answers | zero |

Save the k6 summaries and query the staging D1 database after each pass for
open/duplicate attempts and answers. A threshold failure, elevated 5xx rate,
or a data-integrity mismatch stops promotion until it is fixed and retested.
