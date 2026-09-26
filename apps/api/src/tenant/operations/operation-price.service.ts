import { BadRequestException, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import {
  effectiveFromInPast,
  inactiveOperation,
  isPostgresErrorCode,
  operationNotFound,
  operationPriceConflict,
  operationPriceNotFound,
  postgresConstraint,
  versionConflict,
} from '../models/model-errors.js';

const MAX_PRICE = new Decimal('999999999999.99');

export interface OperationPriceRecord {
  id: string;
  operation_id: string;
  price: string;
  valid_from: string;
  valid_to: string | null;
  created_by: string | null;
  created_at: string;
}

export interface OperationPriceChangeInput {
  operationId: string;
  actorUserId: string;
  price: string;
  effectiveFrom?: string;
  expectedVersion: string;
}

export interface OperationPriceChangeResult extends OperationPriceRecord {
  operation_version: string;
}

interface PriceRow {
  id: string;
  operation_id: string;
  price: string | number;
  valid_from: Date | string;
  valid_to: Date | string | null;
  created_by: string | null;
  created_at: Date | string;
}

interface OperationPriceLockRow {
  id: string;
  model_id: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  version: string | number;
}

interface OpenPriceRow {
  id: string;
  price: string | number;
  valid_from: Date | string;
}

type PriceQueryExecutor = DataSource | EntityManager;

function formatTimestamp(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const isoValue = value.replace(' ', 'T');
  return isoValue.replace(/([+-][0-9]{2})$/, '$1:00');
}

function serializePrice(row: PriceRow): OperationPriceRecord {
  return {
    id: row.id,
    operation_id: row.operation_id,
    price: new Decimal(row.price).toFixed(2),
    valid_from: formatTimestamp(row.valid_from) ?? '',
    valid_to: formatTimestamp(row.valid_to),
    created_by: row.created_by,
    created_at: formatTimestamp(row.created_at) ?? '',
  };
}

export function normalizePrice(value: string): string {
  let price: Decimal;
  try {
    price = new Decimal(value);
  } catch {
    throw new BadRequestException({
      code: 'INVALID_PRICE',
      message: 'Narx 0 yoki undan katta, ko‘pi bilan ikki kasr xonali bo‘lishi kerak',
      details: {},
    });
  }
  if (
    !price.isFinite() ||
    price.isNegative() ||
    price.decimalPlaces() > 2 ||
    price.greaterThan(MAX_PRICE)
  ) {
    throw new BadRequestException({
      code: 'INVALID_PRICE',
      message: 'Narx 0 yoki undan katta, ko‘pi bilan ikki kasr xonali bo‘lishi kerak',
      details: {},
    });
  }
  return price.toFixed(2);
}

@Injectable()
export class OperationPriceService {
  constructor(private readonly auditService: AuditService) {}

  async createInitialPrice(
    manager: EntityManager,
    operationId: string,
    price: string,
    actorUserId: string,
    effectiveAt: string,
  ): Promise<OperationPriceRecord> {
    const rows: PriceRow[] = await manager.query(
      `INSERT INTO "model_operation_prices"
         ("operation_id", "price", "valid_from", "created_by")
       VALUES ($1, $2, $3::timestamptz, $4)
       RETURNING "id", "operation_id", "price"::text AS "price",
                 to_char("valid_from" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "valid_from",
                 CASE WHEN "valid_to" IS NULL THEN NULL ELSE
                   to_char("valid_to" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "valid_to",
                 "created_by",
                 to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at"`,
      [operationId, normalizePrice(price), effectiveAt, actorUserId],
    );
    const created = rows[0];
    if (!created) {
      throw new Error('Initial operation price insert did not return a record');
    }
    return serializePrice(created);
  }

  async changePrice(
    dataSource: DataSource,
    input: OperationPriceChangeInput,
  ): Promise<OperationPriceChangeResult> {
    const price = normalizePrice(input.price);
    if (input.effectiveFrom !== undefined && Number.isNaN(Date.parse(input.effectiveFrom))) {
      throw new BadRequestException({
        code: 'INVALID_EFFECTIVE_FROM',
        message: 'Narx kuchga kirish vaqti noto‘g‘ri',
        details: {},
      });
    }

    try {
      return await dataSource.transaction(async (manager) => {
        const operationRows: OperationPriceLockRow[] = await manager.query(
          `SELECT "id", "model_id", "name", "status", "version"::text AS "version"
           FROM "model_operations" WHERE "id" = $1 FOR UPDATE`,
          [input.operationId],
        );
        const operation = operationRows[0];
        if (!operation) {
          throw operationNotFound();
        }
        const currentVersion = String(operation.version);
        if (currentVersion !== input.expectedVersion) {
          throw versionConflict(input.expectedVersion, currentVersion);
        }
        if (operation.status !== 'ACTIVE') {
          throw inactiveOperation();
        }

        const clockRows: Array<{ transaction_time: string }> = await manager.query(
          'SELECT transaction_timestamp()::text AS "transaction_time"',
        );
        const transactionTime = clockRows[0]?.transaction_time;
        if (!transactionTime) {
          throw new Error('Database transaction timestamp was not returned');
        }
        const effectiveFrom = input.effectiveFrom ?? transactionTime;

        const openRows: OpenPriceRow[] = await manager.query(
          `SELECT "id", "price"::text AS "price",
                  to_char("valid_from" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "valid_from"
           FROM "model_operation_prices"
           WHERE "operation_id" = $1 AND "valid_to" IS NULL
           FOR UPDATE`,
          [input.operationId],
        );
        const openPrice = openRows[0];
        if (!openPrice) {
          throw operationPriceNotFound();
        }

        const checks: Array<{ not_past: boolean; after_open: boolean }> = await manager.query(
          `SELECT $1::timestamptz >= $2::timestamptz AS "not_past",
                  $1::timestamptz > $3::timestamptz AS "after_open"`,
          [effectiveFrom, transactionTime, openPrice.valid_from],
        );
        if (checks[0]?.not_past !== true) {
          throw effectiveFromInPast();
        }
        if (checks[0]?.after_open !== true) {
          throw operationPriceConflict('Yangi narx oxirgi ochiq narx oralig‘idan keyin boshlanishi kerak');
        }

        await manager.query(
          `UPDATE "model_operation_prices" SET "valid_to" = $1::timestamptz
           WHERE "id" = $2 AND "valid_to" IS NULL`,
          [effectiveFrom, openPrice.id],
        );

        const newPriceRows: PriceRow[] = await manager.query(
          `INSERT INTO "model_operation_prices"
             ("operation_id", "price", "valid_from", "created_by")
           VALUES ($1, $2, $3::timestamptz, $4)
           RETURNING "id", "operation_id", "price"::text AS "price",
                     to_char("valid_from" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "valid_from",
                     CASE WHEN "valid_to" IS NULL THEN NULL ELSE
                       to_char("valid_to" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "valid_to",
                     "created_by",
                     to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at"`,
          [input.operationId, price, effectiveFrom, input.actorUserId],
        );
        const newPrice = newPriceRows[0];
        if (!newPrice) {
          throw new Error('Scheduled operation price insert did not return a record');
        }

        await manager.query(
          `UPDATE "model_operations"
           SET "price" = $1, "version" = "version" + 1, "updated_at" = transaction_timestamp()
           WHERE "id" = $2 AND "version" = $3::bigint`,
          [price, input.operationId, input.expectedVersion],
        );
        const updatedOperations: Array<{ version: string | number }> = await manager.query(
          `SELECT "version"::text AS "version" FROM "model_operations" WHERE "id" = $1`,
          [input.operationId],
        );
        const updatedOperation = updatedOperations[0];
        if (!updatedOperation) {
          throw versionConflict(input.expectedVersion, currentVersion);
        }

        const record = serializePrice(newPrice);
        await this.auditService.append(manager, {
          actorUserId: input.actorUserId,
          entityType: 'operation',
          entityId: input.operationId,
          action: 'operation.price_change',
          before: {
            operation_id: input.operationId,
            operation_name: operation.name,
            operation_version: currentVersion,
            open_price: new Decimal(openPrice.price).toFixed(2),
            effective_from: formatTimestamp(openPrice.valid_from),
          },
          after: {
            operation_id: input.operationId,
            operation_name: operation.name,
            operation_version: String(updatedOperation.version),
            scheduled_price: record.price,
            effective_from: record.valid_from,
          },
        });
        return { ...record, operation_version: String(updatedOperation.version) };
      });
    } catch (error) {
      if (
        isPostgresErrorCode(error, '23P01') ||
        postgresConstraint(error) === 'ex_model_operation_prices_no_overlap'
      ) {
        throw operationPriceConflict();
      }
      throw error;
    }
  }

  async resolvePrice(
    operationId: string,
    effectiveAt: string | Date,
    dataSource: PriceQueryExecutor,
  ): Promise<string> {
    const effectiveTime = effectiveAt instanceof Date ? effectiveAt.toISOString() : effectiveAt;
    const rows: Array<{ price: string }> = await dataSource.query(
      `SELECT "price"::text AS "price"
       FROM "model_operation_prices"
       WHERE "operation_id" = $1
         AND "valid_from" <= $2::timestamptz
         AND ("valid_to" IS NULL OR $2::timestamptz < "valid_to")
       LIMIT 1`,
      [operationId, effectiveTime],
    );
    const row = rows[0];
    if (!row) {
      throw operationPriceNotFound();
    }
    return new Decimal(row.price).toFixed(2);
  }

  async resolveCurrentPrice(dataSource: PriceQueryExecutor, operationId: string): Promise<string> {
    const rows: Array<{ price: string }> = await dataSource.query(
      `SELECT "price"::text AS "price"
       FROM "model_operation_prices"
       WHERE "operation_id" = $1
         AND "valid_from" <= transaction_timestamp()
         AND ("valid_to" IS NULL OR transaction_timestamp() < "valid_to")
       LIMIT 1`,
      [operationId],
    );
    const row = rows[0];
    if (!row) {
      throw operationPriceNotFound();
    }
    return new Decimal(row.price).toFixed(2);
  }

  async resolveCurrentPrices(
    dataSource: DataSource,
    operationIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (operationIds.length === 0) {
      return new Map();
    }
    const rows: Array<{ operation_id: string; price: string }> = await dataSource.query(
      `SELECT requested."operation_id", effective."price"::text AS "price"
       FROM unnest($1::uuid[]) AS requested("operation_id")
       CROSS JOIN LATERAL (
         SELECT history."price"
         FROM "model_operation_prices" AS history
         WHERE history."operation_id" = requested."operation_id"
           AND history."valid_from" <= transaction_timestamp()
           AND (history."valid_to" IS NULL OR transaction_timestamp() < history."valid_to")
         LIMIT 1
       ) AS effective`,
      [operationIds],
    );
    return new Map(rows.map(({ operation_id, price }) => [
      operation_id,
      new Decimal(price).toFixed(2),
    ]));
  }

  async listHistory(dataSource: DataSource, operationId: string): Promise<OperationPriceRecord[]> {
    const operationRows: Array<{ id: string }> = await dataSource.query(
      `SELECT "id" FROM "model_operations" WHERE "id" = $1`,
      [operationId],
    );
    if (!operationRows[0]) {
      throw operationNotFound();
    }
    const rows: PriceRow[] = await dataSource.query(
      `SELECT "id", "operation_id", "price"::text AS "price",
              to_char("valid_from" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "valid_from",
              CASE WHEN "valid_to" IS NULL THEN NULL ELSE
                to_char("valid_to" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "valid_to",
              "created_by",
              to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at"
       FROM "model_operation_prices" WHERE "operation_id" = $1
       ORDER BY "valid_from", "id"`,
      [operationId],
    );
    return rows.map(serializePrice);
  }
}
