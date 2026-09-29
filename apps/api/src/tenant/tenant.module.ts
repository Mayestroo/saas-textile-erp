import { Module } from '@nestjs/common';
import { TenantResolverModule } from './tenant-resolver/tenant-resolver.module.js';
import { TenantConnectionModule } from './tenant-connection/tenant-connection.module.js';
import { TenantAuthModule } from './auth/tenant-auth.module.js';
import { ModelsModule } from './models/models.module.js';
import { OperationsModule } from './operations/operations.module.js';
import { WorkersModule } from './workers/workers.module.js';
import { PattaModule } from './patta/patta.module.js';
import { SyncModule } from './sync/sync.module.js';
import { PattaSheetsModule } from './patta-sheets/patta-sheets.module.js';

@Module({
  imports: [TenantResolverModule, TenantConnectionModule, TenantAuthModule, ModelsModule, OperationsModule, WorkersModule, PattaModule, PattaSheetsModule, SyncModule]
})
export class TenantModule {}
