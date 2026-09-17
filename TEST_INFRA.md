# E2E Test Infra: Nabd/Kiur Backend Rewrite

## Test Philosophy
- **Requirement-Driven & Opaque-Box**: All test assertions are based on external HTTP client behavior, endpoint schemas, status codes, and JSON response bodies. No reliance on internal implementation details.
- **Methodology**: 4-Tier verification hierarchy:
  1. **Tier 1 - Feature Coverage**: Verifies every endpoint and feature in isolation (happy-path, representative inputs, status codes, correct JSON shapes).
  2. **Tier 2 - Boundary & Corner Cases**: Tests invalid IDs, missing fields, malformed inputs, unauthorized access, expired tokens, anti-piracy session eviction, rate limits.
  3. **Tier 3 - Cross-Feature Combinations**: Pairwise and sequential interactions (e.g. register -> login -> change password -> restore session; professor creates course -> adds lecture -> student tracks progress).
  4. **Tier 4 - Real-World Application Scenarios**: Multi-step user journeys mirroring complete production workflows (student full onboarding to exam submission and leaderboard check; professor content authoring; store order to activation code redemption).
  5. **Tier 5 - Adversarial Coverage Hardening**: White-box stress tests, fuzzing, and edge-case probing executed during final verification.

## Test Architecture
- **Framework**: Vitest (`vitest`).
- **Runner**: Executes against Hono app instance using `app.request(url, init, env)` or `@cloudflare/vitest-pool-workers`.
- **Mock / Local D1 & R2 Harness**:
  - D1 database initialized with `migrations/0000_initial_schema.sql` on an in-memory SQLite instance or Miniflare D1 binding.
  - In-memory R2 bucket mock supporting `put()`, `get()`, `delete()`, `head()`.
- **Pass/Fail Semantics**: Zero failures allowed; 100% assertions must pass with exit code 0.

## Feature Inventory Test Mapping
| # | Feature | Endpoints Tested | Tier 1 Target | Tier 2 Target | Tier 3 Pairings | Tier 4 Scenarios |
|---|---|---|:---:|:---:|:---:|:---:|
| 1 | Auth & Session | `/auth/register`, `/auth/login`, `/auth/session/restore`, `/auth/logout` | ≥ 10 | ≥ 10 | Auth + Session Eviction | S1: Full User Lifecycle |
| 2 | Account & Profile | `/auth/me`, `/auth/change-password`, `/auth/forgot-password`, `/auth/reset-password` | ≥ 8 | ≥ 8 | Password Change + Login | S1 |
| 3 | 2FA (TOTP) | `/auth/2fa/setup`, `/auth/2fa/verify`, `/auth/2fa/disable`, `/auth/2fa/login` | ≥ 6 | ≥ 6 | 2FA + Login Challenge | S1 |
| 4 | Academic Catalog | `/api/catalog/sections`, `/universities`, `/stages`, `/subjects`, `/booklets` | ≥ 10 | ≥ 8 | Catalog + Filters | S2: Curriculum Browsing |
| 5 | Questions & Saved | `/api/questions/*`, `/api/saved-questions/*` | ≥ 10 | ≥ 8 | Questions + Saved Notes | S2 |
| 6 | Exams & Scoring | `/api/exams/*` (create, start attempt, submit answer, finish, leaderboard) | ≥ 12 | ≥ 10 | Exam Attempt + Scoring | S3: Student Exam Flow |
| 7 | Students & Skills | `/api/students/profile`, `/stats`, `/skills`, `/study-tracker`, `/lecture-progress` | ≥ 10 | ≥ 8 | Exam + Stats Update | S3 |
| 8 | Clinical Pearls | `/api/pearls/*` (daily, bookmark, reaction) | ≥ 6 | ≥ 6 | Pearls + Bookmarks | S2 |
| 9 | Courses & Lectures | `/api/courses/*`, `/api/lectures/*`, `/recent-views` | ≥ 10 | ≥ 8 | Course + Video Progress | S4: Course Consumption |
| 10 | Professor Portal | `/api/professors/*` (profile, booklets, questions, exams, courses, lectures) | ≥ 14 | ≥ 10 | Professor Authoring + Media | S4 |
| 11 | Store & Products | `/api/store/products`, `/api/store/orders`, `/api/store/order-items` | ≥ 10 | ≥ 8 | Order + Fulfillment | S5: Store & Activation |
| 12 | Reseller & Activation | `/api/reseller/*`, `/api/activation/redeem` | ≥ 8 | ≥ 8 | Code Gen + Redemption | S5 |
| 13 | Admin & Bans | `/api/admin/*`, `/api/bans/*` | ≥ 12 | ≥ 10 | Admin Ban + Eviction | S6: Admin Governance |
| 14 | Media & Streaming | `/media-files/:name` (Range requests, uploads) | ≥ 8 | ≥ 8 | Upload + Range Seek | S4, S6 |
| 15 | Notifications | `/api/notifications/*` | ≥ 6 | ≥ 6 | Trigger + Notification | S3, S5 |

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Expected Outcome |
|---|---|---|---|
| S1 | Full Student Onboarding & Auth Lifecycle | Register, Login, Update Profile, Change Password, Enable 2FA, 2FA Login, Session Restore on New Device (Old Device Invalidation) | 100% correct status codes, token rotation, and single-session enforcement |
| S2 | Curriculum Navigation & Question Practice | Browse Section -> University -> Stage -> Subject -> Booklets -> Practice Questions -> Save Question with Notes | Correct hierarchy navigation, bookmarking, and notes persistence |
| S3 | Timed Exam Taking & Dynamic Scoring | Start Exam Attempt, Submit 5 Question Answers, Finish Attempt, Review Score, Verify Student Stats & Skills Updated, Check Leaderboard | Exam score calculated accurately, leaderboard updated, student stats incremented |
| S4 | Professor Course Creation & Student Streaming | Professor creates course, adds lectures, uploads lecture video, student starts lecture, updates progress, requests video with Range `bytes=0-1000` | HTTP 206 Partial Content returned, video progress recorded, recent views updated |
| S5 | Store Purchase to Activation Code Redemption | Student creates digital product order, Admin marks paid (code issued), Student redeems code, Role/access upgraded, attempt re-redeem (blocked) | Code generated, redeemed cleanly, rate limit / lock on repeated invalid codes |
| S6 | Admin Governance, Audit Logging & User Ban | Admin views overview, inspects audit logs, bans suspicious user, verified that banned user's token is immediately rejected on subsequent requests | Immediate 403 Forbidden with ban reason returned to banned user |

## Coverage Thresholds
- **Tier 1**: ≥ 130 test cases across all 15 feature groups
- **Tier 2**: ≥ 120 boundary & negative test cases
- **Tier 3**: ≥ 25 cross-feature combinatorial test cases
- **Tier 4**: ≥ 6 comprehensive real-world workload scenarios
- **Total Minimum Test Count**: ≥ 280 test cases
