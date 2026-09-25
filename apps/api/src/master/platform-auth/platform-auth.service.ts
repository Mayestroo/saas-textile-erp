import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { AUTH_CONFIGURATION } from '../../common/auth/auth-configuration.js';
import type { AuthConfiguration } from '../../common/auth/auth-configuration.js';
import type { AuthTokenPair } from '../../common/auth/auth-response.js';
import { JwtTokenService } from '../../common/auth/jwt-token.service.js';
import type { PlatformJwtClaims } from '../../common/auth/jwt-token.service.js';
import { PasswordPolicy } from '../../common/auth/password-policy.js';
import type { LoginRateLimiter } from '../../common/auth/login-rate-limiter.js';
import { PostgresLoginRateLimiter } from '../../common/auth/postgres-login-rate-limiter.js';
import { hashRefreshToken, refreshTokenHashMatches } from '../../common/auth/refresh-token-hash.js';
import { MASTER_DATA_SOURCE_NAME } from '../../database/master/master-database.config.js';
import { PlatformSessionRepository } from './platform-session.repository.js';
import type { LockedPlatformSession } from './platform-session.repository.js';

interface PlatformUserRow {
  id: string;
  email: string;
  password_hash: string;
  status: 'ACTIVE' | 'BLOCKED';
}

interface PlatformIdentity {
  id: string;
  sessionId: string;
}

export interface PlatformLoginResponse extends AuthTokenPair {
  user: {
    id: string;
    email: string;
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
export class PlatformAuthService {
  constructor(
    @InjectDataSource(MASTER_DATA_SOURCE_NAME) private readonly masterDataSource: DataSource,
    private readonly sessionRepository: PlatformSessionRepository,
    private readonly passwordPolicy: PasswordPolicy,
    private readonly jwtTokens: JwtTokenService,
    @Inject(PostgresLoginRateLimiter)
    private readonly loginRateLimiter: LoginRateLimiter,
    @Inject(AUTH_CONFIGURATION) private readonly authConfiguration: AuthConfiguration,
  ) {}

  async login(
    input: { email: string; password: string },
    ipAddress: string,
  ): Promise<PlatformLoginResponse> {
    const email = input.email.trim().toLocaleLowerCase('en-US');
    await this.loginRateLimiter.consume(this.masterDataSource, {
      scope: 'platform',
      identifier: email,
      ipAddress,
    });

    let user: PlatformUserRow | undefined;
    try {
      const rows: PlatformUserRow[] = await this.masterDataSource.query(
        `SELECT "id", "email", "password_hash", "status"
         FROM "platform_users" WHERE "email" = $1`,
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

    const identity: PlatformIdentity = { id: user.id, sessionId: randomUUID() };
    const tokens = await this.issueTokens(identity);
    try {
      await this.sessionRepository.create({
        id: identity.sessionId,
        userId: identity.id,
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
      user: { id: user.id, email: user.email },
    };
  }

  async refresh(refreshToken: string): Promise<AuthTokenPair> {
    const domain = this.authConfiguration.platform;
    let claims: PlatformJwtClaims;
    try {
      const verified = await this.jwtTokens.verify(refreshToken, {
        secret: domain.refreshSecret,
        issuer: domain.issuer,
        audience: domain.audience,
        scope: 'platform',
        tokenType: 'refresh',
      });
      if (verified.scope !== 'platform' || verified.token_type !== 'refresh') {
        throw new Error('Refresh token security context is invalid');
      }
      claims = verified;
    } catch {
      throw invalidRefreshToken();
    }

    const newTokens = await this.issueTokens({ id: claims.sub, sessionId: claims.session_id });
    let decision: RefreshDecision;
    try {
      decision = await this.masterDataSource.transaction(async (manager) => {
        const session: LockedPlatformSession | null = await this.sessionRepository.findForUpdate(
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
        const receivedHash = hashRefreshToken(refreshToken);
        if (!refreshTokenHashMatches(session.refresh_token_hash, receivedHash)) {
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

  private async issueTokens(identity: PlatformIdentity): Promise<{
    accessToken: string;
    refresh_token: string;
    refreshExpiresAt: Date;
  }> {
    const domain = this.authConfiguration.platform;
    const accessToken = await this.jwtTokens.sign({
      sub: identity.id,
      session_id: identity.sessionId,
      jti: randomUUID(),
      scope: 'platform',
      token_type: 'access',
    }, {
      secret: domain.accessSecret,
      issuer: domain.issuer,
      audience: domain.audience,
      expiresInSeconds: this.authConfiguration.accessTokenTtlSeconds,
    });
    const refresh_token = await this.jwtTokens.sign({
      sub: identity.id,
      session_id: identity.sessionId,
      jti: randomUUID(),
      scope: 'platform',
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
}
