import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/** Shared by transaction-scoped writers and the bootstrap session lock. */
export const SYNC_CHANGE_LOCK_KEY = '-7291180417265500301';

export interface SyncChangeInput {
  entityType: string;
  entityId: string;
  operation: 'UPSERT' | 'DELETE';
  entityVersion: string | null;
  projectionVersion: number;
  payload: object | null;
}

export interface RecordedSyncChange {
  sequenceId: string;
}

interface SequenceRow {
  sequence_id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateChange(change: SyncChangeInput): void {
  if (!change.entityType.trim() || !change.entityId.trim()) {
    throw new Error('Sync change requires entity type and entity ID');
  }
  if (change.operation !== 'UPSERT' && change.operation !== 'DELETE') {
    throw new Error('Sync change operation is invalid');
  }
  if (
    !Number.isSafeInteger(change.projectionVersion) ||
    change.projectionVersion < 1
  ) {
    throw new Error(
      'Sync change projection version must be a positive integer',
    );
  }
  if (change.entityVersion !== null && !change.entityVersion) {
    throw new Error('Sync change entity version must be null or nonempty');
  }
  if (change.operation === 'UPSERT' && !isRecord(change.payload)) {
    throw new Error('UPSERT change requires a projection');
  }
  if (change.payload !== null) {
    if (
      Reflect.get(change.payload, 'projection_version') !==
        change.projectionVersion ||
      Reflect.get(change.payload, 'entity_type') !== change.entityType ||
      Reflect.get(change.payload, 'entity_id') !== change.entityId
    ) {
      throw new Error(
        'Sync change projection identity does not match the change',
      );
    }
  }
}

@Injectable()
export class SyncChangeRecorder {
  async record(
    manager: EntityManager,
    change: SyncChangeInput,
  ): Promise<RecordedSyncChange> {
    validateChange(change);

    await manager.query('SELECT pg_advisory_xact_lock($1::bigint)', [
      SYNC_CHANGE_LOCK_KEY,
    ]);
    const rows: SequenceRow[] = await manager.query(
      `INSERT INTO "server_change_log"
         ("entity_type", "entity_id", "operation", "entity_version",
          "projection_version", "payload_json")
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING "sequence_id"::text AS "sequence_id"`,
      [
        change.entityType,
        change.entityId,
        change.operation,
        change.entityVersion,
        change.projectionVersion,
        change.payload === null ? null : JSON.stringify(change.payload),
      ],
    );
    const sequenceId = rows[0]?.sequence_id;
    if (!sequenceId || !/^[1-9][0-9]*$/.test(sequenceId)) {
      throw new Error('Sync change recorder did not return a change sequence');
    }

    return { sequenceId };
  }
}
