# Firebase Security Applicability Assessment (SEC-FB-001, SEC-FB-002)

## Architectural Status
**KIUR-99** is deployed exclusively on **Cloudflare Workers** with:
- **Compute:** Cloudflare Workers (TypeScript / Hono)
- **Database:** Cloudflare D1 Serverless SQL (`kiur-99-db`)
- **Object Storage:** Cloudflare R2 (`kiur-99-media`)
- **Authentication:** In-house JWT + WebCrypto PBKDF2/SHA-256 + Cloudflare D1 Sessions

**Firebase is NOT used** anywhere in this deployment stack. Per **Stage 21** instructions:
> *"Do not add Firebase merely for the sake of adding it."*

Consequently:
1. `SEC-FB-001` (Firestore/Storage Rules deny by default): **NOT APPLICABLE** (No Firestore or Firebase Storage provisioned).
2. `SEC-FB-002` (Firebase App Check enforcement): **NOT APPLICABLE** (Replaced by Cloudflare Edge WAF, Turnstile, and Worker origin validation).

If Firebase services (such as Firebase Cloud Messaging / FCM for push notifications) are introduced in future releases, this document and implementation must be updated to enforce strict service-account least privilege, server-side Admin SDK verification, and App Check tokens.

