import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { SyncEvent, SyncMutationOperation, SyncProjectionV2, SyncProjectionV3 } from '@textile/sync-protocol';
import type { EntityManager } from 'typeorm';
import { isIanaTimezone } from '../../common/time/iana-timezone.js';
import { CreatePattaSheetDto, UpdatePattaSheetDto } from '../patta-sheets/dto/patta-sheet-input.dto.js';
import { CreatePattaSheetV3Dto, UpdatePattaSheetV3Dto } from '../patta-sheets/dto/patta-sheet-v3-input.dto.js';
import { PattaSheetsService } from '../patta-sheets/patta-sheets.service.js';
import type { SyncApplyContext, SyncEntityHandler, SyncHandlerResult } from './sync-entity-handler.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function payloadRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ConflictException({
    code: 'PAYLOAD_INVALID', message: 'Patta varag‘i hodisasi obyekti noto‘g‘ri', details: {},
  });
  return value;
}

function validateDto<T extends object>(type: new () => T, value: unknown): T {
  const instance = plainToInstance(type, value);
  const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
  if (errors.length > 0) {
    throw new ConflictException({
      code: 'PAYLOAD_INVALID',
      message: 'Patta varag‘i hodisasi maydonlari noto‘g‘ri',
      details: { fields: errors.map(({ property }) => property) },
    });
  }
  return instance;
}

async function assertPermission(manager: EntityManager, actorUserId: string, permissionCode: string): Promise<void> {
  const rows: Array<{ allowed: boolean }> = await manager.query(
    `SELECT EXISTS (
       SELECT 1 FROM "users" user_account
       JOIN "roles" role ON role."id" = user_account."role_id"
       JOIN "role_permissions" assignment ON assignment."role_id" = role."id"
       JOIN "permissions" permission ON permission."id" = assignment."permission_id"
       WHERE user_account."id" = $1::uuid AND user_account."status" = 'ACTIVE'
         AND permission."code" = $2
     ) AS "allowed"`,
    [actorUserId, permissionCode],
  );
  if (rows[0]?.allowed !== true) {
    throw new ConflictException({
      code: 'SYNC_PERMISSION_REQUIRED',
      message: 'Bu sinxronlash amalini bajarish uchun korxona ruxsati yetarli emas',
      details: { permission: permissionCode },
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
      message: 'Varaqka kerakli model operatsiyasi avval sinxronlanishi kerak',
      details: { depends_on_event_ids: dependencies },
    });
  }
}

@Injectable()
export class PattaSheetSyncHandler implements SyncEntityHandler {
  constructor(@Inject(PattaSheetsService) private readonly sheets: PattaSheetsService) {}

  supports(entityType: string, operation: SyncMutationOperation): boolean {
    return entityType === 'patta_sheet' && (operation === 'CREATE' || operation === 'UPDATE' || operation === 'DELETE');
  }

  async apply(manager: EntityManager, context: SyncApplyContext, event: SyncEvent): Promise<SyncHandlerResult> {
    if (context.protocolVersion !== 2 && context.protocolVersion !== 3) {
      throw new ConflictException({
        code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED',
        message: 'Patta varag‘ini sinxronlash uchun dastur versiyasini yangilang',
        details: {},
      });
    }
    if (!context.timezone || !isIanaTimezone(context.timezone)) {
      throw new ConflictException({
        code: 'TENANT_TIMEZONE_UNAVAILABLE',
        message: 'Varaq yaratish uchun korxona vaqt mintaqasi kerak',
        details: {},
      });
    }
    if (!event.entity_id || !UUID_PATTERN.test(event.entity_id)) {
      throw new ConflictException({ code: 'PAYLOAD_INVALID', message: 'Varaq identifikatori yaroqsiz', details: {} });
    }
    const rawPayload = payloadRecord(event.payload);
    if (context.protocolVersion === 2 && rawPayload['entry_kind'] === 'STANDALONE') {
      throw new ConflictException({
        code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED',
        message: 'Standalone Patta Entry uchun dasturni yangilang',
        details: {},
      });
    }
    const isV3Protocol = context.protocolVersion === 3;
    const hasV3Payload = isV3Protocol && 'entry_kind' in rawPayload;
    await assertDependenciesSynced(manager, rawPayload);
    const contextForService = {
      actorUserId: context.actorUserId,
      validatedDeviceId: context.validatedDeviceId,
      timezone: context.timezone,
    };
    if (event.operation === 'CREATE') {
      await assertPermission(manager, context.actorUserId, 'patta_varaq.create');
      if (event.base_version !== '0') {
        throw new ConflictException({ code: 'PAYLOAD_INVALID', message: 'Varaq CREATE hodisasi versiyasi noto‘g‘ri', details: {} });
      }
      if (hasV3Payload) {
        const input = validateDto(CreatePattaSheetV3Dto, {
          ...rawPayload,
          id: event.entity_id,
          device_id: context.validatedDeviceId,
        });
        const result = await this.sheets.createV3InTransaction(manager, contextForService, input);
        return {
          entityVersion: result.version,
          projection: this.sheetProjectionV3(result),
          changeSequence: await this.sheets.latestChangeSequence(manager, result.id),
        };
      }
      const input = validateDto(CreatePattaSheetDto, {
        ...rawPayload, id: event.entity_id, device_id: context.validatedDeviceId,
      });
      const result = await this.sheets.createInTransaction(manager, contextForService, input, isV3Protocol ? 3 : 2);
      return {
        entityVersion: result.version,
        projection: this.sheetProjection(result),
        changeSequence: await this.sheets.latestChangeSequence(manager, result.id),
      };
    }
    if (event.base_version === null || !/^[1-9][0-9]*$/.test(event.base_version)) {
      throw new ConflictException({ code: 'PAYLOAD_INVALID', message: 'Varaq versiyasi noto‘g‘ri', details: {} });
    }
    const current = hasV3Payload
      ? await this.sheets.getProjectionV3(manager, event.entity_id)
      : await this.sheets.getProjection(manager, event.entity_id);
    if (event.operation === 'DELETE') {
      await assertPermission(manager, context.actorUserId, 'patta_varaq.purge');
      const purged = await this.sheets.purgeInTransaction(
        manager, contextForService, event.entity_id, event.base_version, hasV3Payload ? 3 : 2,
      );
      return { entityVersion: null, projection: null, changeSequence: purged.change_sequence };
    }

    const input = hasV3Payload
      ? validateDto(UpdatePattaSheetV3Dto, {
        ...rawPayload, id: event.entity_id, expected_version: event.base_version,
        device_id: context.validatedDeviceId,
      })
      : validateDto(UpdatePattaSheetDto, {
        ...rawPayload, id: event.entity_id, expected_version: event.base_version,
        device_id: context.validatedDeviceId,
      });
    const requestedDeletedAt = input.deleted_at ?? null;
    if (current.deleted_at === null && requestedDeletedAt !== null) {
      await assertPermission(manager, context.actorUserId, 'patta_varaq.delete');
      if (input.deleted_by !== context.actorUserId) {
        throw new ConflictException({ code: 'PAYLOAD_INVALID', message: 'O‘chirgan foydalanuvchi hodisa muallifiga mos emas', details: {} });
      }
      const trashed = hasV3Payload
        ? await this.sheets.setTrashedV3InTransaction(
          manager, contextForService, event.entity_id, event.base_version, true, requestedDeletedAt,
        )
        : await this.sheets.setTrashedInTransaction(
          manager, contextForService, event.entity_id, event.base_version, true, requestedDeletedAt,
          isV3Protocol ? 3 : 2,
        );
      if ('entry_kind' in trashed) {
        return {
          entityVersion: trashed.version,
          projection: this.sheetProjectionV3(trashed),
          changeSequence: await this.sheets.latestChangeSequence(manager, trashed.id),
        };
      }
      return {
        entityVersion: trashed.version,
        projection: this.sheetProjection(trashed),
        changeSequence: await this.sheets.latestChangeSequence(manager, trashed.id),
      };
    }
    if (current.deleted_at !== null && requestedDeletedAt === null) {
      await assertPermission(manager, context.actorUserId, 'patta_varaq.restore');
      const restored = hasV3Payload
        ? await this.sheets.setTrashedV3InTransaction(
          manager, contextForService, event.entity_id, event.base_version, false,
        )
        : await this.sheets.setTrashedInTransaction(
          manager, contextForService, event.entity_id, event.base_version, false,
          undefined, isV3Protocol ? 3 : 2,
        );
      if ('entry_kind' in restored) {
        return {
          entityVersion: restored.version,
          projection: this.sheetProjectionV3(restored),
          changeSequence: await this.sheets.latestChangeSequence(manager, restored.id),
        };
      }
      return {
        entityVersion: restored.version,
        projection: this.sheetProjection(restored),
        changeSequence: await this.sheets.latestChangeSequence(manager, restored.id),
      };
    }
    await assertPermission(manager, context.actorUserId, 'patta_varaq.edit');
    const updated = 'entry_kind' in input
      ? await this.sheets.updateV3InTransaction(
        manager, contextForService, event.entity_id, input, event.occurred_at,
      )
      : await this.sheets.updateInTransaction(
        manager, contextForService, event.entity_id, input, event.occurred_at,
        isV3Protocol ? 3 : 2,
      );
    return {
      entityVersion: updated.version,
      projection: 'entry_kind' in updated
        ? this.sheetProjectionV3(updated)
        : this.sheetProjection(updated),
      changeSequence: await this.sheets.latestChangeSequence(manager, updated.id),
    };
  }

  private sheetProjection(data: Awaited<ReturnType<PattaSheetsService['getById']>>): SyncProjectionV2 {
    return {
      projection_version: 2,
      entity_type: 'patta_sheets',
      entity_id: data.id,
      entity_version: data.version,
      data,
    };
  }

  private sheetProjectionV3(data: Awaited<ReturnType<PattaSheetsService['getProjectionV3']>>): SyncProjectionV3 {
    return {
      projection_version: 3,
      entity_type: 'patta_sheets',
      entity_id: data.id,
      entity_version: data.version,
      data,
    };
  }
}
