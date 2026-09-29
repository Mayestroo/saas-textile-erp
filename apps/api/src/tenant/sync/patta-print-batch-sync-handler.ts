import { ConflictException, Injectable } from '@nestjs/common';
import type { SyncEvent, SyncMutationOperation, SyncProjectionV2 } from '@textile/sync-protocol';
import type { EntityManager } from 'typeorm';
import { PattaPrintBatchesService } from '../patta/patta-print-batches.service.js';
import type { SyncApplyContext, SyncEntityHandler, SyncHandlerResult } from './sync-entity-handler.js';

@Injectable()
export class PattaPrintBatchSyncHandler implements SyncEntityHandler {
  constructor(private readonly printBatchesService: PattaPrintBatchesService) {}

  supports(entityType: string, operation: SyncMutationOperation): boolean {
    return entityType === 'patta_print_batch' && (operation === 'CREATE' || operation === 'UPDATE');
  }

  async apply(
    manager: EntityManager,
    context: SyncApplyContext,
    event: SyncEvent,
  ): Promise<SyncHandlerResult> {
    if (context.protocolVersion !== 2) {
      throw new ConflictException({
        code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED',
        message: 'Patta bosma to‘plamini sinxronlash uchun dastur versiyasini yangilang',
        details: {},
      });
    }
    const registered = event.operation === 'CREATE'
      ? await this.printBatchesService.registerOfflineBatch(
        manager, context.actorUserId, context.validatedDeviceId, event,
      )
      : await this.printBatchesService.registerOfflineBatchCorrection(
        manager, context.actorUserId, context.validatedDeviceId, event,
      );
    const projection: SyncProjectionV2 = {
      projection_version: 2,
      entity_type: 'patta_print_batches',
      entity_id: registered.batch.id,
      entity_version: registered.batch.version,
      data: registered.batch,
    };
    return {
      entityVersion: registered.batch.version,
      projection,
      changeSequence: registered.changeSequence,
    };
  }
}
