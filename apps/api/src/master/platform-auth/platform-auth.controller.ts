import { Body, Controller, HttpCode, Ip, Post } from '@nestjs/common';
import type { AuthTokenPair } from '../../common/auth/auth-response.js';
import { PlatformLoginDto } from './dto/platform-login.dto.js';
import { PlatformRefreshDto } from './dto/platform-refresh.dto.js';
import { PlatformAuthService } from './platform-auth.service.js';
import type { PlatformLoginResponse } from './platform-auth.service.js';

@Controller('api/v1/platform/auth')
export class PlatformAuthController {
  constructor(private readonly platformAuthService: PlatformAuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() input: PlatformLoginDto, @Ip() ipAddress: string): Promise<PlatformLoginResponse> {
    return this.platformAuthService.login(input, ipAddress || 'unknown');
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() input: PlatformRefreshDto): Promise<AuthTokenPair> {
    return this.platformAuthService.refresh(input.refresh_token);
  }
}
