import { ConflictException, Injectable } from '@nestjs/common';
import type { SyncMutationOperation, SyncProjectionV2 } from '@textile/sync-protocol';
import type { EntityManager } from 'typeorm';
import { PattaPrintBatchesService } from '../patta/patta-print-batches.service.js';
import type { SyncApplyContext, SyncEntityHandler, SyncHandlerResult } from './sync-entity-handler.js';

@Injectable()
export class PattaPrintEventSyncHandler implements SyncEntityHandler {
  constructor(private readonly printBatchesService: PattaPrintBatchesService) {}

  supports(entityType: string, operation: SyncMutationOperation): boolean {
    return entityType === 'patta_print_event' && operation === 'CREATE';
  }

  async apply(manager: EntityManager, context: SyncApplyContext, event: import('@textile/sync-protocol').SyncEvent): Promise<SyncHandlerResult> {
    if (context.protocolVersion !== 2 && context.protocolVersion !== 3) {
      throw new ConflictException({
        code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED',
        message: 'Chop etish hodisasini sinxronlash uchun dastur versiyasini yangilang',
        details: {},
      });
    }
    const result = await this.printBatchesService.registerOfflinePrintEvent(
      manager,
      context.actorUserId,
      context.validatedDeviceId,
      event,
    );
    return {
      entityVersion: null,
      projection: result.projection as SyncProjectionV2,
      changeSequence: result.changeSequence,
    };
  }
}
