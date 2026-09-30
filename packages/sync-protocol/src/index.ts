export type SyncMutationOperation = 'CREATE' | 'UPDATE' | 'DELETE';
export type SyncChangeOperation = 'UPSERT' | 'DELETE';
export type SyncResultStatus = 'SYNCED' | 'CONFLICT' | 'FAILED';
export type SyncProtocolVersion = 1 | 2 | 3;

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

export type SyncV2EntityType =
  | 'patta_hisob'
  | 'patta_operation_snapshots'
  | 'patta_partiya_number_blocks'
  | 'patta_print_batches'
  | 'patta_print_batch_sizes'
  | 'patta_print_events'
  | 'patta_sheets'
  | 'patta_sheet_operation_snapshots'
  | 'patta_sheet_rows';

export type SyncV3EntityType = SyncEntityType | SyncV2EntityType | 'model_account_adjustments';

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
  ish_soni: number;
  partiya_number: string;
  patta_number: string;
  model_id: string;
  model_name_snapshot: string;
  template_id: string | null;
  konveyer_snapshot: string | null;
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
  protocol_version?: SyncProtocolVersion;
  events: readonly SyncEvent[];
}

export interface SyncPushResponse {
  results: readonly SyncPushResult[];
}

export interface SyncPullRequest {
  device_id: string;
  protocol_version?: SyncProtocolVersion;
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
      projection: SyncProjection | SyncProjectionV2 | SyncProjectionV3 | null;
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
  entity_type: SyncV3EntityType;
  entity_id: string;
  operation: SyncChangeOperation;
  entity_version: string | null;
  projection_version: 1 | 2 | 3;
  payload: SyncProjection | SyncProjectionV2 | SyncProjectionV3 | null;
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

export type SyncProjectionV2 =
  | {
      projection_version: 2;
      entity_type: 'patta_hisob';
      entity_id: string;
      entity_version: string;
      data: SyncPattaProjectionV2;
    }
  | {
      projection_version: 2;
      entity_type: 'patta_operation_snapshots';
      entity_id: string;
      entity_version: null;
      data: SyncPattaOperationSnapshotProjectionV2;
    }
  | {
      projection_version: 2;
      entity_type: 'patta_partiya_number_blocks';
      entity_id: string;
      entity_version: null;
      data: PattaPartiyaNumberBlockProjection;
    }
  | {
      projection_version: 2;
      entity_type: 'patta_print_batches';
      entity_id: string;
      entity_version: string;
      data: PattaPrintBatchProjection;
    }
  | {
      projection_version: 2;
      entity_type: 'patta_print_batch_sizes';
      entity_id: string;
      entity_version: null;
      data: PattaPrintBatchSizeProjection;
    }
  | {
      projection_version: 2;
      entity_type: 'patta_print_events';
      entity_id: string;
      entity_version: null;
      data: PattaPrintEventProjection;
    }
  | {
      projection_version: 2;
      entity_type: 'patta_sheets';
      entity_id: string;
      entity_version: string;
      data: PattaSheetProjectionV2;
    }
  | {
      projection_version: 2;
      entity_type: 'patta_sheet_operation_snapshots';
      entity_id: string;
      entity_version: null;
      data: PattaSheetOperationSnapshotProjectionV2;
    }
  | {
      projection_version: 2;
      entity_type: 'patta_sheet_rows';
      entity_id: string;
      entity_version: null;
      data: PattaSheetRowProjection;
    }
  | {
      projection_version: 2;
      entity_type: 'model_operations';
      entity_id: string;
      entity_version: string;
      data: SyncOperationProjection;
    };

export type SyncProjectionV3 =
  | SyncProjection
  | SyncProjectionV2
  | {
      projection_version: 3;
      entity_type: 'patta_sheets';
      entity_id: string;
      entity_version: string;
      data: PattaSheetProjectionV3;
    }
  | {
      projection_version: 3;
      entity_type: 'model_account_adjustments';
      entity_id: string;
      entity_version: string;
      data: ModelAccountAdjustmentProjection;
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

export interface CustomModelOperationCreatePayload {
  id: string;
  model_id: string;
  name: string;
  initial_price: string;
  sort_order: number;
  effective_from: string;
}

export type CustomModelOperationCreateEvent = Omit<
  SyncEvent<'model_operation', CustomModelOperationCreatePayload>,
  'operation' | 'base_version'
> & {
  operation: 'CREATE';
  base_version: '0';
};

export interface SyncPattaProjectionV2 extends Omit<SyncPattaProjection, 'ish_soni' | 'konveyer_snapshot'> {
  konveyer_snapshot: string | null;
  ish_soni: number | null;
  legacy_operation_count: number | null;
  status: 'ACTIVE' | 'VOID';
  print_batch_id: string | null;
}

export interface SyncPattaOperationSnapshotProjectionV2 extends SyncPattaOperationSnapshotProjection {}

export interface PattaPartiyaNumberBlockProjection {
  id: string;
  device_id: string;
  range_start: string;
  range_end: string;
  reported_used_count: string;
  status: 'ACTIVE' | 'EXHAUSTED' | 'CANCELLED';
  allocated_at: string;
  exhausted_at: string | null;
}

export interface PattaPrintBatchSizeProjection {
  id: string;
  print_batch_id: string;
  razmer: string;
  patta_count: number;
  sort_order: number;
}

export interface PattaPrintBatchOperationSnapshotProjection {
  id: string;
  patta_hisob_id: string;
  operation_id: string;
  operation_name_snapshot: string;
  unit_price_snapshot: string;
  sort_order: number;
  created_at: string;
}

export interface PattaPrintBatchPattaProjection {
  id: string;
  partiya_number: string;
  patta_number: string;
  model_id: string;
  model_name_snapshot: string;
  template_id: string | null;
  konveyer_snapshot: string | null;
  razmer: string | null;
  rang: string | null;
  ish_soni: number | null;
  legacy_operation_count: number | null;
  status: 'ACTIVE' | 'VOID';
  version: string;
  print_batch_id: string | null;
  created_device_id: string;
  created_from_block_id: string | null;
  created_at: string;
  client_created_at: string | null;
  occurred_at: string | null;
  operations: readonly PattaPrintBatchOperationSnapshotProjection[];
}

export interface PattaPrintBatchProjection {
  id: string;
  model_id: string;
  model_name_snapshot: string;
  partiya_number: string;
  partiya_block_id: string | null;
  ish_soni: number;
  rang: string;
  status: 'ACTIVE' | 'VOID' | 'SUPERSEDED';
  version: string;
  revision: number;
  corrected_from_batch_id: string | null;
  created_by: string | null;
  created_device_id: string;
  created_at: string;
  updated_at: string;
  printed_at: string | null;
  size_distribution: readonly PattaPrintBatchSizeProjection[];
  pattas: readonly PattaPrintBatchPattaProjection[];
}

export interface PattaV2LookupMirror {
  server_sequence: string;
  patta: PattaPrintBatchPattaProjection;
  batch: PattaPrintBatchProjection | null;
}

export interface PattaPrintEventProjection {
  id: string;
  batch_id: string;
  revision: number;
  kind: 'INITIAL' | 'REPRINT' | 'CORRECTED_REPRINT';
  outcome: 'REQUESTED' | 'SUCCEEDED' | 'FAILED';
  actor_user_id: string | null;
  device_id: string;
  created_at: string;
  printed_at: string | null;
}

export interface PattaSheetOperationSnapshotProjectionV2 {
  id: string;
  patta_sheet_id: string;
  model_operation_id: string;
  source_type: 'PATTA' | 'CUSTOM';
  source_patta_operation_snapshot_id: string | null;
  operation_name_snapshot: string;
  unit_price_snapshot: string;
  sort_order: number;
  created_at: string;
}

export interface OperationPriceChangeProjection extends SyncPriceProjection {
  created_by: string | null;
  operation_version: string;
}

export interface PattaSheetOperationSnapshotProjectionV3 extends Omit<PattaSheetOperationSnapshotProjectionV2, 'source_type'> {
  source_type: 'PATTA' | 'MODEL' | 'CUSTOM';
}

export interface DesktopModelOperationOption {
  model_operation_id: string;
  operation_name_snapshot: string;
  unit_price_snapshot: string;
  sort_order: number;
  version: string;
}

// Keep the unversioned aliases on the legacy V2 shape until each consumer
// explicitly opts into V3. This prevents a protocol upgrade from silently
// changing the existing /api/v2 contract.
export type PattaSheetOperationSnapshotProjection = PattaSheetOperationSnapshotProjectionV2;

export interface PattaSheetRowProjection {
  id: string;
  patta_sheet_id: string;
  patta_sheet_operation_snapshot_id: string;
  worker_id: string;
  quantity_snapshot: number;
  nuqson: boolean;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PattaSheetProjectionV2 {
  id: string;
  patta_hisob_id: string;
  entered_at: string;
  business_date: string;
  conveyor_snapshot: string | null;
  version: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  operation_snapshots: readonly PattaSheetOperationSnapshotProjectionV2[];
  rows: readonly PattaSheetRowProjection[];
}

export interface PattaSheetProjectionV3 {
  id: string;
  entry_kind: 'PATTA_LINKED' | 'STANDALONE';
  patta_hisob_id: string | null;
  model_id: string;
  model_name_snapshot: string;
  ish_soni: number;
  partiya_number_snapshot: string | null;
  patta_number_snapshot: string | null;
  rang_snapshot: string | null;
  razmer_snapshot: string | null;
  entered_at: string;
  business_date: string;
  conveyor_snapshot: string | null;
  version: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  deleted_by_name_snapshot: string | null;
  operation_snapshots: readonly PattaSheetOperationSnapshotProjectionV3[];
  rows: readonly PattaSheetRowProjection[];
}

export interface ModelAccountAdjustmentProjection {
  id: string;
  model_id: string;
  model_operation_id: string;
  worker_id: string;
  quantity: number;
  unit_price_snapshot: string;
  entered_at: string;
  business_date: string;
  version: string;
  created_by: string;
  created_device_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface ModelAccountOperationTotal {
  model_operation_id: string;
  operation_name: string;
  sort_order: number;
  version: string;
  status: 'ACTIVE' | 'INACTIVE';
  current_price: string | null;
  quantity: string;
  patta_quantity: string;
  standalone_quantity: string;
  manual_quantity: string;
  gross_amount: string;
  patta_amount: string;
  standalone_amount: string;
  manual_amount: string;
}

export interface ModelAccountContributionRow {
  worker_id: string;
  worker_name: string;
  model_operation_id: string;
  patta_quantity: string;
  standalone_quantity: string;
  manual_quantity: string;
  total_quantity: string;
  patta_amount: string;
  standalone_amount: string;
  manual_amount: string;
  gross_amount: string;
}

export interface ModelAccountSheetV3 {
  model_id: string;
  model_name: string;
  operations: readonly ModelAccountOperationTotal[];
  rows: readonly ModelAccountContributionRow[];
}

export interface ModelAccountWorkerDetail {
  model_id: string;
  model_name: string;
  model_operation_id: string;
  operation_name: string;
  source: 'PATTA' | 'STANDALONE' | 'MANUAL';
  quantity: string;
  unit_price_snapshot: string;
  gross_amount: string;
  entered_at: string;
  manual_adjustment_id: string | null;
  version: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface ConveyorAccountRow {
  conveyor_label: string;
  model_id: string;
  model_name: string;
  patta_count: string;
  standalone_entry_count: string;
  manual_adjustment_count: string;
  ish_soni: string;
}

export interface ModelAccountAdjustmentMutationPayload {
  model_id: string;
  model_operation_id: string;
  worker_id: string;
  quantity: number;
  unit_price_snapshot: string;
  entered_at: string;
  business_date: string;
  deleted_at: string | null;
  deleted_by: string | null;
  depends_on_event_ids: readonly string[];
}

export type ModelAccountAdjustmentSyncEvent = Omit<
  SyncEvent<'model_account_adjustment', ModelAccountAdjustmentMutationPayload>,
  'entity_id' | 'base_version'
> & {
  entity_id: string;
  base_version: string;
  operation: 'CREATE' | 'UPDATE';
};

export type PattaSheetProjection = PattaSheetProjectionV2;

export interface PattaSheetOperationSnapshotInputV2 extends Omit<PattaSheetOperationSnapshotProjectionV2, 'patta_sheet_id' | 'created_at'> {}
export interface PattaSheetOperationSnapshotInputV3 extends Omit<PattaSheetOperationSnapshotProjectionV3, 'patta_sheet_id' | 'created_at'> {}
export interface PattaSheetOperationSnapshotInput extends PattaSheetOperationSnapshotInputV2 {}

export interface PattaSheetRowInput extends Omit<PattaSheetRowProjection, 'patta_sheet_id' | 'created_at' | 'updated_at'> {
  entered_badge_number: string;
}

export interface PattaSheetMutationPayloadV2 {
  patta_hisob_id: string;
  entered_at: string;
  business_date: string;
  conveyor_snapshot: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  operation_snapshots: readonly PattaSheetOperationSnapshotInputV2[];
  rows: readonly PattaSheetRowInput[];
  depends_on_event_ids: readonly string[];
}

export interface PattaSheetMutationPayloadV3 extends Omit<PattaSheetMutationPayloadV2, 'patta_hisob_id' | 'operation_snapshots'> {
  entry_kind: 'PATTA_LINKED' | 'STANDALONE';
  patta_hisob_id: string | null;
  model_id: string;
  model_name_snapshot: string;
  ish_soni: number;
  partiya_number_snapshot: string | null;
  patta_number_snapshot: string | null;
  rang_snapshot: string | null;
  razmer_snapshot: string | null;
  deleted_by_name_snapshot: string | null;
  operation_snapshots: readonly PattaSheetOperationSnapshotInputV3[];
}

export type PattaSheetMutationPayload = PattaSheetMutationPayloadV2;

export type PattaSheetSyncEventV2 = Omit<
  SyncEvent<'patta_sheet', PattaSheetMutationPayloadV2>,
  'entity_id' | 'base_version'
> & {
  entity_id: string;
  base_version: string;
};

export type PattaSheetSyncEventV3 = Omit<
  SyncEvent<'patta_sheet', PattaSheetMutationPayloadV3>,
  'entity_id' | 'base_version'
> & {
  entity_id: string;
  base_version: string;
};

export type PattaSheetSyncEvent = PattaSheetSyncEventV2;

export interface PattaSizeDistributionItem {
  id: string;
  razmer: string;
  patta_count: number;
  sort_order: number;
}

export interface OfflinePattaBatchItem {
  id: string;
  patta_number: string;
  block_id: string | null;
  razmer: string;
  operation_snapshots: readonly SyncPattaOperationSnapshotInput[];
}

export interface PattaPrintBatchMutationPayload {
  model_id: string;
  model_name_snapshot: string;
  partiya_block_id: string | null;
  partiya_number: string;
  ish_soni: number;
  rang: string;
  size_distribution: readonly PattaSizeDistributionItem[];
  pattas: readonly OfflinePattaBatchItem[];
  depends_on_event_ids: readonly string[];
  correction_reason?: string;
}

export type PattaPrintBatchSyncEvent = Omit<
  SyncEvent<'patta_print_batch', PattaPrintBatchMutationPayload>,
  'entity_id' | 'base_version'
> & {
  entity_id: string;
  base_version: string;
};

export interface PattaPrintEventMutationPayload {
  batch_id: string;
  revision: number;
  kind: 'INITIAL' | 'REPRINT' | 'CORRECTED_REPRINT';
  outcome: 'REQUESTED' | 'SUCCEEDED' | 'FAILED';
  device_id: string;
}

export type PattaPrintEventSyncEvent = Omit<
  SyncEvent<'patta_print_event', PattaPrintEventMutationPayload>,
  'entity_id' | 'operation' | 'base_version'
> & {
  entity_id: string;
  operation: 'CREATE';
  base_version: '0';
};

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
  items: readonly { order_key: string; projection: SyncProjection | SyncProjectionV2 | SyncProjectionV3 }[];
  next_order_key: string | null;
  has_more: boolean;
}

export interface SyncBootstrapRequest {
  device_id: string;
  protocol_version?: SyncProtocolVersion;
}

export interface SyncBootstrapPageRequest {
  device_id: string;
  protocol_version?: SyncProtocolVersion;
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
