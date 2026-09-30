import { Body, Controller, Get, HttpCode, Ip, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { requireTenantContext } from './require-tenant-context.js';
import { TenantAuthGuard } from './tenant-auth.guard.js';
import { TenantPermissionsProjectionService } from './tenant-permissions-projection.service.js';
import { TenantLoginDto } from './dto/tenant-login.dto.js';
import { TenantRefreshDto } from './dto/tenant-refresh.dto.js';
import type { TenantLoginResponse, TenantRefreshResponse } from './tenant-auth.service.js';
import { TenantAuthService } from './tenant-auth.service.js';

@Controller('api/v1/auth')
export class TenantAuthController {
  constructor(
    private readonly tenantAuthService: TenantAuthService,
    private readonly permissionsProjection: TenantPermissionsProjectionService,
  ) {}

  @Get('permissions')
  @UseGuards(TenantAuthGuard)
  permissions(@Req() request: TenantAuthenticatedRequest) {
    const { dataSource, actorUserId } = requireTenantContext(request);
    return this.permissionsProjection.listForUser(dataSource, actorUserId);
  }

  @Post('login')
  @HttpCode(200)
  login(
    @Body() input: TenantLoginDto,
    @Req() request: Request,
    @Ip() ipAddress: string,
  ): Promise<TenantLoginResponse> {
    return this.tenantAuthService.login(request.hostname, input, ipAddress || 'unknown');
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(
    @Body() input: TenantRefreshDto,
    @Req() request: Request,
  ): Promise<TenantRefreshResponse> {
    return this.tenantAuthService.refresh(request.hostname, input.refresh_token);
  }
}
