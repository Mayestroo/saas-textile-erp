import type { EntityManager } from 'typeorm';
import type {
  SyncProtocolVersion,
  SyncEvent,
  SyncMutationOperation,
  SyncProjection,
} from '@textile/sync-protocol';

export interface SyncApplyContext {
  actorUserId: string;
  companyId: string;
  validatedDeviceId: string;
  protocolVersion?: SyncProtocolVersion;
  timezone?: string;
}

export interface SyncHandlerResult {
  entityVersion: string | null;
  projection: SyncProjection | import('@textile/sync-protocol').SyncProjectionV2 | null;
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
