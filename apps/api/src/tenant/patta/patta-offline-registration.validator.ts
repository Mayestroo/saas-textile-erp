import { BadRequestException, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { DataSource } from 'typeorm';
import { canonicalizeBusinessName } from '../models/business-name.js';
import { PattaNumberBlocksService } from './patta-number-blocks.service.js';
import { pattaAlreadyExists } from './patta-errors.js';

export interface OfflineOperationSnapshotInput {
  operation_id: string;
  operation_name_snapshot: string;
  unit_price_snapshot: string;
  sort_order: number;
}

export interface OfflineSnapshotPayload {
  ish_soni?: number;
  operations: readonly OfflineOperationSnapshotInput[];
}

export interface ValidatedOfflineOperationSnapshot {
  operation_id: string;
  operation_name_snapshot: string;
  unit_price_snapshot: string;
  sort_order: number;
}

export interface ValidatedOfflineSnapshotPayload {
  ish_soni: number;
  operations: ValidatedOfflineOperationSnapshot[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PRICE = new Decimal('999999999999.99');
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

function invalidSnapshot(message: string, field?: string): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_OFFLINE_PATTA_SNAPSHOT',
    message,
    details: field ? { field } : {},
  });
}

@Injectable()
export class PattaOfflineRegistrationValidator {
  constructor(private readonly pattaNumberBlocksService: PattaNumberBlocksService) {}

  assertBlockMembership(
    dataSource: DataSource,
    validatedDeviceId: string,
    blockId: string,
    pattaNumber: bigint,
  ): Promise<void> {
    return this.pattaNumberBlocksService.assertAllocatedNumber(
      dataSource,
      validatedDeviceId,
      blockId,
      pattaNumber,
    );
  }

  async assertBusinessKeyAvailable(
    dataSource: DataSource,
    partiyaNumberInput: string,
    pattaNumber: bigint,
  ): Promise<void> {
    const partiyaNumber = canonicalizeBusinessName(partiyaNumberInput);
    if (!partiyaNumber || pattaNumber <= 0n || pattaNumber > MAX_POSTGRES_BIGINT) {
      throw invalidSnapshot('Partiya yoki Patta raqami yaroqsiz');
    }
    const rows: Array<{ exists: boolean }> = await dataSource.query(
      `SELECT EXISTS (
         SELECT 1 FROM "patta_hisob"
         WHERE "partiya_number" = $1 AND "patta_number" = $2::bigint
       ) AS "exists"`,
      [partiyaNumber, pattaNumber.toString()],
    );
    if (rows[0]?.exists === true) {
      throw pattaAlreadyExists();
    }
  }

  validateSnapshotPayload(payload: unknown): ValidatedOfflineSnapshotPayload {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw invalidSnapshot('Snapshot ma’lumoti obyekt bo‘lishi kerak');
    }
    const rawOperations = Reflect.get(payload, 'operations') as unknown;
    const reportedCount = Reflect.get(payload, 'ish_soni') as unknown;
    if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
      throw invalidSnapshot('Patta snapshotida kamida bitta operatsiya bo‘lishi kerak', 'operations');
    }
    if (
      reportedCount !== undefined &&
      (!Number.isSafeInteger(reportedCount) || reportedCount !== rawOperations.length)
    ) {
      throw invalidSnapshot('Ish soni snapshot operatsiyalari soniga teng bo‘lishi kerak', 'ish_soni');
    }

    const seenOperationIds = new Set<string>();
    const operations = rawOperations.map((rawOperation: unknown, index: number) => {
      if (typeof rawOperation !== 'object' || rawOperation === null || Array.isArray(rawOperation)) {
        throw invalidSnapshot('Operatsiya snapshoti obyekt bo‘lishi kerak', `operations[${index}]`);
      }
      const operationIdValue = Reflect.get(rawOperation, 'operation_id') as unknown;
      const operationNameValue = Reflect.get(rawOperation, 'operation_name_snapshot') as unknown;
      const priceValue = Reflect.get(rawOperation, 'unit_price_snapshot') as unknown;
      const sortOrder = Reflect.get(rawOperation, 'sort_order') as unknown;
      if (typeof operationIdValue !== 'string' || !UUID_PATTERN.test(operationIdValue)) {
        throw invalidSnapshot('Operatsiya ID formati noto‘g‘ri', `operations[${index}].operation_id`);
      }
      const operationId = operationIdValue.toLowerCase();
      if (seenOperationIds.has(operationId)) {
        throw invalidSnapshot('Snapshotda bir operatsiya takrorlangan', `operations[${index}].operation_id`);
      }
      seenOperationIds.add(operationId);

      if (typeof operationNameValue !== 'string') {
        throw invalidSnapshot('Operatsiya nomi matn bo‘lishi kerak', `operations[${index}].operation_name_snapshot`);
      }
      const operationName = canonicalizeBusinessName(operationNameValue);
      if (!operationName) {
        throw invalidSnapshot('Operatsiya nomi bo‘sh bo‘lishi mumkin emas', `operations[${index}].operation_name_snapshot`);
      }

      if (typeof priceValue !== 'string') {
        throw invalidSnapshot('Narx decimal matn ko‘rinishida bo‘lishi kerak', `operations[${index}].unit_price_snapshot`);
      }
      let price: Decimal;
      try {
        price = new Decimal(priceValue);
      } catch {
        throw invalidSnapshot('Narx formati noto‘g‘ri', `operations[${index}].unit_price_snapshot`);
      }
      if (
        !price.isFinite() ||
        price.isNegative() ||
        price.decimalPlaces() > 2 ||
        price.greaterThan(MAX_PRICE)
      ) {
        throw invalidSnapshot('Narx 0 yoki undan katta, ko‘pi bilan ikki kasr xonali bo‘lishi kerak', `operations[${index}].unit_price_snapshot`);
      }

      if (typeof sortOrder !== 'number' || !Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 2_147_483_647) {
        throw invalidSnapshot('Tartib raqami 0 yoki undan katta butun son bo‘lishi kerak', `operations[${index}].sort_order`);
      }

      return {
        operation_id: operationId,
        operation_name_snapshot: operationName,
        unit_price_snapshot: price.toFixed(2),
        sort_order: sortOrder,
      };
    });

    return { ish_soni: operations.length, operations };
  }
}
