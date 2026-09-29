import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { SyncChangeRecorder } from '../sync/sync-change-recorder.js';
import { PATTA_CONFIGURATION } from './patta.config.js';
import type { PattaConfiguration } from './patta.config.js';
import { pattaConflict, pattaForbidden, pattaNotFound } from './patta-errors.js';

export type PartiyaBlockStatus = 'ACTIVE' | 'EXHAUSTED' | 'CANCELLED';

export interface PartiyaNumberBlockRecord {
  id: string;
  device_id: string;
  range_start: string;
  range_end: string;
  allocated_at: string;
  exhausted_at: string | null;
  reported_used_count: string;
  status: PartiyaBlockStatus;
  created_by: string | null;
}

interface PartiyaBlockRow {
  id: string;
  device_id: string;
  range_start: string;
  range_end: string;
  allocated_at: Date | string;
  exhausted_at: Date | string | null;
  reported_used_count: string;
  status: PartiyaBlockStatus;
  created_by: string | null;
}

interface SequenceRow { next_number: string }
interface CountRow { active_count: string }

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const COLUMNS = `"id", "device_id", "range_start"::text AS "range_start",
  "range_end"::text AS "range_end",
  to_char("allocated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "allocated_at",
  CASE WHEN "exhausted_at" IS NULL THEN NULL ELSE
    to_char("exhausted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "exhausted_at",
  "reported_used_count"::text AS "reported_used_count", "status", "created_by"`;

function serialize(row: PartiyaBlockRow): PartiyaNumberBlockRecord {
  return { ...row, allocated_at: normalizeTimestamp(row.allocated_at), exhausted_at: row.exhausted_at === null
    ? null : normalizeTimestamp(row.exhausted_at) };
}

function normalizeTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value.replace(' ', 'T').replace(/([+-][0-9]{2})$/, '$1:00');
}

function partiyaBlockError(code: string, message: string) {
  return pattaConflict(code, message);
}

@Injectable()
export class PattaPartiyaNumberBlocksService {
  constructor(
    private readonly auditService: AuditService,
    @Inject(PATTA_CONFIGURATION) private readonly configuration: PattaConfiguration,
    private readonly syncChangeRecorder: SyncChangeRecorder,
  ) {}

  async allocate(dataSource: DataSource, actorUserId: string, deviceId: string): Promise<PartiyaNumberBlockRecord> {
    return dataSource.transaction(async (manager) => {
      const sequenceRows: SequenceRow[] = await manager.query(
        `SELECT "next_number"::text AS "next_number" FROM "patta_partiya_number_sequence" WHERE "id" = 1 FOR UPDATE`,
      );
      const sequence = sequenceRows[0];
      if (!sequence) throw partiyaBlockError('PARTIYA_NUMBER_SEQUENCE_UNAVAILABLE', 'Partiya raqamlar ketma-ketligi boshlang‘ich holatga keltirilmagan');
      const activeRows: CountRow[] = await manager.query(
        `SELECT count(*)::text AS "active_count" FROM "patta_partiya_number_blocks" WHERE "device_id" = $1 AND "status" = 'ACTIVE'`,
        [deviceId],
      );
      if (BigInt(activeRows[0]?.active_count ?? '0') >= BigInt(this.configuration.maxActiveBlocksPerDevice)) {
        throw partiyaBlockError('PARTIYA_MAX_ACTIVE_BLOCKS_REACHED', 'Qurilmada faol Partiya raqam bloklari soni chegaraga yetgan');
      }
      const start = BigInt(sequence.next_number);
      const end = start + this.configuration.blockSize - 1n;
      const next = end + 1n;
      if (end > MAX_POSTGRES_BIGINT || next > MAX_POSTGRES_BIGINT) {
        throw partiyaBlockError('PARTIYA_NUMBER_RANGE_EXHAUSTED', 'Partiya raqamlar oralig‘i tugagan');
      }
      const blockRows: PartiyaBlockRow[] = await manager.query(
        `INSERT INTO "patta_partiya_number_blocks" ("device_id", "range_start", "range_end", "created_by")
         VALUES ($1, $2::bigint, $3::bigint, $4) RETURNING ${COLUMNS}`,
        [deviceId, start.toString(), end.toString(), actorUserId],
      );
      const row = blockRows[0];
      if (!row) throw new Error('Partiya number block insert did not return a record');
      await manager.query(
        `UPDATE "patta_partiya_number_sequence" SET "next_number" = $1::bigint,
         "version" = "version" + 1, "updated_at" = transaction_timestamp() WHERE "id" = 1`,
        [next.toString()],
      );
      const result = serialize(row);
      await this.auditService.append(manager, {
        actorUserId,
        entityType: 'patta_partiya_number_block',
        entityId: result.id,
        action: 'patta_partiya_number_block.allocate',
        before: null,
        after: result,
      });
      await this.recordChange(manager, result);
      return result;
    });
  }

  async reportUsage(
    dataSource: DataSource,
    deviceId: string,
    blockId: string,
    reportedUsedCount: bigint,
  ): Promise<PartiyaNumberBlockRecord> {
    if (reportedUsedCount < 0n) throw partiyaBlockError('PARTIYA_BLOCK_USAGE_INVALID', 'Ishlatilgan Partiya raqamlari soni manfiy bo‘lishi mumkin emas');
    return dataSource.transaction(async (manager) => {
      const rows: PartiyaBlockRow[] = await manager.query(
        `SELECT ${COLUMNS} FROM "patta_partiya_number_blocks" WHERE "id" = $1 FOR UPDATE`, [blockId],
      );
      const block = rows[0];
      if (!block) throw pattaNotFound('PARTIYA_NUMBER_BLOCK_NOT_FOUND', 'Partiya raqam bloki topilmadi');
      if (block.device_id !== deviceId) throw pattaForbidden('PARTIYA_NUMBER_BLOCK_DEVICE_MISMATCH', 'Partiya raqam bloki bu qurilmaga tegishli emas');
      if (block.status !== 'ACTIVE') throw partiyaBlockError('PARTIYA_NUMBER_BLOCK_TERMINAL', 'Yakunlangan Partiya raqam blokini o‘zgartirib bo‘lmaydi');
      const capacity = BigInt(block.range_end) - BigInt(block.range_start) + 1n;
      if (reportedUsedCount < BigInt(block.reported_used_count) || reportedUsedCount > capacity) {
        throw partiyaBlockError('PARTIYA_BLOCK_USAGE_INVALID', 'Blokdan foydalanish hisoboti kamaymasligi va sig‘imdan oshmasligi kerak');
      }
      const status: PartiyaBlockStatus = reportedUsedCount === capacity ? 'EXHAUSTED' : 'ACTIVE';
      const updatedRows: Array<{ id: string }> = await manager.query(
        `UPDATE "patta_partiya_number_blocks" SET "reported_used_count" = $1::bigint, "status" = $2::varchar,
         "exhausted_at" = CASE WHEN $2::varchar = 'EXHAUSTED'::varchar THEN transaction_timestamp() ELSE NULL END
         WHERE "id" = $3 RETURNING "id"`,
        [reportedUsedCount.toString(), status, blockId],
      );
      if (!updatedRows[0]) throw pattaNotFound('PARTIYA_NUMBER_BLOCK_NOT_FOUND', 'Partiya raqam bloki topilmadi');
      const refreshedRows: PartiyaBlockRow[] = await manager.query(
        `SELECT ${COLUMNS} FROM "patta_partiya_number_blocks" WHERE "id" = $1`, [blockId],
      );
      const updated = refreshedRows[0];
      if (!updated) throw pattaNotFound('PARTIYA_NUMBER_BLOCK_NOT_FOUND', 'Partiya raqam bloki topilmadi');
      const result = serialize(updated);
      await this.recordChange(manager, result);
      return result;
    });
  }

  async assertAllocatedNumber(
    dataSource: DataSource | EntityManager,
    deviceId: string,
    blockId: string,
    partiyaNumber: bigint,
  ): Promise<void> {
    const rows: Array<Pick<PartiyaBlockRow, 'device_id' | 'range_start' | 'range_end'>> =
      await dataSource.query(
        `SELECT "device_id", "range_start"::text AS "range_start", "range_end"::text AS "range_end"
         FROM "patta_partiya_number_blocks" WHERE "id" = $1`,
        [blockId],
      );
    const block = rows[0];
    if (!block) throw pattaNotFound('PARTIYA_NUMBER_BLOCK_NOT_FOUND', 'Partiya raqam bloki topilmadi');
    if (block.device_id !== deviceId) {
      throw pattaForbidden('PARTIYA_NUMBER_BLOCK_DEVICE_MISMATCH', 'Partiya raqam bloki bu qurilmaga tegishli emas');
    }
    if (partiyaNumber < BigInt(block.range_start) || partiyaNumber > BigInt(block.range_end)) {
      throw partiyaBlockError('PARTIYA_NUMBER_OUTSIDE_BLOCK', 'Partiya raqami qurilmaga ajratilgan blok oralig‘ida emas');
    }
  }

  private recordChange(manager: EntityManager, block: PartiyaNumberBlockRecord): Promise<unknown> {
    return this.syncChangeRecorder.record(manager, {
      entityType: 'patta_partiya_number_blocks',
      entityId: block.id,
      operation: 'UPSERT',
      entityVersion: null,
      projectionVersion: 2,
      payload: {
        projection_version: 2,
        entity_type: 'patta_partiya_number_blocks',
        entity_id: block.id,
        entity_version: null,
        data: {
          id: block.id,
          device_id: block.device_id,
          range_start: block.range_start,
          range_end: block.range_end,
          reported_used_count: block.reported_used_count,
          status: block.status,
          allocated_at: block.allocated_at,
          exhausted_at: block.exhausted_at,
        },
      },
    });
  }
}
