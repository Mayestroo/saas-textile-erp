import { ConflictException, Injectable } from '@nestjs/common';
import type { SyncEvent, SyncMutationOperation, SyncProjection } from '@textile/sync-protocol';
import type { EntityManager } from 'typeorm';
import { createSyncProjection } from './sync-projections.js';
import { OperationsService } from '../operations/operations.service.js';
import type { SyncApplyContext, SyncEntityHandler, SyncHandlerResult } from './sync-entity-handler.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EFFECTIVE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ModelOperationCreatePayload {
  id: string;
  model_id: string;
  name: string;
  initial_price: string;
  sort_order: number;
  effective_from: string;
}

function parsePayload(value: unknown, eventId: string): ModelOperationCreatePayload {
  if (!isRecord(value) || Object.keys(value).some((field) => ![
    'id', 'model_id', 'name', 'initial_price', 'sort_order', 'effective_from',
  ].includes(field))) {
    throw new ConflictException({ code: 'PAYLOAD_INVALID', message: 'Yangi model operatsiyasi ma’lumoti noto‘g‘ri', details: {} });
  }
  const { id, model_id: modelId, name, initial_price: initialPrice, sort_order: sortOrder, effective_from: effectiveFrom } = value;
  if (typeof id !== 'string' || !UUID_PATTERN.test(id) || id.toLowerCase() !== eventId.toLowerCase() ||
    typeof modelId !== 'string' || !UUID_PATTERN.test(modelId) ||
    typeof name !== 'string' || typeof initialPrice !== 'string' ||
    typeof sortOrder !== 'number' || !Number.isSafeInteger(sortOrder) ||
    typeof effectiveFrom !== 'string' || !EFFECTIVE_TIMESTAMP.test(effectiveFrom) || !Number.isFinite(Date.parse(effectiveFrom))) {
    throw new ConflictException({ code: 'PAYLOAD_INVALID', message: 'Yangi model operatsiyasi maydonlari noto‘g‘ri', details: {} });
  }
  return {
    id: id.toLowerCase(), model_id: modelId.toLowerCase(), name,
    initial_price: initialPrice, sort_order: sortOrder, effective_from: effectiveFrom,
  };
}

@Injectable()
export class ModelOperationSyncHandler implements SyncEntityHandler {
  constructor(private readonly operations: OperationsService) {}

  supports(entityType: string, operation: SyncMutationOperation): boolean {
    return entityType === 'model_operation' && operation === 'CREATE';
  }

  async apply(manager: EntityManager, context: SyncApplyContext, event: SyncEvent): Promise<SyncHandlerResult> {
    if ((context.protocolVersion !== 2 && context.protocolVersion !== 3) || event.base_version !== '0' || !event.entity_id) {
      throw new ConflictException({ code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED', message: 'Yangi model operatsiyasini sinxronlash uchun v2 kerak', details: {} });
    }
    const input = parsePayload(event.payload, event.entity_id);
    const operation = await this.operations.createForPattaSheetInTransaction(
      manager, input.model_id, context.actorUserId, context.validatedDeviceId, input,
    );
    if (operation.id !== event.entity_id.toLowerCase()) {
      throw new ConflictException({
        code: 'MODEL_OPERATION_CANONICAL_NAME_CONFLICT',
        message: 'Shu nomdagi faol operatsiya serverda boshqa identifikatorga ega',
        details: { model_operation_id: operation.id },
      });
    }
    const projection: SyncProjection = createSyncProjection({
      entityType: 'model_operations',
      entityVersion: operation.version,
      data: {
        id: operation.id,
        model_id: operation.model_id,
        name: operation.name,
        sort_order: operation.sort_order,
        status: operation.status,
        version: operation.version,
        created_at: operation.created_at,
        updated_at: operation.updated_at,
      },
    });
    const changes: Array<{ sequence_id: string }> = await manager.query(
      `SELECT "sequence_id"::text AS "sequence_id" FROM "server_change_log"
       WHERE ("entity_type" = 'model_operations' AND "entity_id" = $1) OR
         ("entity_type" = 'model_operation_prices' AND "payload_json" #>> '{data,operation_id}' = $1)
       ORDER BY "sequence_id" DESC LIMIT 1`,
      [operation.id],
    );
    const changeSequence = changes[0]?.sequence_id;
    if (!changeSequence) throw new Error('Custom operation sync did not record a change sequence');
    return { entityVersion: operation.version, projection, changeSequence };
  }
}
