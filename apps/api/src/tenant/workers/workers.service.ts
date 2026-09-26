import { Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { BadgeHistoryService } from '../badges/badge-history.service.js';
import { CreateWorkerDto } from './dto/create-worker.dto.js';
import { UpdateWorkerDto } from './dto/update-worker.dto.js';
import {
  emptyWorkerUpdate,
  invalidWorkerName,
  invalidWorkerVersion,
  workerNotFound,
  workerPostgresConstraint,
  workerVersionConflict,
} from './worker-errors.js';
import { canonicalizeWorkerName } from './worker-name.js';

const MAX_BIGINT = 9_223_372_036_854_775_807n;

export type WorkerStatus = 'ACTIVE' | 'INACTIVE';

export interface WorkerRecord {
  id: string;
  full_name: string;
  status: WorkerStatus;
  version: string;
  created_at: string;
  updated_at: string;
}

interface WorkerRow {
  id: string;
  full_name: string;
  status: WorkerStatus;
  version: string | number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TransactionTimestampRow {
  effective_at: string;
}

function timestamp(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value.includes('T')) {
    return value.replace(/([+-][0-9]{2})$/, '$1:00');
  }
  return value.replace(' ', 'T').replace(/([+-][0-9]{2})$/, '$1:00');
}

const WORKER_COLUMNS = `"id"::text AS "id", "full_name", "status",
  "version"::text AS "version",
  to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
  to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at"`;

function serializeWorker(row: WorkerRow): WorkerRecord {
  return {
    id: row.id,
    full_name: row.full_name,
    status: row.status,
    version: String(row.version),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  };
}

@Injectable()
export class WorkersService {
  constructor(
    private readonly auditService: AuditService,
    private readonly badgeHistoryService: BadgeHistoryService,
  ) {}

  async list(
    dataSource: DataSource,
    status: WorkerStatus = 'ACTIVE',
  ): Promise<WorkerRecord[]> {
    const rows: WorkerRow[] = await dataSource.query(
      `SELECT ${WORKER_COLUMNS} FROM "workers"
       WHERE "status" = $1 ORDER BY "id"`,
      [status],
    );
    return rows.map(serializeWorker);
  }

  async getById(dataSource: DataSource, workerId: string): Promise<WorkerRecord> {
    const rows: WorkerRow[] = await dataSource.query(
      `SELECT ${WORKER_COLUMNS} FROM "workers" WHERE "id" = $1::bigint`,
      [workerId],
    );
    const worker = rows[0];
    if (!worker) {
      throw workerNotFound();
    }
    return serializeWorker(worker);
  }

  async create(
    dataSource: DataSource,
    actorUserId: string,
    input: CreateWorkerDto,
  ): Promise<WorkerRecord> {
    const fullName = canonicalizeWorkerName(input.full_name);
    if (!fullName) {
      throw invalidWorkerName();
    }
    const status: WorkerStatus = input.status ?? 'ACTIVE';

    try {
      return await dataSource.transaction(async (manager) => {
        const rows: WorkerRow[] = await manager.query(
          `INSERT INTO "workers" ("full_name", "status") VALUES ($1, $2)
           RETURNING ${WORKER_COLUMNS}`,
          [fullName, status],
        );
        const created = rows[0];
        if (!created) {
          throw new Error('Worker insert did not return the created record');
        }
        const result = serializeWorker(created);
        await this.auditService.append(manager, {
          actorUserId,
          entityType: 'worker',
          entityId: result.id,
          action: 'worker.create',
          before: null,
          after: result,
        });
        return result;
      });
    } catch (error) {
      if (workerPostgresConstraint(error) === 'ck_workers_full_name_canonical') {
        throw invalidWorkerName();
      }
      throw error;
    }
  }

  async update(
    dataSource: DataSource,
    actorUserId: string,
    workerId: string,
    input: UpdateWorkerDto,
  ): Promise<WorkerRecord> {
    if (!/^[1-9][0-9]*$/.test(input.expected_version) || BigInt(input.expected_version) > MAX_BIGINT) {
      throw invalidWorkerVersion();
    }
    if (input.full_name === undefined && input.status === undefined) {
      throw emptyWorkerUpdate();
    }
    const fullName = input.full_name === undefined
      ? undefined
      : canonicalizeWorkerName(input.full_name);
    if (fullName === '') {
      throw invalidWorkerName();
    }

    try {
      return await dataSource.transaction(async (manager) => {
        const lockedRows: WorkerRow[] = await manager.query(
          `SELECT ${WORKER_COLUMNS} FROM "workers"
           WHERE "id" = $1::bigint FOR UPDATE`,
          [workerId],
        );
        const locked = lockedRows[0];
        if (!locked) {
          throw workerNotFound();
        }
        const before = serializeWorker(locked);
        if (before.version !== input.expected_version) {
          throw workerVersionConflict(input.expected_version, before.version);
        }

        const nextStatus = input.status ?? before.status;
        if (before.status === 'ACTIVE' && nextStatus === 'INACTIVE') {
          const timeRows: TransactionTimestampRow[] = await manager.query(
            `SELECT to_char(
               transaction_timestamp() AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
             ) AS "effective_at"`,
          );
          const effectiveAt = timeRows[0]?.effective_at;
          if (!effectiveAt) {
            throw new Error('Database transaction timestamp was not returned');
          }
          await this.badgeHistoryService.closeOpenAssignmentsForWorker(
            manager,
            actorUserId,
            workerId,
            effectiveAt,
          );
        }

        const assignments: string[] = [];
        const values: unknown[] = [workerId];
        if (fullName !== undefined) {
          values.push(fullName);
          assignments.push(`"full_name" = $${values.length}`);
        }
        if (input.status !== undefined) {
          values.push(input.status);
          assignments.push(`"status" = $${values.length}`);
        }
        values.push(input.expected_version);
        assignments.push('"version" = "version" + 1');
        assignments.push('"updated_at" = transaction_timestamp()');

        const changedRows: Array<{ id: string }> = await manager.query(
          `UPDATE "workers" SET ${assignments.join(', ')}
           WHERE "id" = $1::bigint AND "version" = $${values.length}::bigint
           RETURNING "id"::text AS "id"`,
          values,
        );
        if (!changedRows[0]) {
          throw workerVersionConflict(input.expected_version, before.version);
        }
        const updatedRows: WorkerRow[] = await manager.query(
          `SELECT ${WORKER_COLUMNS} FROM "workers" WHERE "id" = $1::bigint`,
          [workerId],
        );
        const updated = updatedRows[0];
        if (!updated) {
          throw workerVersionConflict(input.expected_version, before.version);
        }
        const after = serializeWorker(updated);
        await this.auditService.append(manager, {
          actorUserId,
          entityType: 'worker',
          entityId: workerId,
          action: before.status === 'ACTIVE' && after.status === 'INACTIVE'
            ? 'worker.deactivate'
            : 'worker.update',
          before,
          after,
        });
        return after;
      });
    } catch (error) {
      if (workerPostgresConstraint(error) === 'ck_workers_full_name_canonical') {
        throw invalidWorkerName();
      }
      throw error;
    }
  }

}
