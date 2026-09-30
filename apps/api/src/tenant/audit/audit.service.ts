import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

export type AuditEntityType =
  | 'model'
  | 'operation'
  | 'worker'
  | 'badge'
  | 'patta_template'
  | 'patta_number_block'
  | 'patta_partiya_number_block'
  | 'patta_print_batch'
  | 'patta_print_event'
  | 'patta'
  | 'patta_sheet'
  | 'model_account_adjustment';
export type AuditAction =
  | 'model.create'
  | 'model.update'
  | 'model.deactivate'
  | 'operation.create'
  | 'operation.update'
  | 'operation.deactivate'
  | 'operation.price_change'
  | 'worker.create'
  | 'worker.update'
  | 'worker.deactivate'
  | 'badge.assign'
  | 'badge.reassign'
  | 'badge.close'
  | 'badge.release'
  | 'patta_template.create'
  | 'patta_template.update'
  | 'patta_template.deactivate'
  | 'patta_number_block.allocate'
  | 'patta_number_block.cancel'
  | 'patta.create'
  | 'patta_partiya_number_block.allocate'
  | 'patta_partiya_number_block.cancel'
  | 'patta_print_batch.create'
  | 'patta_print_batch.correct'
  | 'patta_print_batch.void'
  | 'patta_print_event.record'
  | 'patta.quantity_correct'
  | 'patta_sheet.create'
  | 'patta_sheet.update'
  | 'patta_sheet.trash'
  | 'patta_sheet.restore'
  | 'patta_sheet.purge'
  | 'patta_sheet.row_delete'
  | 'patta_sheet.row_restore'
  | 'patta_sheet.custom_operation.create'
  | 'model_account_adjustment.create'
  | 'model_account_adjustment.update'
  | 'model_account_adjustment.trash'
  | 'model_account_adjustment.restore';

export interface AuditEventInput {
  actorUserId: string;
  deviceId?: string | null;
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  before: object | null;
  after: object;
}

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AuditService {
  async append(manager: EntityManager, event: AuditEventInput): Promise<void> {
    await manager.query(
      `INSERT INTO "audit_log"
       ("actor_user_id", "device_id", "entity_type", "entity_id", "entity_key", "action", "before_json", "after_json")
       VALUES ($1, $2::uuid, $3, $4::uuid, $5, $6, $7::jsonb, $8::jsonb)`,
      [
        event.actorUserId,
        event.deviceId ?? null,
        event.entityType,
        CANONICAL_UUID_PATTERN.test(event.entityId) ? event.entityId : null,
        String(event.entityId),
        event.action,
        event.before === null ? null : JSON.stringify(event.before),
        JSON.stringify(event.after),
      ],
    );
  }
}
