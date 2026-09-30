import { Module } from '@nestjs/common';
import { DevicesModule } from '../../master/devices/devices.module.js';
import { TenantAuthModule } from '../auth/tenant-auth.module.js';
import { TenantConnectionModule } from '../tenant-connection/tenant-connection.module.js';
import { TenantResolverModule } from '../tenant-resolver/tenant-resolver.module.js';
import { PattaModule } from '../patta/patta.module.js';
import { PattaSheetsModule } from '../patta-sheets/patta-sheets.module.js';
import { OperationsModule } from '../operations/operations.module.js';
import { SYNC_CONFIGURATION, loadSyncConfiguration } from './sync.config.js';
import { PattaSyncHandler } from './patta-sync-handler.js';
import { PattaPrintBatchSyncHandler } from './patta-print-batch-sync-handler.js';
import { PattaPrintEventSyncHandler } from './patta-print-event-sync-handler.js';
import { PattaSheetSyncHandler } from './patta-sheet-sync-handler.js';
import { ModelOperationSyncHandler } from './model-operation-sync-handler.js';
import { ModelAccountAdjustmentSyncHandler } from './model-account-adjustment-sync-handler.js';
import { SyncController } from './sync.controller.js';
import { SyncBootstrapService } from './sync-bootstrap.service.js';
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
    PattaSheetsModule,
    OperationsModule,
  ],
  controllers: [SyncController],
  providers: [
    {
      provide: SYNC_CONFIGURATION,
      useFactory: () => loadSyncConfiguration(process.env),
    },
    {
      provide: SYNC_ENTITY_HANDLERS,
      useFactory: (
        pattaSyncHandler: PattaSyncHandler,
        batchSyncHandler: PattaPrintBatchSyncHandler,
        printEventSyncHandler: PattaPrintEventSyncHandler,
        sheetSyncHandler: PattaSheetSyncHandler,
        modelOperationSyncHandler: ModelOperationSyncHandler,
        modelAccountAdjustmentSyncHandler: ModelAccountAdjustmentSyncHandler,
      ) => [
        pattaSyncHandler,
        batchSyncHandler,
        printEventSyncHandler,
        sheetSyncHandler,
        modelOperationSyncHandler,
        modelAccountAdjustmentSyncHandler,
      ],
      inject: [
        PattaSyncHandler, PattaPrintBatchSyncHandler, PattaPrintEventSyncHandler,
        PattaSheetSyncHandler, ModelOperationSyncHandler, ModelAccountAdjustmentSyncHandler,
      ],
    },
    SyncHandlerRegistry,
    SyncEventProcessor,
    PattaPrintBatchSyncHandler,
    PattaPrintEventSyncHandler,
    PattaSheetSyncHandler,
    ModelOperationSyncHandler,
    ModelAccountAdjustmentSyncHandler,
    SyncService,
    SyncBootstrapService,
  ],
})
export class SyncModule {}
