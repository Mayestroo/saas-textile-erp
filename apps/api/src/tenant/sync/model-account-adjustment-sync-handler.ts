import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type {
  ModelAccountAdjustmentMutationPayload,
  SyncEvent,
  SyncMutationOperation,
  SyncProjectionV3,
} from '@textile/sync-protocol';
import type { EntityManager } from 'typeorm';
import { isIanaTimezone } from '../../common/time/iana-timezone.js';
import { ModelAccountAdjustmentsService } from '../patta-sheets/model-account-adjustments.service.js';
import { ModelAccountAdjustmentInputDto } from '../patta-sheets/dto/model-account-adjustment-input.dto.js';
import type { SyncApplyContext, SyncEntityHandler, SyncHandlerResult } from './sync-entity-handler.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function payloadRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ConflictException({
    code: 'PAYLOAD_INVALID', message: 'Model hisob hodisasi obyekti noto‘g‘ri', details: {},
  });
  return value;
}

function validateDto<T extends object>(type: new () => T, value: unknown): T {
  const instance = plainToInstance(type, value);
  const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
  if (errors.length > 0) {
    throw new ConflictException({
      code: 'PAYLOAD_INVALID',
      message: 'Model hisob hodisasi maydonlari noto‘g‘ri',
      details: { fields: errors.map(({ property }) => property) },
    });
  }
  return instance;
}

async function assertManagePermission(manager: EntityManager, actorUserId: string): Promise<void> {
  const rows: Array<{ allowed: boolean }> = await manager.query(
    `SELECT EXISTS (
       SELECT 1 FROM "users" user_account
       JOIN "roles" role ON role."id" = user_account."role_id"
       JOIN "role_permissions" assignment ON assignment."role_id" = role."id"
       JOIN "permissions" permission ON permission."id" = assignment."permission_id"
       WHERE user_account."id" = $1::uuid AND user_account."status" = 'ACTIVE'
         AND permission."code" = 'patta.hisob.manual_manage'
     ) AS "allowed"`,
    [actorUserId],
  );
  if (rows[0]?.allowed !== true) {
    throw new ConflictException({
      code: 'SYNC_PERMISSION_REQUIRED',
      message: 'Model hisobiga qo‘lda yozuv qo‘shish huquqi yo‘q',
      details: { permission: 'patta.hisob.manual_manage' },
    });
  }
}

async function assertDependenciesSynced(manager: EntityManager, payload: Record<string, unknown>): Promise<void> {
  const dependencies = payload['depends_on_event_ids'] ?? [];
  if (!Array.isArray(dependencies) || dependencies.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id))) {
    throw new ConflictException({ code: 'PAYLOAD_INVALID', message: 'Bog‘liq sinxronlash hodisalari yaroqsiz', details: {} });
  }
  if (dependencies.length === 0) return;
  const rows: Array<{ count: string }> = await manager.query(
    `SELECT count(*)::text AS "count" FROM "processed_sync_events"
     WHERE "event_id" = ANY($1::uuid[]) AND "entity_type" = 'model_operation'
       AND "result_status" = 'SYNCED'`,
    [dependencies],
  );
  if (BigInt(rows[0]?.count ?? '0') !== BigInt(dependencies.length)) {
    throw new ConflictException({
      code: 'MODEL_OPERATION_DEPENDENCY_NOT_SYNCED',
      message: 'Model operatsiyasi avval sinxronlanishi kerak',
      details: { depends_on_event_ids: dependencies },
    });
  }
}

function projection(data: Awaited<ReturnType<ModelAccountAdjustmentsService['getProjection']>>): SyncProjectionV3 {
  return {
    projection_version: 3,
    entity_type: 'model_account_adjustments',
    entity_id: data.id,
    entity_version: data.version,
    data,
  };
}

@Injectable()
export class ModelAccountAdjustmentSyncHandler implements SyncEntityHandler {
  constructor(@Inject(ModelAccountAdjustmentsService) private readonly adjustments: ModelAccountAdjustmentsService) {}

  supports(entityType: string, operation: SyncMutationOperation): boolean {
    return entityType === 'model_account_adjustment' && (operation === 'CREATE' || operation === 'UPDATE');
  }

  async apply(manager: EntityManager, context: SyncApplyContext, event: SyncEvent): Promise<SyncHandlerResult> {
    if (context.protocolVersion !== 3) {
      throw new ConflictException({
        code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED',
        message: 'Qo‘lda Model hisob yozuvlari uchun dasturni yangilang',
        details: {},
      });
    }
    if (!context.timezone || !isIanaTimezone(context.timezone)) {
      throw new ConflictException({
        code: 'TENANT_TIMEZONE_UNAVAILABLE',
        message: 'Model hisob yozuvi uchun korxona vaqt mintaqasi kerak',
        details: {},
      });
    }
    if (!event.entity_id || !UUID_PATTERN.test(event.entity_id)) {
      throw new ConflictException({ code: 'PAYLOAD_INVALID', message: 'Qo‘shimcha identifikatori yaroqsiz', details: {} });
    }
    const rawPayload = payloadRecord(event.payload);
    await assertDependenciesSynced(manager, rawPayload);
    const validated = validateDto(ModelAccountAdjustmentInputDto, rawPayload);
    const payload: ModelAccountAdjustmentMutationPayload = {
      ...validated,
      deleted_at: validated.deleted_at ?? null,
      deleted_by: validated.deleted_by ?? null,
    };
    if (event.operation === 'CREATE') {
      await assertManagePermission(manager, context.actorUserId);
      if (event.base_version !== '0') {
        throw new ConflictException({ code: 'PAYLOAD_INVALID', message: 'CREATE hodisasi versiyasi noto‘g‘ri', details: {} });
      }
      const result = await this.adjustments.createInTransaction(
        manager, context.actorUserId, context.validatedDeviceId, context.timezone,
        event.entity_id, payload,
      );
      return {
        entityVersion: result.version,
        projection: projection(result),
        changeSequence: await this.adjustments.latestChangeSequence(manager, result.id),
      };
    }
    if (event.base_version === null || !/^[1-9][0-9]*$/.test(event.base_version)) {
      throw new ConflictException({ code: 'PAYLOAD_INVALID', message: 'Qo‘shimcha versiyasi yaroqsiz', details: {} });
    }
    await assertManagePermission(manager, context.actorUserId);
    const current = await this.adjustments.getProjection(manager, event.entity_id);
    const requestedDeletedAt = payload.deleted_at;
    if (current.deleted_at === null && requestedDeletedAt !== null) {
      if (payload.deleted_by !== context.actorUserId) {
        throw new ConflictException({ code: 'PAYLOAD_INVALID', message: 'O‘chirgan foydalanuvchi hodisa muallifiga mos emas', details: {} });
      }
      const trashed = await this.adjustments.setTrashedInTransaction(
        manager, context.actorUserId, context.validatedDeviceId, event.entity_id,
        event.base_version, true, requestedDeletedAt,
      );
      return {
        entityVersion: trashed.version,
        projection: projection(trashed),
        changeSequence: await this.adjustments.latestChangeSequence(manager, trashed.id),
      };
    }
    if (current.deleted_at !== null && requestedDeletedAt === null) {
      const restored = await this.adjustments.setTrashedInTransaction(
        manager, context.actorUserId, context.validatedDeviceId, event.entity_id,
        event.base_version, false,
      );
      return {
        entityVersion: restored.version,
        projection: projection(restored),
        changeSequence: await this.adjustments.latestChangeSequence(manager, restored.id),
      };
    }
    const updated = await this.adjustments.updateInTransaction(
      manager, context.actorUserId, context.validatedDeviceId, event.entity_id,
      event.base_version, payload,
    );
    return {
      entityVersion: updated.version,
      projection: projection(updated),
      changeSequence: await this.adjustments.latestChangeSequence(manager, updated.id),
    };
  }
}
