import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { JwtTokenService } from './jwt-token.service.js';

const issuedAt = new Date('2026-09-26T00:00:00.000Z');
const platformSigning = {
  secret: 'platform-access-secret-that-is-long-enough-001',
  issuer: 'textile-erp-platform',
  audience: 'textile-erp-platform-api',
  expiresInSeconds: 60,
  issuedAt,
};
const platformVerification = {
  secret: platformSigning.secret,
  issuer: platformSigning.issuer,
  audience: platformSigning.audience,
  scope: 'platform' as const,
  tokenType: 'access' as const,
  currentDate: issuedAt,
};

describe('JwtTokenService', () => {
  const tokens = new JwtTokenService();

  it('signs and strictly verifies a platform access token without company identity', async () => {
    const token = await tokens.sign({
      sub: '11111111-1111-4111-8111-111111111111',
      session_id: '22222222-2222-4222-8222-222222222222',
      jti: '44444444-4444-4444-8444-444444444444',
      scope: 'platform',
      token_type: 'access',
    }, platformSigning);

    await expect(tokens.verify(token, platformVerification)).resolves.toMatchObject({
      sub: '11111111-1111-4111-8111-111111111111',
      session_id: '22222222-2222-4222-8222-222222222222',
      scope: 'platform',
      token_type: 'access',
    });
    expect(await tokens.verify(token, platformVerification)).not.toHaveProperty('company_id');
  });

  it('signs and verifies tenant claims only with the tenant context', async () => {
    const token = await tokens.sign({
      sub: '11111111-1111-4111-8111-111111111111',
      session_id: '22222222-2222-4222-8222-222222222222',
      jti: '44444444-4444-4444-8444-444444444444',
      scope: 'tenant',
      token_type: 'access',
      company_id: '33333333-3333-4333-8333-333333333333',
    }, {
      ...platformSigning,
      secret: 'tenant-access-secret-that-is-long-enough-0003',
      issuer: 'textile-erp-tenant',
      audience: 'textile-erp-tenant-api',
    });

    await expect(tokens.verify(token, {
      secret: 'tenant-access-secret-that-is-long-enough-0003',
      issuer: 'textile-erp-tenant',
      audience: 'textile-erp-tenant-api',
      scope: 'tenant',
      tokenType: 'access',
      currentDate: issuedAt,
    })).resolves.toMatchObject({
      scope: 'tenant',
      company_id: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('rejects wrong issuer, audience, scope, token type, and signing secret', async () => {
    const token = await tokens.sign({
      sub: '11111111-1111-4111-8111-111111111111',
      session_id: '22222222-2222-4222-8222-222222222222',
      jti: '44444444-4444-4444-8444-444444444444',
      scope: 'platform',
      token_type: 'access',
    }, platformSigning);

    await expect(tokens.verify(token, { ...platformVerification, issuer: 'wrong-issuer' }))
      .rejects.toThrow();
    await expect(tokens.verify(token, { ...platformVerification, audience: 'wrong-audience' }))
      .rejects.toThrow();
    await expect(tokens.verify(token, { ...platformVerification, scope: 'tenant' }))
      .rejects.toThrow();
    await expect(tokens.verify(token, { ...platformVerification, tokenType: 'refresh' }))
      .rejects.toThrow();
    await expect(tokens.verify(token, {
      ...platformVerification,
      secret: 'tenant-access-secret-that-is-long-enough-0003',
    })).rejects.toThrow();
  });

  it('rejects expired tokens and malformed or cross-domain claims', async () => {
    const expired = await tokens.sign({
      sub: '11111111-1111-4111-8111-111111111111',
      session_id: '22222222-2222-4222-8222-222222222222',
      jti: '44444444-4444-4444-8444-444444444444',
      scope: 'platform',
      token_type: 'access',
    }, { ...platformSigning, expiresInSeconds: 1 });

    await expect(tokens.verify(expired, {
      ...platformVerification,
      currentDate: new Date(issuedAt.getTime() + 2_000),
    })).rejects.toThrow();

    const platformTokenWithCompanyId = await new SignJWT({
      sub: '11111111-1111-4111-8111-111111111111',
      session_id: '22222222-2222-4222-8222-222222222222',
      jti: '55555555-5555-4555-8555-555555555555',
      scope: 'platform',
      token_type: 'access',
      company_id: '33333333-3333-4333-8333-333333333333',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(platformSigning.issuer)
      .setAudience(platformSigning.audience)
      .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
      .setExpirationTime(Math.floor(issuedAt.getTime() / 1000) + 60)
      .sign(new TextEncoder().encode(platformSigning.secret));

    await expect(tokens.verify(platformTokenWithCompanyId, platformVerification)).rejects.toThrow();
  });
});
