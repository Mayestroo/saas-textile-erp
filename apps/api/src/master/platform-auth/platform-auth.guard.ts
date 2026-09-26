import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { bearerToken } from '../../common/auth/bearer-token.js';
import { AUTH_CONFIGURATION } from '../../common/auth/auth-configuration.js';
import type { AuthConfiguration } from '../../common/auth/auth-configuration.js';
import type { PlatformAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { JwtTokenService } from '../../common/auth/jwt-token.service.js';
import type { PlatformJwtClaims } from '../../common/auth/jwt-token.service.js';
import { MASTER_DATA_SOURCE_NAME } from '../../database/master/master-database.config.js';

interface ActivePlatformSessionRow {
  id: string;
}

function invalidAccessToken(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'INVALID_ACCESS_TOKEN',
    message: 'Kirish tokeni yaroqsiz yoki muddati tugagan',
    details: {},
  });
}

@Injectable()
export class PlatformAuthGuard implements CanActivate {
  constructor(
    @InjectDataSource(MASTER_DATA_SOURCE_NAME) private readonly masterDataSource: DataSource,
    private readonly jwtTokens: JwtTokenService,
    @Inject(AUTH_CONFIGURATION) private readonly authConfiguration: AuthConfiguration,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PlatformAuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Platforma foydalanuvchisi sifatida tizimga kiring',
        details: {},
      });
    }

    const domain = this.authConfiguration.platform;
    let claims: PlatformJwtClaims;
    try {
      const verified = await this.jwtTokens.verify(token, {
        secret: domain.accessSecret,
        issuer: domain.issuer,
        audience: domain.audience,
        scope: 'platform',
        tokenType: 'access',
      });
      if (verified.scope !== 'platform' || verified.token_type !== 'access') {
        throw new Error('Platform access-token context is invalid');
      }
      claims = verified;
    } catch {
      throw invalidAccessToken();
    }

    let sessions: ActivePlatformSessionRow[];
    try {
      sessions = await this.masterDataSource.query(
        `SELECT session."id"
         FROM "platform_auth_sessions" AS session
         INNER JOIN "platform_users" AS user_account ON user_account."id" = session."user_id"
         WHERE session."id" = $1 AND session."user_id" = $2
           AND session."revoked_at" IS NULL AND session."expires_at" > now()
           AND user_account."status" = 'ACTIVE'`,
        [claims.session_id, claims.sub],
      );
    } catch {
      throw new ServiceUnavailableException({
        code: 'AUTHENTICATION_UNAVAILABLE',
        message: 'Kirish xizmati vaqtincha ishlamayapti',
        details: {},
      });
    }
    if (sessions.length !== 1) {
      throw invalidAccessToken();
    }

    request.platformUser = { userId: claims.sub, sessionId: claims.session_id };
    return true;
  }
}
