import { z } from 'zod'
import type {
  PattaNumberBlockProjection,
  SyncBootstrapCompleteResponse,
  SyncBootstrapPage,
  SyncBootstrapSession,
  SyncChange,
  SyncProjection,
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
  'patta_number_blocks'
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

const projectionSchema = z
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

const changeSchema = z
  .object({
    sequence_id: positiveDecimalSchema,
    entity_type: entityTypeSchema,
    entity_id: nonEmptyStringSchema,
    operation: z.enum(['UPSERT', 'DELETE']),
    entity_version: positiveDecimalSchema.nullable(),
    projection_version: z.literal(1),
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
        change.payload.entity_type !== change.entity_type)
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
      projection: projectionSchema,
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

export function parseSyncProjection(input: unknown): SyncProjection {
  return validated(projectionSchema, input, 'projection') as SyncProjection
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
