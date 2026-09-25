import { Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

export type AuthScope = 'platform' | 'tenant';
export type AuthTokenType = 'access' | 'refresh';

export interface PlatformJwtClaims extends JWTPayload {
  sub: string;
  session_id: string;
  jti: string;
  scope: 'platform';
  token_type: AuthTokenType;
}

export interface TenantJwtClaims extends JWTPayload {
  sub: string;
  session_id: string;
  jti: string;
  scope: 'tenant';
  token_type: AuthTokenType;
  company_id: string;
}

export type AuthJwtClaims = PlatformJwtClaims | TenantJwtClaims;

export interface JwtSigningOptions {
  secret: string;
  issuer: string;
  audience: string;
  expiresInSeconds: number;
  issuedAt?: Date;
}

export interface JwtVerificationOptions {
  secret: string;
  issuer: string;
  audience: string;
  scope: AuthScope;
  tokenType: AuthTokenType;
  currentDate?: Date;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertUuid(value: unknown, claimName: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`JWT ${claimName} claim is invalid`);
  }
}

function assertAuthClaims(value: unknown): asserts value is AuthJwtClaims {
  if (!isRecord(value)) {
    throw new Error('JWT claims are invalid');
  }
  assertUuid(value.sub, 'sub');
  assertUuid(value.session_id, 'session_id');
  assertUuid(value.jti, 'jti');
  if (value.scope === 'platform' && Object.hasOwn(value, 'company_id')) {
    throw new Error('Platform JWT must not include a company_id claim');
  }
  if (value.scope === 'tenant') {
    assertUuid(value.company_id, 'company_id');
  }
  if (value.scope !== 'platform' && value.scope !== 'tenant') {
    throw new Error('JWT scope claim is invalid');
  }
  if (value.token_type !== 'access' && value.token_type !== 'refresh') {
    throw new Error('JWT token_type claim is invalid');
  }
}

@Injectable()
export class JwtTokenService {
  async sign(claims: AuthJwtClaims, options: JwtSigningOptions): Promise<string> {
    assertAuthClaims(claims);
    if (!Number.isSafeInteger(options.expiresInSeconds) || options.expiresInSeconds < 1) {
      throw new Error('JWT expiration must be a positive integer');
    }

    const issuedAt = options.issuedAt ?? new Date();
    const issuedAtSeconds = Math.floor(issuedAt.getTime() / 1_000);
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(options.issuer)
      .setAudience(options.audience)
      .setIssuedAt(issuedAtSeconds)
      .setExpirationTime(issuedAtSeconds + options.expiresInSeconds)
      .sign(new TextEncoder().encode(options.secret));
  }

  async verify(token: string, options: JwtVerificationOptions): Promise<AuthJwtClaims> {
    const verificationOptions = {
      algorithms: ['HS256'],
      issuer: options.issuer,
      audience: options.audience,
      ...(options.currentDate ? { currentDate: options.currentDate } : {}),
    };
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(options.secret),
      verificationOptions,
    );

    if (!isRecord(payload)) {
      throw new Error('JWT security context is invalid');
    }
    assertAuthClaims(payload);
    if (payload.scope !== options.scope || payload.token_type !== options.tokenType) {
      throw new Error('JWT security context is invalid');
    }
    return payload;
  }
}
