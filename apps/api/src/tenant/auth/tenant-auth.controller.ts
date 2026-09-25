import { Body, Controller, HttpCode, Ip, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthTokenPair } from '../../common/auth/auth-response.js';
import { TenantLoginDto } from './dto/tenant-login.dto.js';
import { TenantRefreshDto } from './dto/tenant-refresh.dto.js';
import type { TenantLoginResponse } from './tenant-auth.service.js';
import { TenantAuthService } from './tenant-auth.service.js';

@Controller('api/v1/auth')
export class TenantAuthController {
  constructor(private readonly tenantAuthService: TenantAuthService) {}

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
  ): Promise<AuthTokenPair> {
    return this.tenantAuthService.refresh(request.hostname, input.refresh_token);
  }
}
