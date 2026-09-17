# Database Layer Survey & Cloudflare D1 / Drizzle ORM Migration Blueprint

## Executive Summary
This report delivers an exhaustive audit of the database layer in the Nabd/Kiur medical education platform (`c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى`). The Python backend currently uses SQLAlchemy 2.0.35 with a hybrid SQLite (development) and PostgreSQL (production via psycopg 3.2.13) configuration. Exactly **30 tables** and **5 enumerations** are declared in `app/models.py`. There are **no Alembic migrations**; table lifecycle has been managed via `Base.metadata.create_all(bind=engine)` and an ad-hoc runtime reflection function `_patch_missing_columns()` in `app/main.py`.

All 30 tables map cleanly to SQLite and Cloudflare D1. No PostgreSQL-specific proprietary types (such as `JSONB`, `ARRAY`, `UUID`, `TSVECTOR`, or custom extensions) are used anywhere in the codebase. All primary keys are 12-character hex strings generated via `uuid.uuid4().hex[:12]`. All dates are UTC timestamps. This document provides the complete table and column catalog, query patterns, relationship tree, and the full Drizzle ORM schema specification ready for implementation.

---

## 1. Observation

### 1.1 Database Configuration & Lifecycle Findings
- **Database Engine Setup** (`app/database.py:1-47`):
  - `database_url`: Loaded from `.env` via `pydantic-settings` (`Settings.database_url`).
  - Default URL: `sqlite:///./nabd.db` (`app/config.py:10`).
  - Production URL normalization (`app/database.py:9-19`): Automatically converts `postgres://` or `postgresql://` prefixes to `postgresql+psycopg://`.
  - SQLite parameters: `connect_args={"check_same_thread": False}`.
  - PostgreSQL parameters: `pool_pre_ping=True`, `pool_recycle=300`.
  - Session factory: `SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)`.
  - Base: `Base = declarative_base()`.
- **Absence of Alembic Migrations**:
  - `requirements.txt` does not include `alembic`.
  - No `alembic.ini`, `migrations/`, or `versions/` directories exist in the workspace.
  - Dynamic column patching (`app/main.py:88-137`): At startup (`@app.on_event("startup")`), `Base.metadata.create_all(bind=engine)` is executed, followed by `_patch_missing_columns()`. That function reflects table columns using `inspect(engine)` and issues raw `ALTER TABLE ... ADD COLUMN ...` and `UPDATE ... SET ... WHERE ... IS NULL` statements for missing model attributes.
- **Seeding Mechanism** (`seed.py:1-216`):
  - Automatically seeds demo academic hierarchy (Section -> University -> Stage -> 4 Subjects), 5 professors with booklets & exams, MCQ questions with 4 choices each, courses with lectures, store products with activation codes, admin/reseller accounts, student answers, and clinical pearls.
  - Demo accounts use password `Nabd@2026` hashed with PBKDF2-HMAC-SHA256 (200,000 iterations).

### 1.2 Enumerations
Defined in `app/models.py:17-47`:
1. `Role(str, enum.Enum)`:
   - Values: `"student"`, `"professor"`, `"admin"`, `"reseller"`
2. `ProductType(str, enum.Enum)`:
   - Values: `"digital"`, `"physical"`, `"course"`
3. `OrderStatus(str, enum.Enum)`:
   - Values: `"pending"`, `"paid"`, `"fulfilled"`, `"cancelled"`
4. `BanStatus(str, enum.Enum)`:
   - Values: `"active"`, `"appealed"`, `"lifted"`
5. `CodeStatus(str, enum.Enum)`:
   - Values: `"idle"`, `"active"`, `"expired"`

### 1.3 Complete Table-by-Table Catalog (30 Tables)

#### Table 1: `users`
- Model: `models.User` (`app/models.py:50-90`)
- Purpose: Core user account for all roles (students, professors, admins, resellers).
- Primary Key: `id` (String(12), generated via `gen_id()`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default / Generation | Constraints / Indexes |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `email` | String | False | None | UNIQUE, INDEX |
  | `full_name` | String | False | None | |
  | `google_sub` | String | True | None | UNIQUE, INDEX |
  | `password_hash` | String | True | None | |
  | `role` | Enum(Role) | False | `Role.student` | |
  | `university_id` | String | True | None | FK(`universities.id`) |
  | `stage_id` | String | True | None | FK(`stages.id`) |
  | `section_id` | String | True | None | FK(`sections.id`) |
  | `phone` | String | True | None | |
  | `is_graduate` | Boolean | True | None | (null = unasked) |
  | `is_banned` | Boolean | False | `default=False` | |
  | `totp_secret` | String | True | None | |
  | `totp_enabled` | Boolean | False | `default=False` | |
  | `photo_url` | String | True | None | |
  | `caption` | String | True | None | |
  | `failed_login_attempts` | Integer | False | `default=0` | |
  | `locked_until` | DateTime | True | None | |
  | `failed_redeem_attempts` | Integer | False | `default=0` | |
  | `reset_token_hash` | String | True | None | |
  | `reset_token_expires_at` | DateTime | True | None | |
  | `reset_requested_at` | DateTime | True | None | |
  | `password_changed_at` | DateTime | True | None | |
  | `redeem_locked_until` | DateTime | True | None | |
  | `theme` | String | False | `default="light"` | |
  | `language` | String | False | `default="ar"` | |
  | `created_at` | DateTime | False | `default=datetime.utcnow` | |
- Relationships:
  - `university`: `relationship("University")`
  - `stage`: `relationship("Stage")`
  - `section`: `relationship("Section")`
  - `sessions`: `relationship("UserSession", back_populates="user", cascade="all, delete-orphan")`

#### Table 2: `user_sessions`
- Model: `models.UserSession` (`app/models.py:91-102`)
- Purpose: Authentication sessions. Enforces single-active-session anti-piracy policy.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `user_id` | String | False | None | FK(`users.id`) |
  | `device_label` | String | False | `default="جهاز غير معروف"` | |
  | `is_active` | Boolean | False | `default=True` | |
  | `created_at` | DateTime | False | `default=datetime.utcnow` | |
- Relationships:
  - `user`: `relationship("User", back_populates="sessions")`

#### Table 3: `sections`
- Model: `models.Section` (`app/models.py:105-111`)
- Purpose: Top-level curriculum domain (e.g. "طب بشري" - Medicine).
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `name` | String | False | None | |
- Relationships:
  - `universities`: `relationship("University", back_populates="section")`

#### Table 4: `universities`
- Model: `models.University` (`app/models.py:113-121`)
- Purpose: Universities offering the section (e.g. "جامعة بغداد").
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `name` | String | False | None | |
  | `section_id` | String | False | None | FK(`sections.id`) |
- Relationships:
  - `section`: `relationship("Section", back_populates="universities")`
  - `stages`: `relationship("Stage", back_populates="university")`

#### Table 5: `stages`
- Model: `models.Stage` (`app/models.py:123-131`)
- Purpose: Academic years/stages within a university (e.g. "المرحلة الثانية").
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `name` | String | False | None | |
  | `university_id` | String | False | None | FK(`universities.id`) |
- Relationships:
  - `university`: `relationship("University", back_populates="stages")`
  - `subjects`: `relationship("Subject", back_populates="stage")`

#### Table 6: `subjects`
- Model: `models.Subject` (`app/models.py:133-140`)
- Purpose: Academic subjects within a stage (e.g. "التشريح", "الفسلجة").
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `name` | String | False | None | |
  | `stage_id` | String | False | None | FK(`stages.id`) |
- Relationships:
  - `stage`: `relationship("Stage", back_populates="subjects")`

#### Table 7: `professor_profiles`
- Model: `models.ProfessorProfile` (`app/models.py:143-155`)
- Purpose: Academic profile binding a professor user to their teaching subject.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `user_id` | String | False | None | FK(`users.id`) |
  | `title` | String | False | `default="أستاذ مساعد"` | |
  | `subject_id` | String | False | None | FK(`subjects.id`) |
  | `bio` | Text | False | `default=""` | |
  | `photo_url` | String | True | None | |
- Relationships:
  - `user`: `relationship("User")`
  - `subject`: `relationship("Subject")`

#### Table 8: `booklets`
- Model: `models.Booklet` (`app/models.py:156-164`)
- Purpose: Study booklets / lecture notes (PDF/document) uploaded by professors.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `professor_id` | String | False | None | FK(`professor_profiles.id`) |
  | `title` | String | False | None | |
  | `file_url` | String | False | `default=""` | |
  | `pages` | Integer | False | `default=0` | |
  | `created_at` | DateTime | False | `default=datetime.utcnow` | |

#### Table 9: `questions`
- Model: `models.Question` (`app/models.py:167-179`)
- Purpose: MCQ question bank.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `subject_id` | String | False | None | FK(`subjects.id`) |
  | `professor_id` | String | True | None | FK(`professor_profiles.id`) |
  | `text` | Text | False | None | |
  | `image_url` | String | True | None | |
  | `rationale` | Text | False | `default=""` | |
  | `eyebrow` | String | False | `default=""` | |
- Relationships:
  - `subject`: `relationship("Subject")`
  - `choices`: `relationship("Choice", back_populates="question", cascade="all, delete-orphan")`

#### Table 10: `choices`
- Model: `models.Choice` (`app/models.py:181-190`)
- Purpose: MCQ answer choices (options) for a question.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `question_id` | String | False | None | FK(`questions.id`) |
  | `text` | String | False | None | |
  | `is_correct` | Boolean | False | `default=False` | |
  | `order_index` | Integer | False | `default=0` | |
- Relationships:
  - `question`: `relationship("Question", back_populates="choices")`

#### Table 11: `student_answers`
- Model: `models.StudentAnswer` (`app/models.py:192-202`)
- Purpose: Log of all question answers for spaced repetition, progress, streaks, and analytics.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `user_id` | String | False | None | FK(`users.id`) |
  | `question_id` | String | False | None | FK(`questions.id`) |
  | `choice_id` | String | False | None | FK(`choices.id`) |
  | `is_correct` | Boolean | False | None | |
  | `answered_at` | DateTime | False | `default=datetime.utcnow` | |

#### Table 12: `exams`
- Model: `models.Exam` (`app/models.py:204-214`)
- Purpose: Timed exams created by professors.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `subject_id` | String | False | None | FK(`subjects.id`) |
  | `professor_id` | String | True | None | FK(`professor_profiles.id`) |
  | `title` | String | False | None | |
  | `question_count` | Integer | False | `default=0` | |
  | `duration_minutes` | Integer | False | `default=30` | |
- Relationships:
  - `subject`: `relationship("Subject")`

#### Table 13: `courses`
- Model: `models.Course` (`app/models.py:217-227`)
- Purpose: Video lecture courses.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `subject_id` | String | False | None | FK(`subjects.id`) |
  | `professor_id` | String | True | None | FK(`professor_profiles.id`) |
  | `title` | String | False | None | |
- Relationships:
  - `subject`: `relationship("Subject")`
  - `professor`: `relationship("ProfessorProfile")`
  - `lectures`: `relationship("Lecture", back_populates="course", cascade="all, delete-orphan")`

#### Table 14: `lectures`
- Model: `models.Lecture` (`app/models.py:229-239`)
- Purpose: Individual video lecture units in a course.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `course_id` | String | False | None | FK(`courses.id`) |
  | `title` | String | False | None | |
  | `duration_seconds` | Integer | False | `default=0` | |
  | `order_index` | Integer | False | `default=0` | |
  | `video_url` | String | False | `default=""` | |
- Relationships:
  - `course`: `relationship("Course", back_populates="lectures")`

#### Table 15: `recent_views`
- Model: `models.RecentView` (`app/models.py:241-251`)
- Purpose: Tracks student's most recently viewed booklets and lectures ("continue where I left off").
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `user_id` | String | False | None | FK(`users.id`) |
  | `content_type` | String | False | None | ("booklet" \| "lecture") |
  | `content_id` | String | False | None | |
  | `viewed_at` | DateTime | False | `default=datetime.utcnow` | |

#### Table 16: `lecture_progress`
- Model: `models.LectureProgress` (`app/models.py:253-261`)
- Purpose: Records which student has finished watching which lecture.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `user_id` | String | False | None | FK(`users.id`) |
  | `lecture_id` | String | False | None | FK(`lectures.id`) |
  | `completed_at` | DateTime | False | `default=datetime.utcnow` | |

#### Table 17: `activation_codes`
- Model: `models.ActivationCode` (`app/models.py:264-282`)
- Purpose: VIP / subject activation license codes.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `code` | String | False | None | UNIQUE |
  | `subject_id` | String | True | None | FK(`subjects.id`) (null = VIP) |
  | `status` | Enum(CodeStatus) | False | `CodeStatus.idle` | |
  | `activated_by_user_id` | String | True | None | FK(`users.id`) |
  | `activated_at` | DateTime | True | None | |
  | `expires_at` | DateTime | True | None | |
  | `reseller_id` | String | True | None | FK(`users.id`) |
  | `sold_at` | DateTime | True | None | |
  | `order_id` | String | True | None | FK(`orders.id`) |
- Relationships:
  - `subject`: `relationship("Subject")`

#### Table 18: `products`
- Model: `models.Product` (`app/models.py:284-294`)
- Purpose: Store catalog (digital codes, physical goods, courses).
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `name` | String | False | None | |
  | `price` | Integer | False | None | IQD |
  | `type` | Enum(ProductType) | False | None | |
  | `is_activation_code` | Boolean | False | `default=False` | |
  | `grants_subject_id` | String | True | None | FK(`subjects.id`) |
- Relationships:
  - `grants_subject`: `relationship("Subject")`

#### Table 19: `orders`
- Model: `models.Order` (`app/models.py:296-309`)
- Purpose: Student store orders.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `user_id` | String | False | None | FK(`users.id`) |
  | `total` | Integer | False | `default=0` | |
  | `payment_method` | String | False | `default="zaincash"` | |
  | `status` | Enum(OrderStatus) | False | `OrderStatus.pending` | |
  | `created_at` | DateTime | False | `default=datetime.utcnow` | |
  | `delivery_name` | String | True | None | |
  | `delivery_phone` | String | True | None | |
  | `delivery_address` | String | True | None | |
- Relationships:
  - `items`: `relationship("OrderItem", back_populates="order", cascade="all, delete-orphan")`

#### Table 20: `order_items`
- Model: `models.OrderItem` (`app/models.py:311-321`)
- Purpose: Line items inside a store order.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `order_id` | String | False | None | FK(`orders.id`) |
  | `product_id` | String | False | None | FK(`products.id`) |
  | `qty` | Integer | False | `default=1` | |
  | `price` | Integer | False | None | Snapshot unit price |
- Relationships:
  - `order`: `relationship("Order", back_populates="items")`
  - `product`: `relationship("Product")`

#### Table 21: `ban_records`
- Model: `models.BanRecord` (`app/models.py:324-333`)
- Purpose: Account suspension history and appeals.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `user_id` | String | False | None | FK(`users.id`) |
  | `reason` | String | False | None | |
  | `status` | Enum(BanStatus) | False | `BanStatus.active` | |
  | `created_at` | DateTime | False | `default=datetime.utcnow` | |
  | `appeal_message` | Text | True | None | |
  | `appealed_at` | DateTime | True | None | |

#### Table 22: `activity_logs`
- Model: `models.ActivityLog` (`app/models.py:335-342`)
- Purpose: Admin audit trail.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `user_id` | String | True | None | FK(`users.id`) |
  | `action` | String | False | None | |
  | `ip_address` | String | False | `default=""` | |
  | `created_at` | DateTime | False | `default=datetime.utcnow` | |

#### Table 23: `media_files`
- Model: `models.MediaFile` (`app/models.py:344-353`)
- Purpose: File upload metadata (images, PDFs, video recordings).
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `filename` | String | False | None | Sanitized storage key |
  | `url` | String | False | None | URL (`/media-files/<name>`) |
  | `content_type` | String | False | `default=""` | |
  | `size_bytes` | Integer | False | `default=0` | |
  | `uploaded_by` | String | True | None | FK(`users.id`) |
  | `created_at` | DateTime | False | `default=datetime.utcnow` | |

#### Table 24: `exam_attempts`
- Model: `models.ExamAttempt` (`app/models.py:356-372`)
- Purpose: Individual student attempt at an exam with timer and score.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `exam_id` | String | False | None | FK(`exams.id`) |
  | `user_id` | String | False | None | FK(`users.id`) |
  | `started_at` | DateTime | False | `default=datetime.utcnow` | |
  | `finished_at` | DateTime | True | None | |
  | `score` | Integer | False | `default=0` | |
  | `total` | Integer | False | `default=0` | |
- Relationships:
  - `exam`: `relationship("Exam")`
  - `items`: `relationship("ExamAttemptQuestion", back_populates="attempt", cascade="all, delete-orphan")`

#### Table 25: `exam_attempt_questions`
- Model: `models.ExamAttemptQuestion` (`app/models.py:374-386`)
- Purpose: Fixed question snapshot for an exam attempt.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `attempt_id` | String | False | None | FK(`exam_attempts.id`) |
  | `question_id` | String | False | None | FK(`questions.id`) |
  | `order_index` | Integer | False | `default=0` | |
  | `choice_id` | String | True | None | FK(`choices.id`) |
  | `is_correct` | Boolean | True | None | |
  | `answered_at` | DateTime | True | None | |
- Relationships:
  - `attempt`: `relationship("ExamAttempt", back_populates="items")`
  - `question`: `relationship("Question")`

#### Table 26: `user_skills`
- Model: `models.UserSkill` (`app/models.py:389-397`)
- Purpose: Profile skill tags chosen by student (max 12).
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `user_id` | String | False | None | FK(`users.id`) |
  | `text` | String | False | None | |
  | `created_at` | DateTime | False | `default=datetime.utcnow` | |

#### Table 27: `saved_questions`
- Model: `models.SavedQuestion` (`app/models.py:400-407`)
- Purpose: Student bookmarks for questions.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `user_id` | String | False | None | FK(`users.id`) |
  | `question_id` | String | False | None | FK(`questions.id`) |
  | `created_at` | DateTime | False | `default=datetime.utcnow` | |

#### Table 28: `notifications`
- Model: `models.Notification` (`app/models.py:410-427`)
- Purpose: Announcements (broadcast if `user_id` is null, or direct message).
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `user_id` | String | True | None | FK(`users.id`) (null = broadcast) |
  | `title` | String | False | None | |
  | `body` | Text | False | `default=""` | |
  | `created_at` | DateTime | False | `default=datetime.utcnow` | |
  | `created_by` | String | True | None | FK(`users.id`) |
  | `content_type` | String | True | None | ("booklet" \| "exam" \| "course") |
  | `content_id` | String | True | None | |

#### Table 29: `notification_reads`
- Model: `models.NotificationRead` (`app/models.py:429-435`)
- Purpose: Per-user read state for broadcast and direct notifications.
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `notification_id` | String | False | None | FK(`notifications.id`) |
  | `user_id` | String | False | None | FK(`users.id`) |
  | `read_at` | DateTime | False | `default=datetime.utcnow` | |

#### Table 30: `clinical_pearls`
- Model: `models.ClinicalPearl` (`app/models.py:436-453`)
- Purpose: Short clinical cases (public title, gated body for authenticated users).
- Primary Key: `id` (String(12), `default=gen_id`)
- Columns:
  | Column Name | SQLAlchemy Type | Nullable | Default | Constraints |
  |---|---|---|---|---|
  | `id` | String | False | `default=gen_id` | PRIMARY KEY |
  | `tag` | String | False | `default=""` | Short category label |
  | `title` | String | False | None | Publicly visible |
  | `body` | Text | False | `default=""` | Signed-in students only |
  | `created_at` | DateTime | False | `default=datetime.utcnow` | |
  | `created_by` | String | True | None | FK(`users.id`) |

---

## 2. Logic Chain: Analysis of Query Patterns & Migration Compatibility

### 2.1 Database Access & Query Patterns Observed
The codebase exhibits a clean and predictable set of ORM query patterns:

1. **Aggregations & Grouped Analytics**:
   - `ranking.py:37`: `func.count(distinct(models.StudentAnswer.question_id))` with `.group_by(models.StudentAnswer.user_id)` for distinct scoring.
   - `ranking.py:62`: `func.sum(case((models.StudentAnswer.is_correct.is_(True), 1), else_=0))` for calculating student accuracy percentage.
   - `ranking.py:90`: `func.date(models.StudentAnswer.answered_at).label("day")` with `.distinct()` for streak calculation.
   - `admin.py:69`: `func.coalesce(func.sum(models.Order.total), 0).scalar()` for revenue KPI.
   - `admin.py:90`: `func.date(date_column).label("day")` with `func.count()` grouped by `day` for 7-day activity metrics.
   - `auth.py:567`: Daily question answer statistics grouped by `func.date(models.StudentAnswer.answered_at)`.
2. **Explicit Joins**:
   - `admin.py:937`: `StudentAnswer` JOIN `Question` ON `Question.id == StudentAnswer.question_id` (weak topics analysis).
   - `courses.py:61`: `Booklet` JOIN `ProfessorProfile` ON `ProfessorProfile.id == Booklet.professor_id` WHERE `ProfessorProfile.subject_id == c.subject_id`.
   - `professors.py:152, 182`: `StudentAnswer` JOIN `Question` ON `Question.id == StudentAnswer.question_id` WHERE `Question.subject_id == profile.subject_id`.
   - `public.py:24`: `ProfessorProfile` JOIN `User` ON `User.id == ProfessorProfile.user_id` WHERE `User.is_banned == False`.
3. **Eager Loading (`joinedload`)**:
   - `catalog.py:15-18`: 4-level deep hierarchy eager load: `Section.universities` -> `University.stages` -> `Stage.subjects`.
   - `questions.py:21, 102, 139`: `Question.choices`.
   - `courses.py:35`: `Course.lectures`.
   - `exams.py:51`: `ExamAttemptQuestion.question` -> `Question.choices`.
   - `professors.py:39-42`: `ProfessorProfile.user`, `ProfessorProfile.subject` -> `Subject.stage` -> `Stage.university`.
4. **Ordering with Null Handling**:
   - `admin.py:260` & `reseller.py:46`: `order_by(models.ActivationCode.sold_at.desc().nullslast())`.
   - In SQLite 3.30.0+ (and Cloudflare D1), `NULLS LAST` is natively supported in SQL syntax: `ORDER BY sold_at DESC NULLS LAST`.
5. **Pagination & Limit/Offset**:
   - `questions.py:23-24`: `.offset(offset).limit(limit)`.
   - `students.py:19`: `.order_by(models.User.full_name).limit(limit)`.
   - `notifications.py:21`: `.order_by(models.Notification.created_at.desc()).limit(limit)`.
   - `admin.py:317`: `.limit(limit)`.
   - `import_export.py:97`: `.limit(500)`.
6. **Filtering / Search**:
   - `students.py:18`: `models.User.full_name.ilike(f"%{term}%")`. In SQLite, standard `LIKE` is case-insensitive for ASCII, or `LOWER(full_name) LIKE LOWER(?)` can be used for multi-byte Unicode strings.
7. **Transactions & Deletions**:
   - Manual dependent row purges (`professors.py:245-250`, `professors.py:442-448`, `questions.py:82`, `admin.py:924`).
   - Anti-piracy session deactivation (`security.py:160`): `UPDATE user_sessions SET is_active = 0 WHERE user_id = ? AND is_active = 1`.
   - Single-use password reset token consumption (`auth.py:879`): Invalidates all active sessions on password reset.
   - Catalog import preview rollback (`admin.py:733`): `db.rollback()` after simulating bulk curriculum creation.

### 2.2 Cloudflare D1 (SQLite) Type Conversion & Compatibility Analysis

| SQLAlchemy / Python Concept | PostgreSQL Dialect | SQLite / Cloudflare D1 Mapping | Drizzle ORM Definition | Rationale & Notes |
|---|---|---|---|---|
| **ID / String PK** | `VARCHAR`, `TEXT` | `TEXT PRIMARY KEY` | `text('id').primaryKey().$defaultFn(genId)` | 12-char hex string generated by `crypto.randomUUID().replace(/-/g, '').slice(0, 12)` |
| **String / Text** | `VARCHAR(N)`, `TEXT` | `TEXT` | `text('column_name')` | SQLite treats all strings as TEXT affinity |
| **Integer** | `INTEGER` | `INTEGER` | `integer('column_name')` | Integer prices, counts, seconds, order index |
| **Boolean** | `BOOLEAN` | `INTEGER` (0 or 1) | `integer('column_name', { mode: 'boolean' })` | Drizzle automatically handles boolean serialization (true <-> 1, false <-> 0) |
| **DateTime** | `TIMESTAMP WITHOUT TIME ZONE` | `TEXT` (ISO 8601) | `text('created_at').default(sql`(CURRENT_TIMESTAMP)`)` or `integer('...', { mode: 'timestamp' })` | Recommendation: ISO 8601 text format (`YYYY-MM-DDTHH:MM:SS.sssZ`) matches JavaScript Date serialization perfectly and supports SQLite `strftime()` and `date()` |
| **Enums** | `ENUM(...)` | `TEXT` | `text('role', { enum: ['student', 'professor', 'admin', 'reseller'] })` | Drizzle provides TypeScript compile-time checking and runtime Zod validation |
| **JSON / JSONB** | `JSONB` | `TEXT` | N/A | None of the 30 models use JSON columns. Schema is fully normalized |
| **Foreign Keys** | `FOREIGN KEY` | `REFERENCES table(id)` | `.references(() => targetTable.id, { onDelete: 'cascade' })` | D1 executes standard SQLite foreign keys |

---

## 3. Caveats & Edge Cases

1. **Foreign Key Enforcement in D1**:
   - SQLite disables foreign key enforcement by default unless `PRAGMA foreign_keys = ON;` is executed on the connection. While Cloudflare D1 enforces foreign keys in current runtimes, the application logic must not rely exclusively on database-level cascading deletes. The existing Python codebase already manually purges related entities (e.g. `_purge_lecture_traces` in `professors.py` and `_drop_content_notifications`). The new TypeScript backend should continue this defensive pattern.
2. **Date Storage Format (`date()` vs `strftime()`)**:
   - In SQLite, the `date(timestring)` function expects strings formatted as `'YYYY-MM-DD HH:MM:SS'` or `'YYYY-MM-DDTHH:MM:SS'`. If ISO strings with timezone suffixes like `'Z'` are inserted (`2026-09-17T00:17:35.000Z`), `date(col)` correctly extracts `'2026-09-17'`.
   - When calculating streaks and daily activity (`ranking.py:85-111` and `admin.py:83-104`), `strftime('%Y-%m-%d', answered_at)` or `date(answered_at)` in D1 must be used consistently.
3. **Arabic Unicode Search (`ilike` / `like`)**:
   - SQLite's default `LIKE` operator is case-insensitive only for ASCII characters (`a-z`). Arabic text does not have case differences, but for searches with Latin characters, `lower(column) LIKE lower(?)` guarantees consistent case folding.
4. **D1 Single-Writer Concurrency & Transaction Latency**:
   - D1 is distributed across Cloudflare's edge network for reads, but writes are routed to the primary D1 coordinator. Batching statements via D1's `db.batch([...])` or Drizzle transactions is required for multi-row operations (such as bulk catalog import or exam question shuffling).
5. **No Alembic Migration History to Preserve**:
   - Because no Alembic versions or migration table (`alembic_version`) exist in the production database, the D1 deployment does not need to back-port Alembic migration steps. A single clean initial Drizzle migration (`0000_initial.sql`) establishing all 30 tables and their indexes is the optimal strategy.

---

## 4. Conclusion & Recommended Architecture

### 4.1 Schema Blueprint Recommendation
Use **Drizzle ORM** (`drizzle-orm/d1`) with `drizzle-kit` for schema management.
- Schema file location: `src/db/schema.ts`
- Database client setup: `src/db/client.ts` receiving `c.env.DB` from Hono's Context.
- ID Generator: Utility `genId()` returning a 12-char hex string:
  ```ts
  export function genId(): string {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  ```

### 4.2 Complete Proposed Drizzle ORM Schema (`src/db/schema.ts`)

```typescript
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { relations, sql } from 'drizzle-orm';

export function genId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

// ---------------------------------------------------------------- Enums
export const roles = ['student', 'professor', 'admin', 'reseller'] as const;
export type Role = (typeof roles)[number];

export const productTypes = ['digital', 'physical', 'course'] as const;
export type ProductType = (typeof productTypes)[number];

export const orderStatuses = ['pending', 'paid', 'fulfilled', 'cancelled'] as const;
export type OrderStatus = (typeof orderStatuses)[number];

export const banStatuses = ['active', 'appealed', 'lifted'] as const;
export type BanStatus = (typeof banStatuses)[number];

export const codeStatuses = ['idle', 'active', 'expired'] as const;
export type CodeStatus = (typeof codeStatuses)[number];

// ---------------------------------------------------------------- 1. users
export const users = sqliteTable('users', {
  id: text('id').primaryKey().$defaultFn(genId),
  email: text('email').notNull(),
  fullName: text('full_name').notNull(),
  googleSub: text('google_sub'),
  passwordHash: text('password_hash'),
  role: text('role', { enum: roles }).notNull().default('student'),
  universityId: text('university_id').references(() => universities.id),
  stageId: text('stage_id').references(() => stages.id),
  sectionId: text('section_id').references(() => sections.id),
  phone: text('phone'),
  isGraduate: integer('is_graduate', { mode: 'boolean' }),
  isBanned: integer('is_banned', { mode: 'boolean' }).notNull().default(false),
  totpSecret: text('totp_secret'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
  photoUrl: text('photo_url'),
  caption: text('caption'),
  failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
  lockedUntil: text('locked_until'),
  failedRedeemAttempts: integer('failed_redeem_attempts').notNull().default(0),
  resetTokenHash: text('reset_token_hash'),
  resetTokenExpiresAt: text('reset_token_expires_at'),
  resetRequestedAt: text('reset_requested_at'),
  passwordChangedAt: text('password_changed_at'),
  redeemLockedUntil: text('redeem_locked_until'),
  theme: text('theme').notNull().default('light'),
  language: text('language').notNull().default('ar'),
  createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => ({
  emailIdx: uniqueIndex('users_email_idx').on(table.email),
  googleSubIdx: uniqueIndex('users_google_sub_idx').on(table.googleSub),
}));

// ---------------------------------------------------------------- 2. user_sessions
export const userSessions = sqliteTable('user_sessions', {
  id: text('id').primaryKey().$defaultFn(genId),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  deviceLabel: text('device_label').notNull().default('جهاز غير معروف'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

// ---------------------------------------------------------------- 3. sections
export const sections = sqliteTable('sections', {
  id: text('id').primaryKey().$defaultFn(genId),
  name: text('name').notNull(),
});

// ---------------------------------------------------------------- 4. universities
export const universities = sqliteTable('universities', {
  id: text('id').primaryKey().$defaultFn(genId),
  name: text('name').notNull(),
  sectionId: text('section_id').notNull().references(() => sections.id),
});

// ---------------------------------------------------------------- 5. stages
export const stages = sqliteTable('stages', {
  id: text('id').primaryKey().$defaultFn(genId),
  name: text('name').notNull(),
  universityId: text('university_id').notNull().references(() => universities.id),
});

// ---------------------------------------------------------------- 6. subjects
export const subjects = sqliteTable('subjects', {
  id: text('id').primaryKey().$defaultFn(genId),
  name: text('name').notNull(),
  stageId: text('stage_id').notNull().references(() => stages.id),
});

// ---------------------------------------------------------------- 7. professor_profiles
export const professorProfiles = sqliteTable('professor_profiles', {
  id: text('id').primaryKey().$defaultFn(genId),
  userId: text('user_id').notNull().references(() => users.id),
  title: text('title').notNull().default('أستاذ مساعد'),
  subjectId: text('subject_id').notNull().references(() => subjects.id),
  bio: text('bio').notNull().default(''),
  photoUrl: text('photo_url'),
});

// ---------------------------------------------------------------- 8. booklets
export const booklets = sqliteTable('booklets', {
  id: text('id').primaryKey().$defaultFn(genId),
  professorId: text('professor_id').notNull().references(() => professorProfiles.id),
  title: text('title').notNull(),
  fileUrl: text('file_url').notNull().default(''),
  pages: integer('pages').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

// ---------------------------------------------------------------- 9. questions
export const questions = sqliteTable('questions', {
  id: text('id').primaryKey().$defaultFn(genId),
  subjectId: text('subject_id').notNull().references(() => subjects.id),
  professorId: text('professor_id').references(() => professorProfiles.id),
  text: text('text').notNull(),
  imageUrl: text('image_url'),
  rationale: text('rationale').notNull().default(''),
  eyebrow: text('eyebrow').notNull().default(''),
});

// ---------------------------------------------------------------- 10. choices
export const choices = sqliteTable('choices', {
  id: text('id').primaryKey().$defaultFn(genId),
  questionId: text('question_id').notNull().references(() => questions.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  isCorrect: integer('is_correct', { mode: 'boolean' }).notNull().default(false),
  orderIndex: integer('order_index').notNull().default(0),
});

// ---------------------------------------------------------------- 11. student_answers
export const studentAnswers = sqliteTable('student_answers', {
  id: text('id').primaryKey().$defaultFn(genId),
  userId: text('user_id').notNull().references(() => users.id),
  questionId: text('question_id').notNull().references(() => questions.id),
  choiceId: text('choice_id').notNull().references(() => choices.id),
  isCorrect: integer('is_correct', { mode: 'boolean' }).notNull(),
  answeredAt: text('answered_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

// ---------------------------------------------------------------- 12. exams
export const exams = sqliteTable('exams', {
  id: text('id').primaryKey().$defaultFn(genId),
  subjectId: text('subject_id').notNull().references(() => subjects.id),
  professorId: text('professor_id').references(() => professorProfiles.id),
  title: text('title').notNull(),
  questionCount: integer('question_count').notNull().default(0),
  durationMinutes: integer('duration_minutes').notNull().default(30),
});

// ---------------------------------------------------------------- 13. courses
export const courses = sqliteTable('courses', {
  id: text('id').primaryKey().$defaultFn(genId),
  subjectId: text('subject_id').notNull().references(() => subjects.id),
  professorId: text('professor_id').references(() => professorProfiles.id),
  title: text('title').notNull(),
});

// ---------------------------------------------------------------- 14. lectures
export const lectures = sqliteTable('lectures', {
  id: text('id').primaryKey().$defaultFn(genId),
  courseId: text('course_id').notNull().references(() => courses.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  durationSeconds: integer('duration_seconds').notNull().default(0),
  orderIndex: integer('order_index').notNull().default(0),
  videoUrl: text('video_url').notNull().default(''),
});

// ---------------------------------------------------------------- 15. recent_views
export const recentViews = sqliteTable('recent_views', {
  id: text('id').primaryKey().$defaultFn(genId),
  userId: text('user_id').notNull().references(() => users.id),
  contentType: text('content_type').notNull(), // 'booklet' | 'lecture'
  contentId: text('content_id').notNull(),
  viewedAt: text('viewed_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

// ---------------------------------------------------------------- 16. lecture_progress
export const lectureProgress = sqliteTable('lecture_progress', {
  id: text('id').primaryKey().$defaultFn(genId),
  userId: text('user_id').notNull().references(() => users.id),
  lectureId: text('lecture_id').notNull().references(() => lectures.id),
  completedAt: text('completed_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

// ---------------------------------------------------------------- 17. activation_codes
export const activationCodes = sqliteTable('activation_codes', {
  id: text('id').primaryKey().$defaultFn(genId),
  code: text('code').notNull(),
  subjectId: text('subject_id').references(() => subjects.id),
  status: text('status', { enum: codeStatuses }).notNull().default('idle'),
  activatedByUserId: text('activated_by_user_id').references(() => users.id),
  activatedAt: text('activated_at'),
  expiresAt: text('expires_at'),
  resellerId: text('reseller_id').references(() => users.id),
  soldAt: text('sold_at'),
  orderId: text('order_id').references(() => orders.id),
}, (table) => ({
  codeIdx: uniqueIndex('activation_codes_code_idx').on(table.code),
}));

// ---------------------------------------------------------------- 18. products
export const products = sqliteTable('products', {
  id: text('id').primaryKey().$defaultFn(genId),
  name: text('name').notNull(),
  price: integer('price').notNull(),
  type: text('type', { enum: productTypes }).notNull(),
  isActivationCode: integer('is_activation_code', { mode: 'boolean' }).notNull().default(false),
  grantsSubjectId: text('grants_subject_id').references(() => subjects.id),
});

// ---------------------------------------------------------------- 19. orders
export const orders = sqliteTable('orders', {
  id: text('id').primaryKey().$defaultFn(genId),
  userId: text('user_id').notNull().references(() => users.id),
  total: integer('total').notNull().default(0),
  paymentMethod: text('payment_method').notNull().default('zaincash'),
  status: text('status', { enum: orderStatuses }).notNull().default('pending'),
  createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  deliveryName: text('delivery_name'),
  deliveryPhone: text('delivery_phone'),
  deliveryAddress: text('delivery_address'),
});

// ---------------------------------------------------------------- 20. order_items
export const orderItems = sqliteTable('order_items', {
  id: text('id').primaryKey().$defaultFn(genId),
  orderId: text('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  productId: text('product_id').notNull().references(() => products.id),
  qty: integer('qty').notNull().default(1),
  price: integer('price').notNull(),
});

// ---------------------------------------------------------------- 21. ban_records
export const banRecords = sqliteTable('ban_records', {
  id: text('id').primaryKey().$defaultFn(genId),
  userId: text('user_id').notNull().references(() => users.id),
  reason: text('reason').notNull(),
  status: text('status', { enum: banStatuses }).notNull().default('active'),
  createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  appealMessage: text('appeal_message'),
  appealedAt: text('appealed_at'),
});

// ---------------------------------------------------------------- 22. activity_logs
export const activityLogs = sqliteTable('activity_logs', {
  id: text('id').primaryKey().$defaultFn(genId),
  userId: text('user_id').references(() => users.id),
  action: text('action').notNull(),
  ipAddress: text('ip_address').notNull().default(''),
  createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

// ---------------------------------------------------------------- 23. media_files
export const mediaFiles = sqliteTable('media_files', {
  id: text('id').primaryKey().$defaultFn(genId),
  filename: text('filename').notNull(),
  url: text('url').notNull(),
  contentType: text('content_type').notNull().default(''),
  sizeBytes: integer('size_bytes').notNull().default(0),
  uploadedBy: text('uploaded_by').references(() => users.id),
  createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

// ---------------------------------------------------------------- 24. exam_attempts
export const examAttempts = sqliteTable('exam_attempts', {
  id: text('id').primaryKey().$defaultFn(genId),
  examId: text('exam_id').notNull().references(() => exams.id),
  userId: text('user_id').notNull().references(() => users.id),
  startedAt: text('started_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  finishedAt: text('finished_at'),
  score: integer('score').notNull().default(0),
  total: integer('total').notNull().default(0),
});

// ---------------------------------------------------------------- 25. exam_attempt_questions
export const examAttemptQuestions = sqliteTable('exam_attempt_questions', {
  id: text('id').primaryKey().$defaultFn(genId),
  attemptId: text('attempt_id').notNull().references(() => examAttempts.id, { onDelete: 'cascade' }),
  questionId: text('question_id').notNull().references(() => questions.id),
  orderIndex: integer('order_index').notNull().default(0),
  choiceId: text('choice_id').references(() => choices.id),
  isCorrect: integer('is_correct', { mode: 'boolean' }),
  answeredAt: text('answered_at'),
});

// ---------------------------------------------------------------- 26. user_skills
export const userSkills = sqliteTable('user_skills', {
  id: text('id').primaryKey().$defaultFn(genId),
  userId: text('user_id').notNull().references(() => users.id),
  text: text('text').notNull(),
  createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

// ---------------------------------------------------------------- 27. saved_questions
export const savedQuestions = sqliteTable('saved_questions', {
  id: text('id').primaryKey().$defaultFn(genId),
  userId: text('user_id').notNull().references(() => users.id),
  questionId: text('question_id').notNull().references(() => questions.id),
  createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

// ---------------------------------------------------------------- 28. notifications
export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey().$defaultFn(genId),
  userId: text('user_id').references(() => users.id),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  createdBy: text('created_by').references(() => users.id),
  contentType: text('content_type'),
  contentId: text('content_id'),
});

// ---------------------------------------------------------------- 29. notification_reads
export const notificationReads = sqliteTable('notification_reads', {
  id: text('id').primaryKey().$defaultFn(genId),
  notificationId: text('notification_id').notNull().references(() => notifications.id),
  userId: text('user_id').notNull().references(() => users.id),
  readAt: text('read_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

// ---------------------------------------------------------------- 30. clinical_pearls
export const clinicalPearls = sqliteTable('clinical_pearls', {
  id: text('id').primaryKey().$defaultFn(genId),
  tag: text('tag').notNull().default(''),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  createdBy: text('created_by').references(() => users.id),
});

// ---------------------------------------------------------------- Drizzle Relations
export const usersRelations = relations(users, ({ one, many }) => ({
  university: one(universities, { fields: [users.universityId], references: [universities.id] }),
  stage: one(stages, { fields: [users.stageId], references: [stages.id] }),
  section: one(sections, { fields: [users.sectionId], references: [sections.id] }),
  sessions: many(userSessions),
  answers: many(studentAnswers),
  skills: many(userSkills),
  savedQuestions: many(savedQuestions),
  orders: many(orders),
  examAttempts: many(examAttempts),
}));

export const userSessionsRelations = relations(userSessions, ({ one }) => ({
  user: one(users, { fields: [userSessions.userId], references: [users.id] }),
}));

export const sectionsRelations = relations(sections, ({ many }) => ({
  universities: many(universities),
}));

export const universitiesRelations = relations(universities, ({ one, many }) => ({
  section: one(sections, { fields: [universities.sectionId], references: [sections.id] }),
  stages: many(stages),
}));

export const stagesRelations = relations(stages, ({ one, many }) => ({
  university: one(universities, { fields: [stages.universityId], references: [universities.id] }),
  subjects: many(subjects),
}));

export const subjectsRelations = relations(subjects, ({ one, many }) => ({
  stage: one(stages, { fields: [subjects.stageId], references: [stages.id] }),
  questions: many(questions),
  courses: many(courses),
  exams: many(exams),
}));

export const questionsRelations = relations(questions, ({ one, many }) => ({
  subject: one(subjects, { fields: [questions.subjectId], references: [subjects.id] }),
  choices: many(choices),
  answers: many(studentAnswers),
}));

export const choicesRelations = relations(choices, ({ one }) => ({
  question: one(questions, { fields: [choices.questionId], references: [questions.id] }),
}));

export const coursesRelations = relations(courses, ({ one, many }) => ({
  subject: one(subjects, { fields: [courses.subjectId], references: [subjects.id] }),
  professor: one(professorProfiles, { fields: [courses.professorId], references: [professorProfiles.id] }),
  lectures: many(lectures),
}));

export const lecturesRelations = relations(lectures, ({ one }) => ({
  course: one(courses, { fields: [lectures.courseId], references: [courses.id] }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  user: one(users, { fields: [orders.userId], references: [users.id] }),
  items: many(orderItems),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  product: one(products, { fields: [orderItems.productId], references: [products.id] }),
}));

export const examAttemptsRelations = relations(examAttempts, ({ one, many }) => ({
  exam: one(exams, { fields: [examAttempts.examId], references: [exams.id] }),
  user: one(users, { fields: [examAttempts.userId], references: [users.id] }),
  items: many(examAttemptQuestions),
}));

export const examAttemptQuestionsRelations = relations(examAttemptQuestions, ({ one }) => ({
  attempt: one(examAttempts, { fields: [examAttemptQuestions.attemptId], references: [examAttempts.id] }),
  question: one(questions, { fields: [examAttemptQuestions.questionId], references: [questions.id] }),
  choice: one(choices, { fields: [examAttemptQuestions.choiceId], references: [choices.id] }),
}));
```

---

## 5. Verification Method

To independently verify the observations, schema mappings, and conclusion presented in this report:

1. **Verify Table and Model Count**:
   Inspect `app/models.py` and run a grep query for `__tablename__`:
   ```bash
   python -c "from app import models; from app.database import Base; print(len(Base.metadata.tables), sorted(Base.metadata.tables.keys()))"
   ```
   Expected output: 30 tables: `['activation_codes', 'activity_logs', 'ban_records', 'booklets', 'choices', 'clinical_pearls', 'courses', 'exam_attempt_questions', 'exam_attempts', 'exams', 'lecture_progress', 'lectures', 'media_files', 'notification_reads', 'notifications', 'order_items', 'orders', 'products', 'professor_profiles', 'questions', 'recent_views', 'saved_questions', 'sections', 'stages', 'student_answers', 'subjects', 'universities', 'user_sessions', 'user_skills', 'users']`.

2. **Verify Alembic Absence**:
   Check for migration directories or configuration files:
   - Verify `find_by_name` for `alembic*` returns 0 results.
   - Verify `requirements.txt` contains only runtime web and driver libraries (`fastapi`, `sqlalchemy`, `psycopg`, `pydantic-settings`, etc.).

3. **Verify SQLite Dialect Support in Original Backend**:
   - Inspect `app/config.py:10` (`database_url: str = "sqlite:///./nabd.db"`).
   - Inspect `app/database.py:23-35` confirming `connect_args={"check_same_thread": False}` and sqlite detection.
   - Run `python seed.py` with default `.env` to observe that the entire SQLite schema compiles and populates without errors.

4. **Verify D1 / Drizzle Migration Compilation**:
   Once Drizzle Kit is installed in the new TypeScript workspace:
   ```bash
   npx drizzle-kit generate
   npx wrangler d1 execute <DATABASE_NAME> --local --file=./drizzle/0000_initial.sql
   ```
   All 30 tables will be instantiated in the local SQLite engine without dialect incompatibilities.
