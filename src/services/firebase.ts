import { createRemoteJWKSet, jwtVerify } from 'jose';
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

const FIREBASE_JWKS_URL = new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
);
const firebaseJwks = createRemoteJWKSet(FIREBASE_JWKS_URL);

/**
 * Validates and cryptographically verifies a Firebase Google ID token server-side.
 * Enforces RS256 signature verification against Google's public JWKS.
 * Parse-only fallback is completely prohibited.
 */
export async function verifyFirebaseGoogleToken(
  env: AppBindings,
  idToken: string
): Promise<FirebaseVerifiedUser> {
  const projectId = env.FIREBASE_AUTH_PROJECT_ID;

  if (!projectId || projectId.trim() === '') {
    throw new FirebaseAuthError(
      'FIREBASE_NOT_CONFIGURED',
      'خدمة المصادقة عبر Google/Firebase غير مهيأة على السيرفر',
      503
    );
  }

  if (!idToken || typeof idToken !== 'string') {
    throw new FirebaseAuthError(
      'INVALID_ID_TOKEN',
      'رمز التحقق المقدم مفقود أو غير صالح',
      400
    );
  }

  let payload: any;
  try {
    const verified = await jwtVerify(idToken, firebaseJwks, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      algorithms: ['RS256'],
    });
    payload = verified.payload;
  } catch (err: any) {
    throw new FirebaseAuthError(
      'INVALID_ID_TOKEN_SIGNATURE',
      `فشل التحقق التشفيري من رمز Firebase: ${err.message || 'التوقيع غير صالح'}`,
      401
    );
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

  return {
    uid,
    email,
    emailVerified: true,
    name: payload.name,
    photoUrl: payload.picture,
  };
}

