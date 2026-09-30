import { z } from 'zod'
import type {
  PattaNumberBlockProjection,
  PattaPartiyaNumberBlockProjection,
  PattaV2LookupMirror,
  SyncBootstrapCompleteResponse,
  SyncBootstrapPage,
  SyncBootstrapSession,
  SyncChange,
  SyncProjectionV3,
  SyncPullResponse,
  SyncPushResponse
} from '@textile/sync-protocol'

const decimalCursorSchema = z.string().regex(/^(0|[1-9][0-9]*)$/)
const positiveDecimalSchema = z.string().regex(/^[1-9][0-9]*$/)
const timestampSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)))
const nonEmptyStringSchema = z.string().min(1)
const statusSchema = z.enum(['ACTIVE', 'INACTIVE'])
const priceSchema = z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/)
const entityTypeSchema = z.enum([
  'workers',
  'worker_badge_history',
  'models',
  'model_operations',
  'model_operation_prices',
  'patta_templates',
  'patta_hisob',
  'patta_operation_snapshots',
  'patta_number_blocks',
  'patta_partiya_number_blocks',
  'patta_print_batches',
  'patta_print_batch_sizes',
  'patta_print_events',
  'patta_sheets',
  'patta_sheet_operation_snapshots',
  'patta_sheet_rows',
  'model_account_adjustments'
])

const workerDataSchema = z
  .object({
    id: nonEmptyStringSchema,
    full_name: nonEmptyStringSchema,
    status: statusSchema,
    version: positiveDecimalSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema
  })
  .strict()

const badgeDataSchema = z
  .object({
    id: nonEmptyStringSchema,
    badge_number: nonEmptyStringSchema,
    worker_id: nonEmptyStringSchema,
    valid_from: timestampSchema,
    valid_to: timestampSchema.nullable(),
    created_at: timestampSchema
  })
  .strict()

const modelDataSchema = z
  .object({
    id: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    status: statusSchema,
    version: positiveDecimalSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema
  })
  .strict()

const operationDataSchema = z
  .object({
    id: nonEmptyStringSchema,
    model_id: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    sort_order: z.number().int().nonnegative(),
    status: statusSchema,
    version: positiveDecimalSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema
  })
  .strict()

const priceDataSchema = z
  .object({
    id: nonEmptyStringSchema,
    operation_id: nonEmptyStringSchema,
    price: priceSchema,
    valid_from: timestampSchema,
    valid_to: timestampSchema.nullable(),
    created_at: timestampSchema
  })
  .strict()

const templateDataSchema = z
  .object({
    id: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    model_id: nonEmptyStringSchema,
    konveyer: nonEmptyStringSchema,
    razmer: nonEmptyStringSchema.nullable(),
    rang: nonEmptyStringSchema.nullable(),
    status: statusSchema,
    version: positiveDecimalSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema
  })
  .strict()

const pattaDataSchema = z
  .object({
    id: nonEmptyStringSchema,
    partiya_number: nonEmptyStringSchema,
    patta_number: positiveDecimalSchema,
    model_id: nonEmptyStringSchema,
    model_name_snapshot: nonEmptyStringSchema,
    template_id: nonEmptyStringSchema.nullable(),
    konveyer_snapshot: nonEmptyStringSchema,
    razmer: nonEmptyStringSchema.nullable(),
    rang: nonEmptyStringSchema.nullable(),
    ish_soni: z.number().int().positive(),
    created_device_id: nonEmptyStringSchema,
    created_from_block_id: nonEmptyStringSchema.nullable(),
    created_at: timestampSchema,
    client_created_at: timestampSchema.nullable(),
    occurred_at: timestampSchema.nullable()
  })
  .strict()

const snapshotDataSchema = z
  .object({
    id: nonEmptyStringSchema,
    patta_hisob_id: nonEmptyStringSchema,
    operation_id: nonEmptyStringSchema,
    operation_name_snapshot: nonEmptyStringSchema,
    unit_price_snapshot: priceSchema,
    sort_order: z.number().int().nonnegative(),
    created_at: timestampSchema
  })
  .strict()

const pattaNumberBlockDataSchema = z
  .object({
    id: nonEmptyStringSchema,
    device_id: nonEmptyStringSchema,
    range_start: positiveDecimalSchema,
    range_end: positiveDecimalSchema,
    reported_used_count: decimalCursorSchema,
    status: z.enum(['ACTIVE', 'EXHAUSTED', 'CANCELLED']),
    allocated_at: timestampSchema,
    exhausted_at: timestampSchema.nullable()
  })
  .strict()

const pattaV2DataSchema = z
  .object({
    id: nonEmptyStringSchema,
    partiya_number: nonEmptyStringSchema,
    patta_number: positiveDecimalSchema,
    model_id: nonEmptyStringSchema,
    model_name_snapshot: nonEmptyStringSchema,
    template_id: nonEmptyStringSchema.nullable(),
    konveyer_snapshot: nonEmptyStringSchema.nullable(),
    razmer: nonEmptyStringSchema.nullable(),
    rang: nonEmptyStringSchema.nullable(),
    ish_soni: z.number().int().positive().nullable(),
    legacy_operation_count: z.number().int().positive().nullable(),
    status: z.enum(['ACTIVE', 'VOID']),
    print_batch_id: nonEmptyStringSchema.nullable(),
    created_device_id: nonEmptyStringSchema,
    created_from_block_id: nonEmptyStringSchema.nullable(),
    created_at: timestampSchema,
    client_created_at: timestampSchema.nullable(),
    occurred_at: timestampSchema.nullable()
  })
  .strict()

const operationSnapshotV2Schema = z
  .object({
    id: nonEmptyStringSchema,
    patta_hisob_id: nonEmptyStringSchema,
    operation_id: nonEmptyStringSchema,
    operation_name_snapshot: nonEmptyStringSchema,
    unit_price_snapshot: priceSchema,
    sort_order: z.number().int().nonnegative(),
    created_at: timestampSchema
  })
  .strict()

const pattaPrintBatchSizeSchema = z
  .object({
    id: nonEmptyStringSchema,
    print_batch_id: nonEmptyStringSchema,
    razmer: nonEmptyStringSchema,
    patta_count: z.number().int().positive(),
    sort_order: z.number().int().nonnegative()
  })
  .strict()

const pattaPrintBatchPattaSchema = pattaV2DataSchema.extend({
  version: positiveDecimalSchema,
  operations: z.array(operationSnapshotV2Schema).min(1)
}).strict()

const pattaPrintBatchDataSchema = z
  .object({
    id: nonEmptyStringSchema,
    model_id: nonEmptyStringSchema,
    model_name_snapshot: nonEmptyStringSchema,
    partiya_number: positiveDecimalSchema,
    partiya_block_id: nonEmptyStringSchema.nullable(),
    ish_soni: z.number().int().positive(),
    rang: nonEmptyStringSchema,
    status: z.enum(['ACTIVE', 'VOID', 'SUPERSEDED']),
    version: positiveDecimalSchema,
    revision: z.number().int().positive(),
    corrected_from_batch_id: nonEmptyStringSchema.nullable(),
    created_by: nonEmptyStringSchema.nullable(),
    created_device_id: nonEmptyStringSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema,
    printed_at: timestampSchema.nullable(),
    size_distribution: z.array(pattaPrintBatchSizeSchema).min(1),
    pattas: z.array(pattaPrintBatchPattaSchema).min(1)
  })
  .strict()

const pattaV2LookupMirrorSchema = z.object({
  server_sequence: decimalCursorSchema,
  patta: pattaPrintBatchPattaSchema,
  batch: pattaPrintBatchDataSchema.nullable()
}).strict().superRefine((mirror, context) => {
  if (mirror.batch && !mirror.batch.pattas.some((patta) => patta.id === mirror.patta.id)) {
    context.addIssue({ code: 'custom', message: 'Lookup Patta is absent from its batch projection' })
  }
  if (mirror.patta.print_batch_id !== (mirror.batch?.id ?? null)) {
    context.addIssue({ code: 'custom', message: 'Lookup Patta batch identity does not match the batch projection' })
  }
})

const partiyaNumberBlockDataSchema = z
  .object({
    id: nonEmptyStringSchema,
    device_id: nonEmptyStringSchema,
    range_start: positiveDecimalSchema,
    range_end: positiveDecimalSchema,
    reported_used_count: decimalCursorSchema,
    status: z.enum(['ACTIVE', 'EXHAUSTED', 'CANCELLED']),
    allocated_at: timestampSchema,
    exhausted_at: timestampSchema.nullable()
  })
  .strict()

const pattaPrintEventDataSchema = z
  .object({
    id: nonEmptyStringSchema,
    batch_id: nonEmptyStringSchema,
    revision: z.number().int().positive(),
    kind: z.enum(['INITIAL', 'REPRINT', 'CORRECTED_REPRINT']),
    outcome: z.enum(['REQUESTED', 'SUCCEEDED', 'FAILED']),
    actor_user_id: nonEmptyStringSchema.nullable(),
    device_id: nonEmptyStringSchema,
    created_at: timestampSchema,
    printed_at: timestampSchema.nullable()
  })
  .strict()

const pattaSheetOperationSnapshotSchema = z.object({
  id: nonEmptyStringSchema,
  patta_sheet_id: nonEmptyStringSchema,
  model_operation_id: nonEmptyStringSchema,
  source_type: z.enum(['PATTA', 'CUSTOM']),
  source_patta_operation_snapshot_id: nonEmptyStringSchema.nullable(),
  operation_name_snapshot: nonEmptyStringSchema,
  unit_price_snapshot: priceSchema,
  sort_order: z.number().int().nonnegative(),
  created_at: timestampSchema
}).strict()

const pattaSheetRowSchema = z.object({
  id: nonEmptyStringSchema,
  patta_sheet_id: nonEmptyStringSchema,
  patta_sheet_operation_snapshot_id: nonEmptyStringSchema,
  worker_id: positiveDecimalSchema,
  quantity_snapshot: z.number().int().positive(),
  nuqson: z.boolean(),
  deleted_at: timestampSchema.nullable(),
  deleted_by: nonEmptyStringSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema
}).strict()

const pattaSheetDataSchema = z.object({
  id: nonEmptyStringSchema,
  patta_hisob_id: nonEmptyStringSchema,
  entered_at: timestampSchema,
  business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  conveyor_snapshot: nonEmptyStringSchema.nullable(),
  version: positiveDecimalSchema,
  created_by: nonEmptyStringSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  deleted_at: timestampSchema.nullable(),
  deleted_by: nonEmptyStringSchema.nullable(),
  operation_snapshots: z.array(pattaSheetOperationSnapshotSchema).min(1),
  rows: z.array(pattaSheetRowSchema)
}).strict()

const pattaSheetOperationSnapshotV3Schema = z.object({
  id: nonEmptyStringSchema,
  patta_sheet_id: nonEmptyStringSchema,
  model_operation_id: nonEmptyStringSchema,
  source_type: z.enum(['PATTA', 'MODEL', 'CUSTOM']),
  source_patta_operation_snapshot_id: nonEmptyStringSchema.nullable(),
  operation_name_snapshot: nonEmptyStringSchema,
  unit_price_snapshot: priceSchema,
  sort_order: z.number().int().nonnegative(),
  created_at: timestampSchema
}).strict()

const pattaSheetDataV3Schema = z.object({
  id: nonEmptyStringSchema,
  entry_kind: z.enum(['PATTA_LINKED', 'STANDALONE']),
  patta_hisob_id: nonEmptyStringSchema.nullable(),
  model_id: nonEmptyStringSchema,
  model_name_snapshot: nonEmptyStringSchema,
  ish_soni: z.number().int().positive(),
  partiya_number_snapshot: nonEmptyStringSchema.nullable(),
  patta_number_snapshot: positiveDecimalSchema.nullable(),
  rang_snapshot: nonEmptyStringSchema.nullable(),
  razmer_snapshot: nonEmptyStringSchema.nullable(),
  entered_at: timestampSchema,
  business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  conveyor_snapshot: nonEmptyStringSchema.nullable(),
  version: positiveDecimalSchema,
  created_by: nonEmptyStringSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  deleted_at: timestampSchema.nullable(),
  deleted_by: nonEmptyStringSchema.nullable(),
  deleted_by_name_snapshot: nonEmptyStringSchema.nullable(),
  operation_snapshots: z.array(pattaSheetOperationSnapshotV3Schema).min(1),
  rows: z.array(pattaSheetRowSchema)
}).strict().superRefine((sheet, context) => {
  if ((sheet.entry_kind === 'PATTA_LINKED') !== (sheet.patta_hisob_id !== null)) {
    context.addIssue({ code: 'custom', message: 'Patta Entry kind does not match its Patta identity' })
  }
  if ((sheet.deleted_at === null) !== (sheet.deleted_by === null) ||
    (sheet.deleted_at === null && sheet.deleted_by_name_snapshot !== null)) {
    context.addIssue({ code: 'custom', message: 'Patta Entry deletion metadata is inconsistent' })
  }
  for (const snapshot of sheet.operation_snapshots) {
    if ((snapshot.source_type === 'PATTA') !== (snapshot.source_patta_operation_snapshot_id !== null) ||
      (snapshot.source_type === 'PATTA' && sheet.entry_kind !== 'PATTA_LINKED') ||
      (snapshot.source_type === 'MODEL' && sheet.entry_kind !== 'STANDALONE')) {
      context.addIssue({ code: 'custom', message: 'Patta Entry operation source is inconsistent' })
    }
  }
  if (sheet.rows.some((row) => row.quantity_snapshot !== sheet.ish_soni)) {
    context.addIssue({ code: 'custom', message: 'Patta Entry row quantity differs from its header quantity' })
  }
})

const projectionV1Schema = z
  .discriminatedUnion('entity_type', [
    z
      .object({
        projection_version: z.literal(1),
        entity_type: z.literal('workers'),
        entity_id: nonEmptyStringSchema,
        entity_version: positiveDecimalSchema,
        data: workerDataSchema
      })
      .strict(),
    z
      .object({
        projection_version: z.literal(1),
        entity_type: z.literal('worker_badge_history'),
        entity_id: nonEmptyStringSchema,
        entity_version: z.null(),
        data: badgeDataSchema
      })
      .strict(),
    z
      .object({
        projection_version: z.literal(1),
        entity_type: z.literal('models'),
        entity_id: nonEmptyStringSchema,
        entity_version: positiveDecimalSchema,
        data: modelDataSchema
      })
      .strict(),
    z
      .object({
        projection_version: z.literal(1),
        entity_type: z.literal('model_operations'),
        entity_id: nonEmptyStringSchema,
        entity_version: positiveDecimalSchema,
        data: operationDataSchema
      })
      .strict(),
    z
      .object({
        projection_version: z.literal(1),
        entity_type: z.literal('model_operation_prices'),
        entity_id: nonEmptyStringSchema,
        entity_version: z.null(),
        data: priceDataSchema
      })
      .strict(),
    z
      .object({
        projection_version: z.literal(1),
        entity_type: z.literal('patta_templates'),
        entity_id: nonEmptyStringSchema,
        entity_version: positiveDecimalSchema,
        data: templateDataSchema
      })
      .strict(),
    z
      .object({
        projection_version: z.literal(1),
        entity_type: z.literal('patta_hisob'),
        entity_id: nonEmptyStringSchema,
        entity_version: positiveDecimalSchema,
        data: pattaDataSchema
      })
      .strict(),
    z
      .object({
        projection_version: z.literal(1),
        entity_type: z.literal('patta_operation_snapshots'),
        entity_id: nonEmptyStringSchema,
        entity_version: z.null(),
        data: snapshotDataSchema
      })
      .strict(),
    z
      .object({
        projection_version: z.literal(1),
        entity_type: z.literal('patta_number_blocks'),
        entity_id: nonEmptyStringSchema,
        entity_version: z.null(),
        data: pattaNumberBlockDataSchema
      })
      .strict()
  ])
  .superRefine((projection, context) => {
    if (projection.entity_id !== projection.data.id) {
      context.addIssue({
        code: 'custom',
        message: 'Projection entity ID does not match its data ID'
      })
    }
  })

const projectionV2Schema = z.discriminatedUnion('entity_type', [
  z.object({
    projection_version: z.literal(2), entity_type: z.literal('patta_hisob'),
    entity_id: nonEmptyStringSchema, entity_version: positiveDecimalSchema, data: pattaV2DataSchema
  }).strict(),
  z.object({
    projection_version: z.literal(2), entity_type: z.literal('patta_operation_snapshots'),
    entity_id: nonEmptyStringSchema, entity_version: z.null(), data: operationSnapshotV2Schema
  }).strict(),
  z.object({
    projection_version: z.literal(2), entity_type: z.literal('patta_partiya_number_blocks'),
    entity_id: nonEmptyStringSchema, entity_version: z.null(), data: partiyaNumberBlockDataSchema
  }).strict(),
  z.object({
    projection_version: z.literal(2), entity_type: z.literal('patta_print_batches'),
    entity_id: nonEmptyStringSchema, entity_version: positiveDecimalSchema, data: pattaPrintBatchDataSchema
  }).strict(),
  z.object({
    projection_version: z.literal(2), entity_type: z.literal('patta_print_batch_sizes'),
    entity_id: nonEmptyStringSchema, entity_version: z.null(), data: pattaPrintBatchSizeSchema
  }).strict(),
  z.object({
    projection_version: z.literal(2), entity_type: z.literal('patta_print_events'),
    entity_id: nonEmptyStringSchema, entity_version: z.null(), data: pattaPrintEventDataSchema
  }).strict(),
  z.object({
    projection_version: z.literal(2), entity_type: z.literal('patta_sheets'),
    entity_id: nonEmptyStringSchema, entity_version: positiveDecimalSchema, data: pattaSheetDataSchema
  }).strict(),
  z.object({
    projection_version: z.literal(2), entity_type: z.literal('patta_sheet_operation_snapshots'),
    entity_id: nonEmptyStringSchema, entity_version: z.null(), data: pattaSheetOperationSnapshotSchema
  }).strict(),
  z.object({
    projection_version: z.literal(2), entity_type: z.literal('patta_sheet_rows'),
    entity_id: nonEmptyStringSchema, entity_version: z.null(), data: pattaSheetRowSchema
  }).strict(),
  z.object({
    projection_version: z.literal(2), entity_type: z.literal('model_operations'),
    entity_id: nonEmptyStringSchema, entity_version: positiveDecimalSchema, data: operationDataSchema
  }).strict()
]).superRefine((projection, context) => {
  if (projection.entity_id !== projection.data.id) {
    context.addIssue({ code: 'custom', message: 'Projection entity ID does not match its data ID' })
  }
})

const modelAccountAdjustmentDataSchema = z.object({
  id: nonEmptyStringSchema,
  model_id: nonEmptyStringSchema,
  model_operation_id: nonEmptyStringSchema,
  worker_id: positiveDecimalSchema,
  quantity: z.number().int().positive(),
  unit_price_snapshot: priceSchema,
  entered_at: timestampSchema,
  business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  version: positiveDecimalSchema,
  created_by: nonEmptyStringSchema.nullable(),
  created_device_id: nonEmptyStringSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  deleted_at: timestampSchema.nullable(),
  deleted_by: nonEmptyStringSchema.nullable()
}).strict().refine((adjustment) => (adjustment.deleted_at === null) === (adjustment.deleted_by === null), {
  message: 'Manual adjustment deletion metadata is inconsistent'
})

const projectionV3Schema = z.union([
  z.object({
    projection_version: z.literal(3), entity_type: z.literal('patta_sheets'),
    entity_id: nonEmptyStringSchema, entity_version: positiveDecimalSchema, data: pattaSheetDataV3Schema
  }).strict(),
  z.object({
    projection_version: z.literal(3), entity_type: z.literal('model_account_adjustments'),
    entity_id: nonEmptyStringSchema, entity_version: positiveDecimalSchema, data: modelAccountAdjustmentDataSchema
  }).strict()
]).superRefine((projection, context) => {
  if (projection.entity_id !== projection.data.id) {
    context.addIssue({ code: 'custom', message: 'Projection entity ID does not match its data ID' })
  }
})

const projectionSchema = z.union([projectionV1Schema, projectionV2Schema, projectionV3Schema])

const changeSchema = z
  .object({
    sequence_id: positiveDecimalSchema,
    entity_type: entityTypeSchema,
    entity_id: nonEmptyStringSchema,
    operation: z.enum(['UPSERT', 'DELETE']),
    entity_version: positiveDecimalSchema.nullable(),
    projection_version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    payload: projectionSchema.nullable(),
    changed_at: timestampSchema
  })
  .strict()
  .superRefine((change, context) => {
    if (change.operation === 'UPSERT' && change.payload === null) {
      context.addIssue({ code: 'custom', message: 'UPSERT change must include a projection' })
    }
    if (
      change.payload !== null &&
      (change.payload.entity_id !== change.entity_id ||
        change.payload.entity_type !== change.entity_type ||
        change.payload.projection_version !== change.projection_version)
    ) {
      context.addIssue({ code: 'custom', message: 'Change identity does not match its projection' })
    }
  })

const pushResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      event_id: z.string().uuid(),
      status: z.literal('SYNCED'),
      entity_version: positiveDecimalSchema.nullable(),
      projection: projectionSchema.nullable(),
      change_sequence: positiveDecimalSchema
    })
    .strict(),
  z
    .object({
      event_id: z.string().uuid().nullable(),
      status: z.literal('CONFLICT'),
      conflict: z
        .object({
          code: nonEmptyStringSchema,
          message: z.string(),
          details: z.record(z.string(), z.unknown()),
          local_payload: z.unknown(),
          server_payload: z.unknown()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      event_id: z.string().uuid().nullable(),
      status: z.literal('FAILED'),
      error: z
        .object({
          code: nonEmptyStringSchema,
          message: z.string(),
          details: z.record(z.string(), z.unknown())
        })
        .strict()
    })
    .strict()
])

const pullResponseSchema = z
  .object({
    changes: z.array(changeSchema),
    next_cursor: decimalCursorSchema,
    has_more: z.boolean()
  })
  .strict()
  .superRefine((response, context) => {
    const lastSequence = response.changes.at(-1)?.sequence_id
    if (lastSequence !== undefined && response.next_cursor !== lastSequence) {
      context.addIssue({
        code: 'custom',
        message: 'Pull cursor must equal the last returned change'
      })
    }
    if (response.has_more && response.changes.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'A pull page with more data must contain a change'
      })
    }
  })

const bootstrapSessionSchema = z
  .object({
    id: z.string().uuid(),
    device_id: z.string().uuid(),
    watermark: decimalCursorSchema,
    status: z.literal('ACTIVE'),
    expires_at: timestampSchema
  })
  .strict()

const bootstrapPageSchema = z
  .object({
    session_id: z.string().uuid(),
    watermark: decimalCursorSchema,
    items: z.array(
      z
        .object({
          order_key: positiveDecimalSchema,
          projection: projectionSchema
        })
        .strict()
    ),
    next_order_key: positiveDecimalSchema.nullable(),
    has_more: z.boolean()
  })
  .strict()
  .superRefine((page, context) => {
    const finalOrderKey = page.items.at(-1)?.order_key ?? null
    if (page.next_order_key !== finalOrderKey) {
      context.addIssue({
        code: 'custom',
        message: 'Bootstrap order cursor must match the last item'
      })
    }
    if (page.has_more && page.items.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'A bootstrap page with more data must contain an item'
      })
    }
  })

const bootstrapCompleteSchema = z
  .object({
    session_id: z.string().uuid(),
    status: z.literal('COMPLETED')
  })
  .strict()

const numberBlockSchema = z
  .object({
    id: z.string().uuid(),
    device_id: z.string().uuid(),
    range_start: positiveDecimalSchema,
    range_end: positiveDecimalSchema,
    reported_used_count: decimalCursorSchema,
    status: z.enum(['ACTIVE', 'EXHAUSTED', 'CANCELLED']),
    allocated_at: timestampSchema,
    exhausted_at: timestampSchema.nullable(),
    created_by: z.string().uuid().nullable().optional()
  })
  .strict()
  .transform((block) => ({
    id: block.id,
    device_id: block.device_id,
    range_start: block.range_start,
    range_end: block.range_end,
    reported_used_count: block.reported_used_count,
    status: block.status,
    allocated_at: block.allocated_at,
    exhausted_at: block.exhausted_at
  }))

export class SyncProtocolValidationError extends Error {
  constructor(label: string) {
    super(`Authenticated sync response failed validation: ${label}`)
    this.name = 'SyncProtocolValidationError'
  }
}

function validated<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new SyncProtocolValidationError(label)
  return result.data
}

export function parseSyncProjection(input: unknown): SyncProjectionV3 {
  return validated(projectionSchema, input, 'projection') as SyncProjectionV3
}

export function parseSyncChange(input: unknown): SyncChange {
  return validated(changeSchema, input, 'change') as SyncChange
}

export function parseSyncPullResponse(input: unknown): SyncPullResponse {
  return validated(pullResponseSchema, input, 'pull response') as SyncPullResponse
}

export function parseSyncPushResponse(input: unknown): SyncPushResponse {
  const response = validated(
    z.object({ results: z.array(pushResultSchema) }).strict(),
    input,
    'push response'
  )
  return response as unknown as SyncPushResponse
}

export function parseSyncBootstrapSession(input: unknown): SyncBootstrapSession {
  return validated(bootstrapSessionSchema, input, 'bootstrap session') as SyncBootstrapSession
}

export function parseSyncBootstrapPage(input: unknown): SyncBootstrapPage {
  return validated(bootstrapPageSchema, input, 'bootstrap page') as SyncBootstrapPage
}

export function parseSyncBootstrapComplete(input: unknown): SyncBootstrapCompleteResponse {
  return validated(
    bootstrapCompleteSchema,
    input,
    'bootstrap completion'
  ) as SyncBootstrapCompleteResponse
}

export function parsePattaNumberBlock(input: unknown): PattaNumberBlockProjection {
  return validated(numberBlockSchema, input, 'Patta number block') as PattaNumberBlockProjection
}

export function parsePattaPartiyaNumberBlock(input: unknown): PattaPartiyaNumberBlockProjection {
  return validated(numberBlockSchema, input, 'Partiya number block') as PattaPartiyaNumberBlockProjection
}

export function parsePattaV2LookupMirror(input: unknown): PattaV2LookupMirror {
  return validated(pattaV2LookupMirrorSchema, input, 'Patta v2 lookup mirror') as PattaV2LookupMirror
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
