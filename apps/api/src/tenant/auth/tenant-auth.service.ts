import { randomUUID } from 'node:crypto';
import {
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { AUTH_CONFIGURATION } from '../../common/auth/auth-configuration.js';
import type { AuthConfiguration } from '../../common/auth/auth-configuration.js';
import type { AuthTokenPair } from '../../common/auth/auth-response.js';
import { JwtTokenService } from '../../common/auth/jwt-token.service.js';
import type { TenantJwtClaims } from '../../common/auth/jwt-token.service.js';
import type { LoginRateLimiter } from '../../common/auth/login-rate-limiter.js';
import { PostgresLoginRateLimiter } from '../../common/auth/postgres-login-rate-limiter.js';
import { PasswordPolicy } from '../../common/auth/password-policy.js';
import { hashRefreshToken, refreshTokenHashMatches } from '../../common/auth/refresh-token-hash.js';
import { TenantConnectionManager } from '../tenant-connection/tenant-connection.manager.js';
import { TenantResolverService } from '../tenant-resolver/tenant-resolver.service.js';
import { TenantSessionRepository } from './tenant-session.repository.js';
import type { LockedTenantSession } from './tenant-session.repository.js';

interface TenantUserRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  status: 'ACTIVE' | 'BLOCKED';
}

interface TenantIdentity {
  userId: string;
  sessionId: string;
  companyId: string;
}

export interface TenantLoginResponse extends AuthTokenPair {
  user: {
    id: string;
    email: string;
    full_name: string;
  };
  company: {
    id: string;
    slug: string;
  };
}

type RefreshDecision = 'ROTATED' | 'INVALID' | 'REUSED';

function invalidCredentials(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'INVALID_CREDENTIALS',
    message: "Email yoki parol noto'g'ri",
    details: {},
  });
}

function invalidRefreshToken(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'INVALID_REFRESH_TOKEN',
    message: 'Yangilash tokeni yaroqsiz yoki muddati tugagan',
    details: {},
  });
}

function authenticationUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'AUTHENTICATION_UNAVAILABLE',
    message: 'Kirish xizmati vaqtincha ishlamayapti',
    details: {},
  });
}

@Injectable()
export class TenantAuthService {
  constructor(
    private readonly tenantResolver: TenantResolverService,
    private readonly tenantConnectionManager: TenantConnectionManager,
    private readonly sessionRepository: TenantSessionRepository,
    private readonly passwordPolicy: PasswordPolicy,
    private readonly jwtTokens: JwtTokenService,
    @Inject(PostgresLoginRateLimiter) private readonly loginRateLimiter: LoginRateLimiter,
    @Inject(AUTH_CONFIGURATION) private readonly authConfiguration: AuthConfiguration,
  ) {}

  async login(
    hostname: string,
    input: { email: string; password: string },
    ipAddress: string,
  ): Promise<TenantLoginResponse> {
    const company = await this.tenantResolver.resolveForLogin({ hostname });
    const dataSource = await this.getTenantDataSource(company.companyId);
    const email = input.email.trim().toLocaleLowerCase('en-US');
    await this.loginRateLimiter.consume(dataSource, {
      scope: 'tenant',
      companyId: company.companyId,
      identifier: email,
      ipAddress,
    });

    let user: TenantUserRow | undefined;
    try {
      const rows: TenantUserRow[] = await dataSource.query(
        `SELECT "id", "email", "full_name", "password_hash", "status"
         FROM "users" WHERE lower("email") = $1`,
        [email],
      );
      user = rows[0];
    } catch {
      throw authenticationUnavailable();
    }

    const passwordMatches = await this.passwordPolicy.verify(
      user?.password_hash ?? null,
      input.password,
    );
    if (!user || user.status !== 'ACTIVE' || !passwordMatches) {
      throw invalidCredentials();
    }

    const identity: TenantIdentity = {
      userId: user.id,
      sessionId: randomUUID(),
      companyId: company.companyId,
    };
    const tokens = await this.issueTokens(identity);
    try {
      await this.sessionRepository.create(dataSource, {
        id: identity.sessionId,
        userId: identity.userId,
        refreshTokenHash: hashRefreshToken(tokens.refresh_token),
        expiresAt: tokens.refreshExpiresAt,
      });
    } catch {
      throw authenticationUnavailable();
    }

    return {
      access_token: tokens.accessToken,
      refresh_token: tokens.refresh_token,
      token_type: 'Bearer',
      expires_in: this.authConfiguration.accessTokenTtlSeconds,
      user: { id: user.id, email: user.email, full_name: user.full_name },
      company: { id: company.companyId, slug: company.slug },
    };
  }

  async refresh(hostname: string, refreshToken: string): Promise<AuthTokenPair> {
    const domain = this.authConfiguration.tenant;
    let claims: TenantJwtClaims;
    try {
      const verified = await this.jwtTokens.verify(refreshToken, {
        secret: domain.refreshSecret,
        issuer: domain.issuer,
        audience: domain.audience,
        scope: 'tenant',
        tokenType: 'refresh',
      });
      if (verified.scope !== 'tenant' || verified.token_type !== 'refresh') {
        throw new Error('Tenant refresh-token context is invalid');
      }
      claims = verified;
    } catch {
      throw invalidRefreshToken();
    }

    const company = await this.tenantResolver.resolve({
      hostname,
      authenticatedCompanyId: claims.company_id,
    });
    const dataSource = await this.getTenantDataSource(company.companyId);
    const newTokens = await this.issueTokens({
      userId: claims.sub,
      sessionId: claims.session_id,
      companyId: claims.company_id,
    });
    let decision: RefreshDecision;
    try {
      decision = await dataSource.transaction(async (manager) => {
        const session: LockedTenantSession | null = await this.sessionRepository.findForUpdate(
          manager,
          claims.session_id,
        );
        if (!session || session.user_id !== claims.sub) {
          return 'INVALID';
        }
        if (session.revoked_at !== null || session.expires_at.getTime() <= Date.now()) {
          return 'INVALID';
        }
        if (session.user_status !== 'ACTIVE') {
          await this.sessionRepository.revoke(manager, session.id);
          return 'INVALID';
        }
        if (!refreshTokenHashMatches(session.refresh_token_hash, hashRefreshToken(refreshToken))) {
          await this.sessionRepository.revoke(manager, session.id);
          return 'REUSED';
        }

        await this.sessionRepository.rotate(
          manager,
          session.id,
          hashRefreshToken(newTokens.refresh_token),
          newTokens.refreshExpiresAt,
        );
        return 'ROTATED';
      });
    } catch {
      throw authenticationUnavailable();
    }

    if (decision !== 'ROTATED') {
      throw invalidRefreshToken();
    }
    return {
      access_token: newTokens.accessToken,
      refresh_token: newTokens.refresh_token,
      token_type: 'Bearer',
      expires_in: this.authConfiguration.accessTokenTtlSeconds,
    };
  }

  private async issueTokens(identity: TenantIdentity): Promise<{
    accessToken: string;
    refresh_token: string;
    refreshExpiresAt: Date;
  }> {
    const domain = this.authConfiguration.tenant;
    const claims = {
      sub: identity.userId,
      session_id: identity.sessionId,
      company_id: identity.companyId,
      scope: 'tenant' as const,
    };
    const accessToken = await this.jwtTokens.sign({
      ...claims,
      jti: randomUUID(),
      token_type: 'access',
    }, {
      secret: domain.accessSecret,
      issuer: domain.issuer,
      audience: domain.audience,
      expiresInSeconds: this.authConfiguration.accessTokenTtlSeconds,
    });
    const refresh_token = await this.jwtTokens.sign({
      ...claims,
      jti: randomUUID(),
      token_type: 'refresh',
    }, {
      secret: domain.refreshSecret,
      issuer: domain.issuer,
      audience: domain.audience,
      expiresInSeconds: this.authConfiguration.refreshTokenTtlSeconds,
    });
    return {
      accessToken,
      refresh_token,
      refreshExpiresAt: new Date(Date.now() + this.authConfiguration.refreshTokenTtlSeconds * 1_000),
    };
  }

  private async getTenantDataSource(companyId: string): Promise<DataSource> {
    try {
      return await this.tenantConnectionManager.getDataSource(companyId);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw authenticationUnavailable();
    }
  }
}
