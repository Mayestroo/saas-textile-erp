import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

export type AuditEntityType = 'model' | 'operation';
export type AuditAction =
  | 'model.create'
  | 'model.update'
  | 'model.deactivate'
  | 'operation.create'
  | 'operation.update'
  | 'operation.deactivate'
  | 'operation.price_change';

export interface AuditEventInput {
  actorUserId: string;
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  before: object | null;
  after: object;
}

@Injectable()
export class AuditService {
  async append(manager: EntityManager, event: AuditEventInput): Promise<void> {
    await manager.query(
      `INSERT INTO "audit_log"
         ("actor_user_id", "entity_type", "entity_id", "action", "before_json", "after_json")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [
        event.actorUserId,
        event.entityType,
        event.entityId,
        event.action,
        event.before === null ? null : JSON.stringify(event.before),
        JSON.stringify(event.after),
      ],
    );
  }
}
