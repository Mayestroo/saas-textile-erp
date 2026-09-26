import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { PATTA_CONFIGURATION } from './patta.config.js';
import type { PattaConfiguration } from './patta.config.js';
import {
  pattaMaxActiveBlocksReached,
  pattaNumberBlockDeviceMismatch,
  pattaNumberBlockNotFound,
  pattaNumberBlockTerminal,
  pattaNumberOutsideBlock,
  pattaNumberRangeConflict,
  pattaNumberRangeExhausted,
  pattaNumberSequenceUnavailable,
  pattaNumberBlockUsageInvalid,
} from './patta-errors.js';
import { isPostgresErrorCode, postgresConstraint } from '../models/model-errors.js';

export type PattaNumberBlockStatus = 'ACTIVE' | 'EXHAUSTED' | 'CANCELLED';

export interface PattaNumberBlockRecord {
  id: string;
  device_id: string;
  range_start: string;
  range_end: string;
  allocated_at: string;
  exhausted_at: string | null;
  reported_used_count: string;
  status: PattaNumberBlockStatus;
  created_by: string | null;
}

interface PattaNumberBlockRow {
  id: string;
  device_id: string;
  range_start: string;
  range_end: string;
  allocated_at: Date | string;
  exhausted_at: Date | string | null;
  reported_used_count: string;
  status: PattaNumberBlockStatus;
  created_by: string | null;
}

interface SequenceRow {
  next_number: string;
}

interface ActiveBlockCountRow {
  active_count: string;
}

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const BLOCK_COLUMNS = `"id", "device_id", "range_start"::text AS "range_start",
  "range_end"::text AS "range_end",
  to_char("allocated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "allocated_at",
  CASE WHEN "exhausted_at" IS NULL THEN NULL ELSE
    to_char("exhausted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "exhausted_at",
  "reported_used_count"::text AS "reported_used_count", "status", "created_by"`;

function timestamp(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const isoValue = value.replace(' ', 'T');
  return isoValue.replace(/([+-][0-9]{2})$/, '$1:00');
}

function serializeBlock(row: PattaNumberBlockRow): PattaNumberBlockRecord {
  if (row.allocated_at === undefined) {
    throw new Error(`Patta number block row is missing allocated_at; fields=${Object.keys(row).join(',')}`);
  }
  return {
    id: row.id,
    device_id: row.device_id,
    range_start: row.range_start,
    range_end: row.range_end,
    allocated_at: timestamp(row.allocated_at),
    exhausted_at: row.exhausted_at === null ? null : timestamp(row.exhausted_at),
    reported_used_count: row.reported_used_count,
    status: row.status,
    created_by: row.created_by,
  };
}

function mapAllocationError(error: unknown): never {
  if (
    isPostgresErrorCode(error, '23P01') ||
    postgresConstraint(error) === 'ex_patta_number_blocks_no_overlap'
  ) {
    throw pattaNumberRangeConflict();
  }
  throw error;
}

@Injectable()
export class PattaNumberBlocksService {
  constructor(
    private readonly auditService: AuditService,
    @Inject(PATTA_CONFIGURATION) private readonly configuration: PattaConfiguration,
  ) {}

  async allocate(
    dataSource: DataSource,
    actorUserId: string,
    validatedDeviceId: string,
  ): Promise<PattaNumberBlockRecord> {
    try {
      return await dataSource.transaction(async (manager) => {
        const sequenceRows: SequenceRow[] = await manager.query(
          `SELECT "next_number"::text AS "next_number"
           FROM "patta_number_sequence" WHERE "id" = 1 FOR UPDATE`,
        );
        const sequence = sequenceRows[0];
        if (!sequence) {
          throw pattaNumberSequenceUnavailable();
        }
        const activeRows: ActiveBlockCountRow[] = await manager.query(
          `SELECT count(*)::text AS "active_count" FROM "patta_number_blocks"
           WHERE "device_id" = $1 AND "status" = 'ACTIVE'`,
          [validatedDeviceId],
        );
        const activeCount = BigInt(activeRows[0]?.active_count ?? '0');
        if (activeCount >= BigInt(this.configuration.maxActiveBlocksPerDevice)) {
          throw pattaMaxActiveBlocksReached();
        }

        const start = BigInt(sequence.next_number);
        const end = start + this.configuration.blockSize - 1n;
        const nextNumber = end + 1n;
        if (end > MAX_POSTGRES_BIGINT || nextNumber > MAX_POSTGRES_BIGINT) {
          throw pattaNumberRangeExhausted();
        }

        const blockRows: PattaNumberBlockRow[] = await manager.query(
          `INSERT INTO "patta_number_blocks"
             ("device_id", "range_start", "range_end", "created_by")
           VALUES ($1, $2::bigint, $3::bigint, $4)
           RETURNING ${BLOCK_COLUMNS}`,
          [validatedDeviceId, start.toString(), end.toString(), actorUserId],
        );
        const inserted = blockRows[0];
        if (!inserted) {
          throw new Error('Patta number block insert did not return a record');
        }
        await manager.query(
          `UPDATE "patta_number_sequence"
           SET "next_number" = $1::bigint, "version" = "version" + 1,
               "updated_at" = transaction_timestamp()
           WHERE "id" = 1`,
          [nextNumber.toString()],
        );

        const result = serializeBlock(inserted);
        await this.auditService.append(manager, {
          actorUserId,
          entityType: 'patta_number_block',
          entityId: result.id,
          action: 'patta_number_block.allocate',
          before: null,
          after: result,
        });
        return result;
      });
    } catch (error) {
      if (error instanceof Error && 'response' in error) {
        throw error;
      }
      return mapAllocationError(error);
    }
  }

  async reportUsage(
    dataSource: DataSource,
    _actorUserId: string,
    validatedDeviceId: string,
    blockId: string,
    reportedUsedCount: bigint,
  ): Promise<PattaNumberBlockRecord> {
    if (reportedUsedCount < 0n) {
      throw pattaNumberBlockUsageInvalid('PATTA_BLOCK_USAGE_INVALID', 'Ishlatilgan raqamlar soni manfiy bo‘lishi mumkin emas');
    }

    return dataSource.transaction(async (manager) => {
      const block = await this.lockBlock(manager, blockId);
      this.assertBlockDevice(block, validatedDeviceId);
      if (block.status !== 'ACTIVE') {
        throw pattaNumberBlockTerminal();
      }
      const previousCount = BigInt(block.reported_used_count);
      if (reportedUsedCount < previousCount) {
        throw pattaNumberBlockUsageInvalid(
          'PATTA_BLOCK_USAGE_DECREASED',
          'Ishlatilgan raqamlar soni oldingi hisobotdan kamaymasligi kerak',
        );
      }
      const capacity = BigInt(block.range_end) - BigInt(block.range_start) + 1n;
      if (reportedUsedCount > capacity) {
        throw pattaNumberBlockUsageInvalid(
          'PATTA_BLOCK_USAGE_EXCEEDS_CAPACITY',
          'Ishlatilgan raqamlar soni blok sig‘imidan oshmasligi kerak',
        );
      }
      const status: PattaNumberBlockStatus = reportedUsedCount === capacity ? 'EXHAUSTED' : 'ACTIVE';
      const updateResult: [PattaNumberBlockRow[], number] = await manager.query(
        `UPDATE "patta_number_blocks"
         SET "reported_used_count" = $1::bigint, "status" = $2,
             "exhausted_at" = CASE WHEN $2::varchar = 'EXHAUSTED' THEN transaction_timestamp() ELSE NULL END
         WHERE "id" = $3
         RETURNING ${BLOCK_COLUMNS}`,
        [reportedUsedCount.toString(), status, blockId],
      );
      const updated = updateResult[0][0];
      if (!updated) {
        throw pattaNumberBlockNotFound();
      }
      return serializeBlock(updated);
    });
  }

  async cancel(
    dataSource: DataSource,
    actorUserId: string,
    validatedDeviceId: string,
    blockId: string,
  ): Promise<PattaNumberBlockRecord> {
    return dataSource.transaction(async (manager) => {
      const block = await this.lockBlock(manager, blockId);
      this.assertBlockDevice(block, validatedDeviceId);
      if (block.status !== 'ACTIVE') {
        throw pattaNumberBlockTerminal();
      }
      const before = serializeBlock(block);
      const updateResult: [PattaNumberBlockRow[], number] = await manager.query(
        `UPDATE "patta_number_blocks" SET "status" = 'CANCELLED'
         WHERE "id" = $1 RETURNING ${BLOCK_COLUMNS}`,
        [blockId],
      );
      const cancelled = updateResult[0][0];
      if (!cancelled) {
        throw pattaNumberBlockNotFound();
      }
      const after = serializeBlock(cancelled);
      await this.auditService.append(manager, {
        actorUserId,
        entityType: 'patta_number_block',
        entityId: blockId,
        action: 'patta_number_block.cancel',
        before,
        after,
      });
      return after;
    });
  }

  async assertAllocatedNumber(
    dataSource: DataSource,
    validatedDeviceId: string,
    blockId: string,
    pattaNumber: bigint,
  ): Promise<void> {
    const rows: Array<Pick<PattaNumberBlockRow, 'device_id' | 'range_start' | 'range_end'>> =
      await dataSource.query(
        `SELECT "device_id", "range_start"::text AS "range_start",
                "range_end"::text AS "range_end"
         FROM "patta_number_blocks" WHERE "id" = $1`,
        [blockId],
      );
    const block = rows[0];
    if (!block) {
      throw pattaNumberBlockNotFound();
    }
    this.assertBlockDevice(block, validatedDeviceId);
    if (pattaNumber < BigInt(block.range_start) || pattaNumber > BigInt(block.range_end)) {
      throw pattaNumberOutsideBlock();
    }
  }

  private async lockBlock(manager: EntityManager, blockId: string): Promise<PattaNumberBlockRow> {
    const rows: PattaNumberBlockRow[] = await manager.query(
      `SELECT ${BLOCK_COLUMNS} FROM "patta_number_blocks" WHERE "id" = $1 FOR UPDATE`,
      [blockId],
    );
    const block = rows[0];
    if (!block) {
      throw pattaNumberBlockNotFound();
    }
    return block;
  }

  private assertBlockDevice(
    block: Pick<PattaNumberBlockRow, 'device_id'>,
    validatedDeviceId: string,
  ): void {
    if (block.device_id !== validatedDeviceId) {
      throw pattaNumberBlockDeviceMismatch();
    }
  }
}
