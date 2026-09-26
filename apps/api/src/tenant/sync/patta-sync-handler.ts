import { Injectable } from '@nestjs/common';
import type { SyncEvent, SyncMutationOperation } from '@textile/sync-protocol';
import type { EntityManager } from 'typeorm';
import { PattaService } from '../patta/patta.service.js';
import type { SyncApplyContext, SyncEntityHandler, SyncHandlerResult } from './sync-entity-handler.js';

@Injectable()
export class PattaSyncHandler implements SyncEntityHandler {
  constructor(private readonly pattaService: PattaService) {}

  supports(entityType: string, operation: SyncMutationOperation): boolean {
    return entityType === 'patta' && operation === 'CREATE';
  }

  async apply(
    manager: EntityManager,
    context: SyncApplyContext,
    event: SyncEvent,
  ): Promise<SyncHandlerResult> {
    const created = await this.pattaService.registerOffline(
      manager,
      context.actorUserId,
      context.validatedDeviceId,
      event,
    );
    return {
      entityVersion: created.version,
      projection: created.projection,
      changeSequence: created.changeSequence,
    };
  }
}
