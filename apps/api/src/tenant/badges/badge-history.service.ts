import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { workerNotFound } from '../workers/worker-errors.js';
import type { AssignBadgeDto } from './dto/assign-badge.dto.js';
import type { ReassignBadgeDto } from './dto/reassign-badge.dto.js';
import type { ReleaseBadgeDto } from './dto/release-badge.dto.js';
import {
  badgeAlreadyAssigned,
  badgeAlreadyAssignedToWorker,
  badgeConcurrentConflict,
  badgeNotFound,
  badgePostgresCode,
  badgePostgresConstraint,
  badgeWorkerNotFound,
  futureBadgeAssignmentConflict,
  inactiveBadgeWorker,
  invalidBadgeEffectiveAt,
  invalidBadgeInterval,
  invalidBadgeNumber,
  invalidBadgeTimestamp,
} from './badge-errors.js';

const MAX_BIGINT = 9_223_372_036_854_775_807n;
const ISO_TIMESTAMP_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

export interface BadgeAssignmentRecord {
  id: string;
  badge_number: string;
  worker_id: string;
  full_name: string;
  valid_from: string;
  valid_to: string | null;
  created_by: string | null;
  created_at: string;
}

interface BadgeRow {
  id: string;
  badge_number: string;
  worker_id: string;
  full_name?: string;
  valid_from: string;
  valid_to: string | null;
  created_by: string | null;
  created_at: string;
}

interface WorkerRow {
  id: string;
  full_name: string;
  status: 'ACTIVE' | 'INACTIVE';
}

interface DbTimestampRow {
  value: string;
}

interface EffectiveTimeValidityRow {
  not_backdated: boolean;
  after_start: boolean;
}

const BADGE_COLUMNS = `history."id"::text AS "id", history."badge_number",
  history."worker_id"::text AS "worker_id", worker."full_name",
  to_char(history."valid_from" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "valid_from",
  CASE WHEN history."valid_to" IS NULL THEN NULL ELSE
    to_char(history."valid_to" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  END AS "valid_to",
  history."created_by"::text AS "created_by",
  to_char(history."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at"`;

const BADGE_RETURNING = `"id"::text AS "id", "badge_number",
  "worker_id"::text AS "worker_id",
  to_char("valid_from" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "valid_from",
  CASE WHEN "valid_to" IS NULL THEN NULL ELSE
    to_char("valid_to" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  END AS "valid_to", "created_by"::text AS "created_by",
  to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at"`;

function normalizeBadgeNumber(value: string): string {
  const badgeNumber = value.trim();
  if (!badgeNumber) {
    throw invalidBadgeNumber();
  }
  return badgeNumber;
}

function assertWorkerId(value: string): void {
  if (!/^[0-9]+$/.test(value)) {
    throw new BadRequestException({
      code: 'INVALID_WORKER_ID',
      message: 'Ishchi ID musbat butun son bo‘lishi kerak',
      details: {},
    });
  }
  const workerId = BigInt(value);
  if (workerId < 1n || workerId > MAX_BIGINT) {
    throw new BadRequestException({
      code: 'INVALID_WORKER_ID',
      message: 'Ishchi ID musbat butun son bo‘lishi kerak',
      details: {},
    });
  }
}

function serializeBadge(row: BadgeRow, fullName = row.full_name ?? ''): BadgeAssignmentRecord {
  return {
    id: row.id,
    badge_number: row.badge_number,
    worker_id: row.worker_id,
    full_name: fullName,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

function mapBadgeWriteError(error: unknown): never {
  if (error instanceof HttpException) {
    throw error;
  }
  if (
    badgePostgresCode(error) === '23P01' ||
    badgePostgresConstraint(error) === 'ex_worker_badge_history_no_overlap'
  ) {
    throw badgeConcurrentConflict();
  }
  if (badgePostgresConstraint(error) === 'ck_worker_badge_history_interval') {
    throw invalidBadgeInterval();
  }
  throw error;
}

@Injectable()
export class BadgeHistoryService {
  constructor(private readonly auditService: AuditService) {}

  async assign(
    dataSource: DataSource,
    actorUserId: string,
    workerId: string,
    input: AssignBadgeDto,
  ): Promise<BadgeAssignmentRecord> {
    assertWorkerId(workerId);
    const badgeNumber = normalizeBadgeNumber(input.badge_number);
    try {
      return await dataSource.transaction(async (manager) => {
        await this.lockBadge(manager, badgeNumber);
        const transactionTime = await this.transactionTimestamp(manager);
        const effectiveAt = input.effective_at ?? transactionTime;
        const worker = await this.lockActiveWorker(manager, workerId);
        await this.assertEffectiveAt(manager, effectiveAt);
        const current = await this.findOpenAssignment(manager, badgeNumber);
        if (current) {
          throw badgeAlreadyAssigned();
        }

        const inserted = await this.insertAssignment(
          manager,
          actorUserId,
          workerId,
          worker.full_name,
          badgeNumber,
          effectiveAt,
        );
        await this.auditService.append(manager, {
          actorUserId,
          entityType: 'badge',
          entityId: inserted.id,
          action: 'badge.assign',
          before: null,
          after: inserted,
        });
        return inserted;
      });
    } catch (error) {
      return mapBadgeWriteError(error);
    }
  }

  async reassign(
    dataSource: DataSource,
    actorUserId: string,
    badgeNumberInput: string,
    input: ReassignBadgeDto,
  ): Promise<BadgeAssignmentRecord> {
    const badgeNumber = normalizeBadgeNumber(badgeNumberInput);
    assertWorkerId(input.worker_id);
    try {
      return await dataSource.transaction(async (manager) => {
        await this.lockBadge(manager, badgeNumber);
        const transactionTime = await this.transactionTimestamp(manager);
        const effectiveAt = input.effective_at ?? transactionTime;
        const worker = await this.lockActiveWorker(manager, input.worker_id);
        const current = await this.findOpenAssignment(manager, badgeNumber);
        if (!current) {
          throw badgeNotFound();
        }
        if (current.worker_id === input.worker_id) {
          throw badgeAlreadyAssignedToWorker();
        }
        await this.assertEffectiveAt(manager, effectiveAt, current.valid_from);

        const closed = await this.closeAssignment(manager, current, effectiveAt);
        const inserted = await this.insertAssignment(
          manager,
          actorUserId,
          input.worker_id,
          worker.full_name,
          badgeNumber,
          effectiveAt,
        );
        await this.auditService.append(manager, {
          actorUserId,
          entityType: 'badge',
          entityId: inserted.id,
          action: 'badge.reassign',
          before: current,
          after: { ...inserted, previous_assignment: closed },
        });
        return inserted;
      });
    } catch (error) {
      return mapBadgeWriteError(error);
    }
  }

  async release(
    dataSource: DataSource,
    actorUserId: string,
    badgeNumberInput: string,
    input: ReleaseBadgeDto,
  ): Promise<BadgeAssignmentRecord> {
    const badgeNumber = normalizeBadgeNumber(badgeNumberInput);
    try {
      return await dataSource.transaction(async (manager) => {
        await this.lockBadge(manager, badgeNumber);
        const transactionTime = await this.transactionTimestamp(manager);
        const effectiveAt = input.effective_at ?? transactionTime;
        const current = await this.findOpenAssignment(manager, badgeNumber);
        if (!current) {
          throw badgeNotFound();
        }
        await this.assertEffectiveAt(manager, effectiveAt, current.valid_from);

        const closed = await this.closeAssignment(manager, current, effectiveAt);
        await this.auditService.append(manager, {
          actorUserId,
          entityType: 'badge',
          entityId: closed.id,
          action: 'badge.release',
          before: current,
          after: closed,
        });
        return closed;
      });
    } catch (error) {
      return mapBadgeWriteError(error);
    }
  }

  async listByWorker(dataSource: DataSource, workerId: string): Promise<BadgeAssignmentRecord[]> {
    assertWorkerId(workerId);
    const workers: Array<{ id: string }> = await dataSource.query(
      'SELECT "id"::text AS "id" FROM "workers" WHERE "id" = $1::bigint',
      [workerId],
    );
    if (!workers[0]) {
      throw workerNotFound();
    }
    const rows: BadgeRow[] = await dataSource.query(
      `SELECT ${BADGE_COLUMNS}
       FROM "worker_badge_history" AS history
       INNER JOIN "workers" AS worker ON worker."id" = history."worker_id"
       WHERE history."worker_id" = $1::bigint
       ORDER BY history."valid_from" ASC, history."id" ASC`,
      [workerId],
    );
    return rows.map((row) => serializeBadge(row));
  }

  async closeOpenAssignmentsForWorker(
    manager: EntityManager,
    actorUserId: string,
    workerId: string,
    effectiveAt: string,
  ): Promise<BadgeAssignmentRecord[]> {
    const rows: BadgeRow[] = await manager.query(
      `SELECT ${BADGE_COLUMNS}
       FROM "worker_badge_history" AS history
       INNER JOIN "workers" AS worker ON worker."id" = history."worker_id"
       WHERE history."worker_id" = $1::bigint AND history."valid_to" IS NULL
       ORDER BY history."badge_number", history."id"
       FOR UPDATE OF history`,
      [workerId],
    );
    const closedAssignments: BadgeAssignmentRecord[] = [];
    for (const row of rows) {
      await this.assertEffectiveAt(manager, effectiveAt, row.valid_from);
      const before = serializeBadge(row);
      const closed = await this.closeAssignment(manager, before, effectiveAt);
      await this.auditService.append(manager, {
        actorUserId,
        entityType: 'badge',
        entityId: closed.id,
        action: 'badge.close',
        before,
        after: closed,
      });
      closedAssignments.push(closed);
    }
    return closedAssignments;
  }

  private async lockBadge(manager: EntityManager, badgeNumber: string): Promise<void> {
    await manager.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('worker-badge:' || $1, 0))`,
      [badgeNumber],
    );
  }

  private async transactionTimestamp(manager: EntityManager): Promise<string> {
    const rows: DbTimestampRow[] = await manager.query(
      `SELECT to_char(
         transaction_timestamp() AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) AS "value"`,
    );
    const value = rows[0]?.value;
    if (!value) {
      throw new Error('Database transaction timestamp was not returned');
    }
    return value;
  }

  private async assertEffectiveAt(
    manager: EntityManager,
    effectiveAt: string,
    afterTimestamp?: string,
  ): Promise<void> {
    if (!ISO_TIMESTAMP_WITH_OFFSET.test(effectiveAt) || !Number.isFinite(Date.parse(effectiveAt))) {
      throw invalidBadgeTimestamp();
    }
    const rows: EffectiveTimeValidityRow[] = await manager.query(
      `SELECT
         $1::timestamptz >= transaction_timestamp() AS "not_backdated",
         ($2::timestamptz IS NULL OR $1::timestamptz > $2::timestamptz) AS "after_start"`,
      [effectiveAt, afterTimestamp ?? null],
    );
    if (!rows[0]?.not_backdated) {
      throw invalidBadgeEffectiveAt();
    }
    if (!rows[0].after_start) {
      throw futureBadgeAssignmentConflict();
    }
  }

  private async lockActiveWorker(manager: EntityManager, workerId: string): Promise<WorkerRow> {
    const rows: WorkerRow[] = await manager.query(
      `SELECT "id"::text AS "id", "full_name", "status"
       FROM "workers" WHERE "id" = $1::bigint FOR UPDATE`,
      [workerId],
    );
    const worker = rows[0];
    if (!worker) {
      throw badgeWorkerNotFound();
    }
    if (worker.status !== 'ACTIVE') {
      throw inactiveBadgeWorker();
    }
    return worker;
  }

  private async findOpenAssignment(
    manager: EntityManager,
    badgeNumber: string,
  ): Promise<BadgeAssignmentRecord | undefined> {
    const rows: BadgeRow[] = await manager.query(
      `SELECT ${BADGE_COLUMNS}
       FROM "worker_badge_history" AS history
       INNER JOIN "workers" AS worker ON worker."id" = history."worker_id"
       WHERE history."badge_number" = $1 AND history."valid_to" IS NULL
       ORDER BY history."valid_from" DESC, history."id"
       FOR UPDATE OF history`,
      [badgeNumber],
    );
    return rows[0] ? serializeBadge(rows[0]) : undefined;
  }

  private async insertAssignment(
    manager: EntityManager,
    actorUserId: string,
    workerId: string,
    fullName: string,
    badgeNumber: string,
    effectiveAt: string,
  ): Promise<BadgeAssignmentRecord> {
    const rows: BadgeRow[] = await manager.query(
      `INSERT INTO "worker_badge_history"
         ("badge_number", "worker_id", "valid_from", "created_by")
       VALUES ($1, $2::bigint, $3::timestamptz, $4)
       RETURNING ${BADGE_RETURNING}`,
      [badgeNumber, workerId, effectiveAt, actorUserId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error('Badge assignment insert did not return the created record');
    }
    return serializeBadge(row, fullName);
  }

  private async closeAssignment(
    manager: EntityManager,
    assignment: BadgeAssignmentRecord,
    effectiveAt: string,
  ): Promise<BadgeAssignmentRecord> {
    const updateRows: Array<{ id: string }> = await manager.query(
      `UPDATE "worker_badge_history" SET "valid_to" = $2::timestamptz
       WHERE "id" = $1::uuid AND "valid_to" IS NULL
       RETURNING "id"::text AS "id"`,
      [assignment.id, effectiveAt],
    );
    if (!updateRows[0]) {
      throw badgeConcurrentConflict();
    }
    const rows: BadgeRow[] = await manager.query(
      `SELECT ${BADGE_COLUMNS}
       FROM "worker_badge_history" AS history
       INNER JOIN "workers" AS worker ON worker."id" = history."worker_id"
       WHERE history."id" = $1::uuid`,
      [assignment.id],
    );
    const row = rows[0];
    if (!row) {
      throw badgeConcurrentConflict();
    }
    return serializeBadge(row, assignment.full_name);
  }
}
