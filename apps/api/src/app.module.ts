import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { MasterModule } from './master/master.module.js';
import { TenantModule } from './tenant/tenant.module.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';
import { AuthCoreModule } from './common/auth/auth-core.module.js';

@Module({
  imports: [AuthCoreModule, MasterModule, TenantModule, InfrastructureModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
