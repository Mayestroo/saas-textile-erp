import type {
  OfflinePattaCreateEvent,
  PattaNumberBlockProjection,
  SyncBootstrapPage,
  SyncConflict,
  SyncErrorCode,
  SyncEvent,
  SyncProjection,
  SyncPullResponse,
  SyncPushResponse,
  SyncPushResult,
  SyncWorkerProjection,
} from '@textile/sync-protocol';

const worker: SyncWorkerProjection = {
  id: '18',
  full_name: 'Abdullayeva Nodira',
  status: 'ACTIVE',
  version: '1',
  created_at: '2026-09-26T00:00:00.000Z',
  updated_at: '2026-09-26T00:00:00.000Z',
};

const projection: SyncProjection = {
  projection_version: 1,
  entity_type: 'workers',
  entity_id: worker.id,
  entity_version: worker.version,
  data: worker,
};

const event: OfflinePattaCreateEvent = {
  event_id: '11111111-1111-4111-8111-111111111111',
  entity_type: 'patta',
  entity_id: '22222222-2222-4222-8222-222222222222',
  operation: 'CREATE',
  base_version: '0',
  client_created_at: '2026-09-26T00:00:00.000Z',
  occurred_at: '2026-09-26T00:00:00.000Z',
  reference_cursor: '12840',
  payload: {
    partiya_number: 'A-1',
    patta_number: '1000',
    model_id: '77777777-7777-4777-8777-777777777777',
    model_name_snapshot: 'Atlas',
    template_id: null,
    konveyer_snapshot: '1',
    razmer: null,
    rang: null,
    block_id: '33333333-3333-4333-8333-333333333333',
    reference_versions: { model: '1', template: null, operations: { '88888888-8888-4888-8888-888888888888': '1' } },
    operations: [{
      id: '99999999-9999-4999-8999-999999999999',
      operation_id: '88888888-8888-4888-8888-888888888888',
      operation_name_snapshot: 'Tikish',
      unit_price_snapshot: '1200.00',
      sort_order: 0,
    }],
  },
};
const genericEvent: SyncEvent = event;

const success: SyncPushResult = {
  event_id: event.event_id,
  status: 'SYNCED',
  entity_version: '1',
  projection,
  change_sequence: '12841',
};

const conflictCode: SyncErrorCode = 'REFERENCE_DATA_STALE';
const conflict: SyncConflict = {
  code: conflictCode,
  message: 'Patta snapshot ma’lumoti eskirgan',
  details: {},
  local_payload: event.payload,
  server_payload: null,
};
const pushResponse: SyncPushResponse = {
  results: [success, { event_id: event.event_id, status: 'CONFLICT', conflict }],
};

const pullResponse: SyncPullResponse = {
  changes: [],
  next_cursor: '12841',
  has_more: false,
};

const bootstrapPage: SyncBootstrapPage = {
  session_id: '44444444-4444-4444-8444-444444444444',
  watermark: '12841',
  items: [{ order_key: '1', projection }],
  next_order_key: null,
  has_more: false,
};

const block: PattaNumberBlockProjection = {
  id: '55555555-5555-4555-8555-555555555555',
  device_id: '66666666-6666-4666-8666-666666666666',
  range_start: '1000',
  range_end: '1999',
  reported_used_count: '25',
  status: 'ACTIVE',
  allocated_at: '2026-09-26T00:00:00.000Z',
  exhausted_at: null,
};

void [genericEvent, pushResponse, pullResponse, bootstrapPage, block];
