import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';
import { RedisModule } from './redis/redis.module.js';
import { LoggingModule } from './logging/logging.module.js';

@Module({
  imports: [HealthModule, RedisModule, LoggingModule]
})
export class InfrastructureModule {}
