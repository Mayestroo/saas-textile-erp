import { Module } from '@nestjs/common';
import { DevicesModule } from '../../master/devices/devices.module.js';
import { TenantAuthModule } from '../auth/tenant-auth.module.js';
import { TenantConnectionModule } from '../tenant-connection/tenant-connection.module.js';
import { TenantResolverModule } from '../tenant-resolver/tenant-resolver.module.js';
import { PattaModule } from '../patta/patta.module.js';
import { SYNC_CONFIGURATION, loadSyncConfiguration } from './sync.config.js';
import { PattaSyncHandler } from './patta-sync-handler.js';
import { SyncController } from './sync.controller.js';
import { SyncEventProcessor } from './sync-event-processor.js';
import { SyncHandlerRegistry, SYNC_ENTITY_HANDLERS } from './sync-handler.registry.js';
import { SyncService } from './sync.service.js';

@Module({
  imports: [
    DevicesModule,
    TenantAuthModule,
    TenantConnectionModule,
    TenantResolverModule,
    PattaModule,
  ],
  controllers: [SyncController],
  providers: [
    {
      provide: SYNC_CONFIGURATION,
      useFactory: () => loadSyncConfiguration(process.env),
    },
    {
      provide: SYNC_ENTITY_HANDLERS,
      useFactory: (pattaSyncHandler: PattaSyncHandler) => [pattaSyncHandler],
      inject: [PattaSyncHandler],
    },
    SyncHandlerRegistry,
    SyncEventProcessor,
    SyncService,
  ],
})
export class SyncModule {}
