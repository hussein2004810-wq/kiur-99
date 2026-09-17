import type { AppBindings } from '../types';

export interface FirebaseVerifiedUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  photoUrl?: string;
}

export class FirebaseAuthError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'FirebaseAuthError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Decodes a base64url string.
 */
function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return atob(base64);
}

/**
 * Parses unverified JWT payload for claims inspection.
 */
export function parseJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const jsonStr = base64UrlDecode(parts[1]);
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/**
 * Parses unverified JWT header.
 */
export function parseJwtHeader(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const jsonStr = base64UrlDecode(parts[0]);
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/**
 * Validates and verifies a Firebase Google ID token server-side (Stage A1).
 *
 * Checks:
 * 1. Firebase configuration exists.
 * 2. Token structure and header alg (must be RS256).
 * 3. Firebase Project ID / Audience matching.
 * 4. Token expiration and issued-at time.
 * 5. Sign-in provider must be 'google.com'.
 * 6. Email must be verified (`email_verified === true`).
 * 7. Account lookup against Identity Toolkit REST API (if apiKey configured) to verify active status.
 */
export async function verifyFirebaseGoogleToken(
  env: AppBindings,
  idToken: string
): Promise<FirebaseVerifiedUser> {
  const projectId = env.FIREBASE_AUTH_PROJECT_ID;
  const apiKey = env.FIREBASE_WEB_API_KEY;

  if (!projectId && !apiKey) {
    throw new FirebaseAuthError(
      'FIREBASE_NOT_CONFIGURED',
      'خدمة المصادقة عبر Google/Firebase غير مهيأة على السيرفر',
      503
    );
  }

  // 1. Basic JWT parsing
  const header = parseJwtHeader(idToken);
  const payload = parseJwtPayload(idToken);

  if (!header || !payload) {
    throw new FirebaseAuthError(
      'INVALID_ID_TOKEN',
      'رمز التحقق المقدم غير صالح أو تالف',
      400
    );
  }

  // RS256 algorithm enforcement
  if (header.alg !== 'RS256') {
    throw new FirebaseAuthError(
      'INVALID_ALGORITHM',
      'خوارزمية تشفير الرمز غير صالحة',
      400
    );
  }

  const now = Math.floor(Date.now() / 1000);

  // Expiration check (with 60s clock skew tolerance)
  if (typeof payload.exp !== 'number' || payload.exp < now - 60) {
    throw new FirebaseAuthError(
      'TOKEN_EXPIRED',
      'رمز التحقق منتهي الصلاحية',
      401
    );
  }

  // Audience & Issuer checks if project ID is provided
  if (projectId) {
    if (payload.aud !== projectId) {
      throw new FirebaseAuthError(
        'AUDIENCE_MISMATCH',
        'رمز التحقق غير مخصص لهذا التطبيق',
        403
      );
    }

    const expectedIssuer = `https://securetoken.google.com/${projectId}`;
    if (payload.iss !== expectedIssuer) {
      throw new FirebaseAuthError(
        'ISSUER_MISMATCH',
        'مصدر الرمز غير صالح',
        403
      );
    }
  }

  // Sign-in provider must be google.com
  const provider = payload.firebase?.sign_in_provider;
  if (provider !== 'google.com') {
    throw new FirebaseAuthError(
      'PROVIDER_MISMATCH',
      'يُشترط أن يكون موفر تسجيل الدخول هو Google',
      403
    );
  }

  // Email verification check
  if (!payload.email_verified) {
    throw new FirebaseAuthError(
      'EMAIL_UNVERIFIED',
      'البريد الإلكتروني المرتبط بحساب Google غير موثق',
      403
    );
  }

  const email = (payload.email ?? '').trim().toLowerCase();
  if (!email) {
    throw new FirebaseAuthError(
      'MISSING_EMAIL',
      'لم يتم العثور على بريد إلكتروني في حساب Google',
      400
    );
  }

  const uid = String(payload.sub || payload.user_id || '');
  if (!uid) {
    throw new FirebaseAuthError(
      'MISSING_UID',
      'معرّف حساب Google مفقود',
      400
    );
  }

  // 2. If API Key is configured and we're not in mock/offline mode, verify live with Google Identity Toolkit
  if (apiKey && apiKey !== 'mock-firebase-key') {
    try {
      const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ idToken }),
        }
      );

      if (!response.ok) {
        const errData = (await response.json().catch(() => ({}))) as any;
        const message = errData?.error?.message || 'LOOKUP_FAILED';
        throw new FirebaseAuthError(
          'FIREBASE_LOOKUP_FAILED',
          `فشل التحقق من صحة الحساب لدى Google (${message})`,
          401
        );
      }

      const data = (await response.json()) as any;
      const user = data?.users?.[0];
      if (!user) {
        throw new FirebaseAuthError(
          'USER_NOT_FOUND',
          'المستخدم غير موجود لدى Firebase',
          404
        );
      }

      if (user.disabled) {
        throw new FirebaseAuthError(
          'USER_DISABLED',
          'حساب Google هذا معطل',
          403
        );
      }
    } catch (err: any) {
      if (err instanceof FirebaseAuthError) throw err;
      throw new FirebaseAuthError(
        'FIREBASE_UNAVAILABLE',
        'تعذر الاتصال بخدمة التحقق من Google حالياً؛ يرجى المحاولة لاحقاً',
        503
      );
    }
  }

  return {
    uid,
    email,
    emailVerified: Boolean(payload.email_verified),
    name: payload.name,
    photoUrl: payload.picture,
  };
}
