import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { bearerToken } from '../../common/auth/bearer-token.js';
import { AUTH_CONFIGURATION } from '../../common/auth/auth-configuration.js';
import type { AuthConfiguration } from '../../common/auth/auth-configuration.js';
import type { TenantAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { JwtTokenService } from '../../common/auth/jwt-token.service.js';
import type { TenantJwtClaims } from '../../common/auth/jwt-token.service.js';
import { TenantConnectionManager } from '../tenant-connection/tenant-connection.manager.js';
import { TenantResolverService } from '../tenant-resolver/tenant-resolver.service.js';

interface ActiveTenantSessionRow {
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
export class TenantAuthGuard implements CanActivate {
  constructor(
    private readonly tenantResolver: TenantResolverService,
    private readonly tenantConnectionManager: TenantConnectionManager,
    private readonly jwtTokens: JwtTokenService,
    @Inject(AUTH_CONFIGURATION) private readonly authConfiguration: AuthConfiguration,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TenantAuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Korxona foydalanuvchisi sifatida tizimga kiring',
        details: {},
      });
    }

    const domain = this.authConfiguration.tenant;
    let claims: TenantJwtClaims;
    try {
      const verified = await this.jwtTokens.verify(token, {
        secret: domain.accessSecret,
        issuer: domain.issuer,
        audience: domain.audience,
        scope: 'tenant',
        tokenType: 'access',
      });
      if (verified.scope !== 'tenant' || verified.token_type !== 'access') {
        throw new Error('Tenant access-token context is invalid');
      }
      claims = verified;
    } catch {
      throw invalidAccessToken();
    }

    const companyContext = await this.tenantResolver.resolve({
      hostname: request.hostname,
      authenticatedCompanyId: claims.company_id,
    });

    let dataSource: DataSource;
    try {
      dataSource = await this.tenantConnectionManager.getDataSource(companyContext.companyId);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new ServiceUnavailableException({
        code: 'AUTHENTICATION_UNAVAILABLE',
        message: 'Kirish xizmati vaqtincha ishlamayapti',
        details: {},
      });
    }

    let sessions: ActiveTenantSessionRow[];
    try {
      sessions = await dataSource.query(
        `SELECT session."id"
         FROM "auth_sessions" AS session
         INNER JOIN "users" AS user_account ON user_account."id" = session."user_id"
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

    request.tenantUser = {
      userId: claims.sub,
      sessionId: claims.session_id,
      companyId: companyContext.companyId,
    };
    request.companyContext = companyContext;
    request.tenantDataSource = dataSource;
    return true;
  }
}
