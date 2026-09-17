# Task Assignment: M2 Explorer 1 - Cryptography, JWT & TOTP Architecture

## Original Request Reference
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\ORIGINAL_REQUEST.md`
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\PROJECT.md`
Read: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_survey_1\handoff.md`

## Your Identity & Workspace
- Type: teamwork_preview_explorer
- Working Directory: `c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m2_1`
- Parent: Orchestrator (`fdf0f062-12fc-46d6-8dd0-3c6786653821`)

## Objective
Formulate the exact cryptographic and token services for Milestone 2:
1. **PBKDF2-HMAC-SHA256 Password Hashing (`src/services/crypto.ts`)**:
   - Python passlib format: `pbkdf2_sha256$200000$<salt_b64>$<hash_b64>`
   - Implement hash creation and password verification using native Web Crypto API (`crypto.subtle`).
   - Must be 100% compatible with existing hashes from `seed.py` and Python backend.
2. **JWT Tokens (`src/services/jwt.ts`)**:
   - HS256 JWT access tokens using `jose`.
   - Claims: `sub` (user id), `email`, `role`, `sid` (session id), `exp`.
   - Expiration calculation based on `c.env.JWT_EXPIRES_MINUTES` (default 20,160 min = 14 days).
   - Short-lived 2FA pending tokens (`type: "2fa_pending"`, 5 min expiry).
   - Password reset token hashing (SHA-256 via `crypto.subtle.digest`).
3. **TOTP Two-Factor Authentication (`src/services/totp.ts`)**:
   - RFC 6238 TOTP using `otpauth` library.
   - Secret generation (Base32), TOTP verification with window skew (+/- 1 step), QR code URI generation (`otpauth://totp/...`).

Write your detailed blueprint to:
`c:\Users\PHANTOM X\OneDrive\Desktop\Kiur نسخة موسى\.agents\teamwork_preview_explorer_m2_1\handoff.md`
Update your heartbeat in `progress.md`. Notify orchestrator when complete.
