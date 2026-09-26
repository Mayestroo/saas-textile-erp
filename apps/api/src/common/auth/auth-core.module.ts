import { Global, Module } from '@nestjs/common';
import { AUTH_CONFIGURATION, loadAuthConfiguration } from './auth-configuration.js';
import { JwtTokenService } from './jwt-token.service.js';
import { PasswordPolicy } from './password-policy.js';
import { PostgresLoginRateLimiter } from './postgres-login-rate-limiter.js';

@Global()
@Module({
  providers: [
    {
      provide: AUTH_CONFIGURATION,
      useFactory: () => loadAuthConfiguration(process.env),
    },
    JwtTokenService,
    PasswordPolicy,
    PostgresLoginRateLimiter,
  ],
  exports: [AUTH_CONFIGURATION, JwtTokenService, PasswordPolicy, PostgresLoginRateLimiter],
})
export class AuthCoreModule {}
