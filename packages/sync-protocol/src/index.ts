export type SyncMutationOperation = 'CREATE' | 'UPDATE' | 'DELETE';
export type SyncChangeOperation = 'UPSERT' | 'DELETE';
export type SyncResultStatus = 'SYNCED' | 'CONFLICT' | 'FAILED';

export type SyncEntityType =
  | 'workers'
  | 'worker_badge_history'
  | 'models'
  | 'model_operations'
  | 'model_operation_prices'
  | 'patta_templates'
  | 'patta_hisob'
  | 'patta_operation_snapshots'
  | 'patta_number_blocks';

export interface SyncEvent<TEntityType extends string = string, TPayload = unknown> {
  event_id: string;
  entity_type: TEntityType;
  entity_id: string | null;
  operation: SyncMutationOperation;
  base_version: string | null;
  client_created_at: string;
  occurred_at: string;
  reference_cursor: string;
  payload: TPayload;
}

export interface SyncPattaOperationSnapshotInput {
  id: string;
  operation_id: string;
  operation_name_snapshot: string;
  unit_price_snapshot: string;
  sort_order: number;
}

export interface SyncPattaCreatePayload {
  partiya_number: string;
  patta_number: string;
  model_id: string;
  model_name_snapshot: string;
  template_id: string | null;
  konveyer_snapshot: string;
  razmer: string | null;
  rang: string | null;
  block_id: string;
  template_overrides?: {
    konveyer?: string;
    razmer?: string | null;
    rang?: string | null;
  };
  reference_versions: {
    model: string;
    template: string | null;
    operations: Readonly<Record<string, string>>;
  };
  operations: readonly SyncPattaOperationSnapshotInput[];
}

export type OfflinePattaCreateEvent = Omit<
  SyncEvent<'patta', SyncPattaCreatePayload>,
  'entity_id' | 'operation' | 'base_version'
> & {
  entity_id: string;
  operation: 'CREATE';
  base_version: '0';
};

export interface SyncPushRequest {
  device_id: string;
  events: readonly SyncEvent[];
}

export interface SyncPushResponse {
  results: readonly SyncPushResult[];
}

export interface SyncPullRequest {
  device_id: string;
  cursor: string;
  limit?: number;
}

export interface SyncPullResponse {
  changes: readonly SyncChange[];
  next_cursor: string;
  has_more: boolean;
}

export type SyncPushResult =
  | {
      event_id: string;
      status: 'SYNCED';
      entity_version: string | null;
      projection: SyncProjection;
      change_sequence: string;
    }
  | {
      event_id: string | null;
      status: 'CONFLICT';
      conflict: SyncConflict;
    }
  | {
      event_id: string | null;
      status: 'FAILED';
      error: SyncFailure;
    };

export interface SyncConflict {
  code: SyncErrorCode;
  message: string;
  details: Record<string, unknown>;
  local_payload: unknown;
  server_payload: unknown;
}

export interface SyncFailure {
  code: SyncErrorCode;
  message: string;
  details: Record<string, unknown>;
}

export interface SyncChange {
  sequence_id: string;
  entity_type: SyncEntityType;
  entity_id: string;
  operation: SyncChangeOperation;
  entity_version: string | null;
  projection_version: 1;
  payload: SyncProjection | null;
  changed_at: string;
}

export type SyncProjection =
  | {
      projection_version: 1;
      entity_type: 'workers';
      entity_id: string;
      entity_version: string;
      data: SyncWorkerProjection;
    }
  | {
      projection_version: 1;
      entity_type: 'worker_badge_history';
      entity_id: string;
      entity_version: null;
      data: SyncBadgeProjection;
    }
  | {
      projection_version: 1;
      entity_type: 'models';
      entity_id: string;
      entity_version: string;
      data: SyncModelProjection;
    }
  | {
      projection_version: 1;
      entity_type: 'model_operations';
      entity_id: string;
      entity_version: string;
      data: SyncOperationProjection;
    }
  | {
      projection_version: 1;
      entity_type: 'model_operation_prices';
      entity_id: string;
      entity_version: null;
      data: SyncPriceProjection;
    }
  | {
      projection_version: 1;
      entity_type: 'patta_templates';
      entity_id: string;
      entity_version: string;
      data: SyncTemplateProjection;
    }
  | {
      projection_version: 1;
      entity_type: 'patta_hisob';
      entity_id: string;
      entity_version: string;
      data: SyncPattaProjection;
    }
  | {
      projection_version: 1;
      entity_type: 'patta_operation_snapshots';
      entity_id: string;
      entity_version: null;
      data: SyncPattaOperationSnapshotProjection;
    }
  | {
      projection_version: 1;
      entity_type: 'patta_number_blocks';
      entity_id: string;
      entity_version: null;
      data: PattaNumberBlockProjection;
    };

export interface SyncWorkerProjection {
  id: string;
  full_name: string;
  status: 'ACTIVE' | 'INACTIVE';
  version: string;
  created_at: string;
  updated_at: string;
}

export interface SyncBadgeProjection {
  id: string;
  badge_number: string;
  worker_id: string;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
}

export interface SyncModelProjection {
  id: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  version: string;
  created_at: string;
  updated_at: string;
}

export interface SyncOperationProjection {
  id: string;
  model_id: string;
  name: string;
  sort_order: number;
  status: 'ACTIVE' | 'INACTIVE';
  version: string;
  created_at: string;
  updated_at: string;
}

export interface SyncPriceProjection {
  id: string;
  operation_id: string;
  price: string;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
}

export interface SyncTemplateProjection {
  id: string;
  name: string;
  model_id: string;
  konveyer: string;
  razmer: string | null;
  rang: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  version: string;
  created_at: string;
  updated_at: string;
}

export interface SyncPattaProjection {
  id: string;
  partiya_number: string;
  patta_number: string;
  model_id: string;
  model_name_snapshot: string;
  template_id: string | null;
  konveyer_snapshot: string;
  razmer: string | null;
  rang: string | null;
  ish_soni: number;
  created_device_id: string;
  created_from_block_id: string | null;
  created_at: string;
  client_created_at: string | null;
  occurred_at: string | null;
}

export interface SyncPattaOperationSnapshotProjection {
  id: string;
  patta_hisob_id: string;
  operation_id: string;
  operation_name_snapshot: string;
  unit_price_snapshot: string;
  sort_order: number;
  created_at: string;
}

export interface PattaNumberBlockProjection {
  id: string;
  device_id: string;
  range_start: string;
  range_end: string;
  reported_used_count: string;
  status: 'ACTIVE' | 'EXHAUSTED' | 'CANCELLED';
  allocated_at: string;
  exhausted_at: string | null;
}

export interface SyncBootstrapSession {
  id: string;
  device_id: string;
  watermark: string;
  status: 'ACTIVE' | 'COMPLETED' | 'EXPIRED';
  expires_at: string;
}

export interface SyncBootstrapPage {
  session_id: string;
  watermark: string;
  items: readonly { order_key: string; projection: SyncProjection }[];
  next_order_key: string | null;
  has_more: boolean;
}

export interface SyncBootstrapRequest {
  device_id: string;
}

export interface SyncBootstrapPageRequest {
  device_id: string;
  session_id: string;
  after: string | null;
  limit?: number;
}

export interface SyncBootstrapCompleteRequest {
  device_id: string;
  session_id: string;
}

export interface SyncBootstrapCompleteResponse {
  session_id: string;
  status: 'COMPLETED';
}

export type SyncErrorCode =
  | 'VERSION_CONFLICT'
  | 'PATTA_ALREADY_EXISTS'
  | 'PATTA_NUMBER_OUTSIDE_BLOCK'
  | 'PATTA_BLOCK_DEVICE_MISMATCH'
  | 'PATTA_SNAPSHOT_MISMATCH'
  | 'REFERENCE_DATA_STALE'
  | 'DEVICE_NOT_ACTIVE'
  | 'PAYLOAD_INVALID'
  | 'SYNC_BOOTSTRAP_EXPIRED'
  | 'EVENT_ID_REUSE_MISMATCH'
  | 'SYNC_CURSOR_EXPIRED'
  | (string & {});
