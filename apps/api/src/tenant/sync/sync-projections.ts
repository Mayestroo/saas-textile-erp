import type {
  PattaNumberBlockProjection,
  SyncBadgeProjection,
  SyncEntityType,
  SyncModelProjection,
  SyncOperationProjection,
  SyncPattaOperationSnapshotProjection,
  SyncPattaProjection,
  SyncPriceProjection,
  SyncProjection,
  SyncTemplateProjection,
  SyncWorkerProjection,
} from '@textile/sync-protocol';

interface ProjectionDataByEntity {
  workers: SyncWorkerProjection;
  worker_badge_history: SyncBadgeProjection;
  models: SyncModelProjection;
  model_operations: SyncOperationProjection;
  model_operation_prices: SyncPriceProjection;
  patta_templates: SyncTemplateProjection;
  patta_hisob: SyncPattaProjection;
  patta_operation_snapshots: SyncPattaOperationSnapshotProjection;
  patta_number_blocks: PattaNumberBlockProjection;
}

interface ProjectionVersionByEntity {
  workers: string;
  worker_badge_history: null;
  models: string;
  model_operations: string;
  model_operation_prices: null;
  patta_templates: string;
  patta_hisob: string;
  patta_operation_snapshots: null;
  patta_number_blocks: null;
}

export type SyncProjectionInput = {
  [Entity in SyncEntityType]: {
    entityType: Entity;
    data: ProjectionDataByEntity[Entity];
    entityVersion: ProjectionVersionByEntity[Entity];
  };
}[SyncEntityType];

export function createSyncProjection(
  input: SyncProjectionInput,
): SyncProjection {
  switch (input.entityType) {
    case 'workers':
      return {
        projection_version: 1,
        entity_type: input.entityType,
        entity_id: input.data.id,
        entity_version: input.entityVersion,
        data: input.data,
      };
    case 'worker_badge_history':
      return {
        projection_version: 1,
        entity_type: input.entityType,
        entity_id: input.data.id,
        entity_version: input.entityVersion,
        data: input.data,
      };
    case 'models':
      return {
        projection_version: 1,
        entity_type: input.entityType,
        entity_id: input.data.id,
        entity_version: input.entityVersion,
        data: input.data,
      };
    case 'model_operations':
      return {
        projection_version: 1,
        entity_type: input.entityType,
        entity_id: input.data.id,
        entity_version: input.entityVersion,
        data: input.data,
      };
    case 'model_operation_prices':
      return {
        projection_version: 1,
        entity_type: input.entityType,
        entity_id: input.data.id,
        entity_version: input.entityVersion,
        data: input.data,
      };
    case 'patta_templates':
      return {
        projection_version: 1,
        entity_type: input.entityType,
        entity_id: input.data.id,
        entity_version: input.entityVersion,
        data: input.data,
      };
    case 'patta_hisob':
      return {
        projection_version: 1,
        entity_type: input.entityType,
        entity_id: input.data.id,
        entity_version: input.entityVersion,
        data: input.data,
      };
    case 'patta_operation_snapshots':
      return {
        projection_version: 1,
        entity_type: input.entityType,
        entity_id: input.data.id,
        entity_version: input.entityVersion,
        data: input.data,
      };
    case 'patta_number_blocks':
      return {
        projection_version: 1,
        entity_type: input.entityType,
        entity_id: input.data.id,
        entity_version: input.entityVersion,
        data: input.data,
      };
  }
}
