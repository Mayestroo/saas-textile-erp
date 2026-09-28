import type { EntityManager } from 'typeorm';
import type {
  SyncEvent,
  SyncMutationOperation,
  SyncProjection,
} from '@textile/sync-protocol';

export interface SyncApplyContext {
  actorUserId: string;
  companyId: string;
  validatedDeviceId: string;
}

export interface SyncHandlerResult {
  entityVersion: string | null;
  projection: SyncProjection;
  changeSequence: string;
}

export interface SyncEntityHandler {
  supports(entityType: string, operation: SyncMutationOperation): boolean;
  apply(
    manager: EntityManager,
    context: SyncApplyContext,
    event: SyncEvent,
  ): Promise<SyncHandlerResult>;
}
