import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface GoogleIdentityUser {
  email: string;
  emailVerified: true;
  subject: string;
  name?: string;
  picture?: string;
}

export class GoogleIdentityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 401,
  ) {
    super(message);
  }
}

const googleIdentityJwks = createRemoteJWKSet(
  new URL('https://www.googleapis.com/oauth2/v3/certs'),
);

const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/**
 * Verifies a Google Identity Services credential against Google's JWKS. A
 * tokeninfo response is not used as an authentication boundary here.
 */
export async function verifyGoogleIdentityCredential(
  credential: string,
  audience: string,
): Promise<GoogleIdentityUser> {
  if (!credential || typeof credential !== 'string') {
    throw new GoogleIdentityError('MISSING_GOOGLE_CREDENTIAL', 'رمز Google ID مفقود أو غير صالح', 400);
  }

  try {
    const { payload } = await jwtVerify(credential, googleIdentityJwks, {
      algorithms: ['RS256'],
      issuer: GOOGLE_ISSUERS,
      audience,
      maxTokenAge: '1h',
      clockTolerance: 30,
    });

    // jwtVerify validates these when present; require them so a signed but
    // timeless credential cannot establish a KIUR session.
    if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
      throw new GoogleIdentityError('GOOGLE_TOKEN_TIME_CLAIMS_REQUIRED', 'رمز Google لا يحتوي مدة صلاحية صالحة');
    }

    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const subject = typeof payload.sub === 'string' ? payload.sub : '';
    if (!email || !email.includes('@') || !subject) {
      throw new GoogleIdentityError('GOOGLE_TOKEN_IDENTITY_REQUIRED', 'رمز Google لا يحتوي هوية صالحة');
    }
    if (payload.email_verified !== true && payload.email_verified !== 'true') {
      throw new GoogleIdentityError('GOOGLE_EMAIL_UNVERIFIED', 'بريد Google غير موثق', 403);
    }

    return {
      email,
      emailVerified: true,
      subject,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      picture: typeof payload.picture === 'string' ? payload.picture : undefined,
    };
  } catch (error) {
    if (error instanceof GoogleIdentityError) throw error;
    // Never disclose JWKS/upstream errors from an authentication boundary.
    throw new GoogleIdentityError('INVALID_GOOGLE_CREDENTIAL', 'رمز مصادقة Google غير صالح أو مرفوض من Google');
  }
}
