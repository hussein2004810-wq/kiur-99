# KIUR-99 permission matrix

This is the server-side authorization contract.  A hidden client control or a
known identifier never grants access.  `scope` means the academic hierarchy
and an active subject entitlement, where applicable.

| Resource / operation | Anonymous | Student | Professor | Reseller | Admin |
| --- | --- | --- | --- | --- | --- |
| Account registration and email verification | May create an unverified student only; no session is issued | Verify own mailbox before login | Same | Same | Provisioned by an authenticated admin workflow | Provisioned by an authenticated admin workflow |
| Profile directory and booklet metadata | Read metadata only; no raw file URL | Same | Same | Same | Same |
| Booklet, lecture and protected media bytes | Deny | Allowed only with scope/entitlement | Own subject/course or assigned subject | Deny | Allowed |
| Courses, questions and exams | No protected content | Scoped subjects or active activation code | Assigned subjects; own courses are allowed | Deny | Allowed |
| Start, answer, finish and review an attempt | Deny | Own attempts only | Deny unless separately assigned as a student | Deny | No cross-user mutation through student routes |
| Student directory and profile | Deny | Exact academic peer scope; own profile always | Stages of assigned subjects | Deny | All students; email is admin-only |
| Professor booklet/question/exam/course mutations | Deny | Deny | Only resources owned by the professor profile and its subject | Deny | Any valid professor profile/subject |
| Activation-code redemption | Deny | Own account; IP and account limiter | Own account if eligible | Own account if eligible | Allowed by role policy |
| Reseller code inventory and sales | Deny | Deny | Deny | Own inventory only | Allowed |

## Enforcement points

- `src/services/content-access.ts` resolves course and media entitlement.
- `src/routes/questions.ts`, `src/routes/exams.ts`, and `src/routes/students.ts` enforce scope at read and mutation boundaries.
- `src/routes/professors.ts` resolves the caller's professor profile before content writes; supplied owner identifiers cannot override it.
- `src/middleware/auth.ts` verifies the token, session, user, ban state, issuer, audience, type, and access-token session binding.
- `src/routes/auth.ts` ignores public role input, creates every public account as an unverified student, and refuses login, 2FA completion, and session restoration until mailbox verification succeeds.
- `src/middleware/rate-limit.ts` applies durable D1 limits to both IP and authenticated account where available.

## Regression evidence

- `test/security/p0-remediation.test.ts`: public media metadata and direct content authorization.
- `test/security/phase-b-remediation.test.ts`: cross-professor mutation and academic-scope denial.
- `test/security/phase-c-exams-integrity.test.ts`: attempt ownership, snapshots, idempotency, and long-attempt D1 bounds.
- `test/security/phase-d-hardening.test.ts`: account-aware durable rate limit.

Any new route must be added to this matrix and receive a source-target test for
an unauthorized user before release.
