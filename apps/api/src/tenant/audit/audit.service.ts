import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

export type AuditEntityType =
  | 'model'
  | 'operation'
  | 'worker'
  | 'badge'
  | 'patta_template'
  | 'patta_number_block'
  | 'patta';
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
  | 'patta.create';

export interface AuditEventInput {
  actorUserId: string;
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
       ("actor_user_id", "entity_type", "entity_id", "entity_key", "action", "before_json", "after_json")
       VALUES ($1, $2, $3::uuid, $4, $5, $6::jsonb, $7::jsonb)`,
      [
        event.actorUserId,
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
