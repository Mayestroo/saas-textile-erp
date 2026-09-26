import { Module } from '@nestjs/common';
import { TenantResolverModule } from './tenant-resolver/tenant-resolver.module.js';
import { TenantConnectionModule } from './tenant-connection/tenant-connection.module.js';
import { TenantAuthModule } from './auth/tenant-auth.module.js';
import { ModelsModule } from './models/models.module.js';
import { OperationsModule } from './operations/operations.module.js';
import { WorkersModule } from './workers/workers.module.js';
import { PattaModule } from './patta/patta.module.js';

@Module({
  imports: [TenantResolverModule, TenantConnectionModule, TenantAuthModule, ModelsModule, OperationsModule, WorkersModule, PattaModule]
})
export class TenantModule {}
