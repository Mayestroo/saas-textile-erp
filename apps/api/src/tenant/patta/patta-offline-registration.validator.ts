import { BadRequestException, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { DataSource, EntityManager } from 'typeorm';
import type { OfflinePattaCreateEvent } from '@textile/sync-protocol';
import { canonicalizeBusinessName } from '../models/business-name.js';
import { PattaNumberBlocksService } from './patta-number-blocks.service.js';
import { pattaAlreadyExists } from './patta-errors.js';

export interface OfflineOperationSnapshotInput {
  id: string;
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
  id: string;
  operation_id: string;
  operation_name_snapshot: string;
  unit_price_snapshot: string;
  sort_order: number;
}

export interface ValidatedOfflineSnapshotPayload {
  ish_soni: number;
  operations: ValidatedOfflineOperationSnapshot[];
}

export interface ValidatedOfflinePattaRegistration {
  id: string;
  partiya_number: string;
  patta_number: bigint;
  model_id: string;
  model_name_snapshot: string;
  template_id: string | null;
  konveyer_snapshot: string;
  razmer: string | null;
  rang: string | null;
  block_id: string;
  template_overrides: {
    konveyer?: string;
    razmer?: string | null;
    rang?: string | null;
  } | null;
  base_version: '0';
  client_created_at: string;
  occurred_at: string;
  reference_cursor: string;
  reference_versions: OfflinePattaCreateEvent['payload']['reference_versions'];
  ish_soni: number;
  operations: ValidatedOfflineOperationSnapshot[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSITIVE_VERSION_PATTERN = /^[1-9][0-9]*$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
const MAX_PRICE = new Decimal('999999999999.99');
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

function invalidSnapshot(message: string, field?: string): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_OFFLINE_PATTA_SNAPSHOT',
    message,
    details: field ? { field } : {},
  });
}

function invalidEvent(message: string, field?: string): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_OFFLINE_PATTA_EVENT',
    message,
    details: field ? { field } : {},
  });
}

function canonicalRequired(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw invalidEvent(`${field} matn bo‘lishi kerak`, field);
  }
  const canonical = canonicalizeBusinessName(value);
  if (!canonical) {
    throw invalidEvent(`${field} bo‘sh bo‘lishi mumkin emas`, field);
  }
  return canonical;
}

function canonicalOptional(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw invalidEvent(`${field} matn yoki null bo‘lishi kerak`, field);
  }
  return canonicalizeBusinessName(value) || null;
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw invalidEvent(`${field} UUID formati noto‘g‘ri`, field);
  }
  return value.toLowerCase();
}

function requireReferenceVersion(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !POSITIVE_VERSION_PATTERN.test(value) ||
    value.length > 19 ||
    BigInt(value) > MAX_POSTGRES_BIGINT
  ) {
    throw invalidEvent(`${field} PostgreSQL BIGINT versiyasi bo‘lishi kerak`, field);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !ISO_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw invalidEvent(`${field} ISO-8601 vaqt ko‘rinishida bo‘lishi kerak`, field);
  }
  return value;
}

@Injectable()
export class PattaOfflineRegistrationValidator {
  constructor(private readonly pattaNumberBlocksService: PattaNumberBlocksService) {}

  assertBlockMembership(
    dataSource: DataSource | EntityManager,
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
    dataSource: DataSource | EntityManager,
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

  async assertPattaIdAvailable(
    dataSource: DataSource | EntityManager,
    pattaId: string,
  ): Promise<void> {
    const rows: Array<{ exists: boolean }> = await dataSource.query(
      `SELECT EXISTS (SELECT 1 FROM "patta_hisob" WHERE "id" = $1::uuid) AS "exists"`,
      [pattaId],
    );
    if (rows[0]?.exists === true) {
      throw pattaAlreadyExists();
    }
  }

  validateRegistration(event: unknown): ValidatedOfflinePattaRegistration {
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      throw invalidEvent('Sinxronlash hodisasi obyekt bo‘lishi kerak');
    }
    const entityType = Reflect.get(event, 'entity_type') as unknown;
    const eventId = Reflect.get(event, 'event_id') as unknown;
    const entityIdValue = Reflect.get(event, 'entity_id') as unknown;
    const operation = Reflect.get(event, 'operation') as unknown;
    const baseVersion = Reflect.get(event, 'base_version') as unknown;
    if (
      typeof eventId !== 'string' ||
      !UUID_PATTERN.test(eventId) ||
      entityType !== 'patta' ||
      operation !== 'CREATE' ||
      baseVersion !== '0'
    ) {
      throw invalidEvent('Oflayn Patta faqat CREATE va base_version=0 bilan ro‘yxatdan o‘tadi');
    }

    const id = requireUuid(entityIdValue, 'entity_id');
    const clientCreatedAt = requireTimestamp(
      Reflect.get(event, 'client_created_at') as unknown,
      'client_created_at',
    );
    const occurredAt = requireTimestamp(
      Reflect.get(event, 'occurred_at') as unknown,
      'occurred_at',
    );
    const referenceCursor = Reflect.get(event, 'reference_cursor') as unknown;
    if (typeof referenceCursor !== 'string' || !/^(0|[1-9][0-9]*)$/.test(referenceCursor)) {
      throw invalidEvent('Ma’lumotnoma cursor qiymati decimal matn bo‘lishi kerak', 'reference_cursor');
    }

    const rawPayload = Reflect.get(event, 'payload') as unknown;
    if (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload)) {
      throw invalidEvent('Patta ma’lumoti obyekt bo‘lishi kerak', 'payload');
    }
    const payload = rawPayload as Record<string, unknown>;
    const allowedPayloadFields = new Set([
      'partiya_number',
      'patta_number',
      'model_id',
      'model_name_snapshot',
      'template_id',
      'konveyer_snapshot',
      'razmer',
      'rang',
      'block_id',
      'template_overrides',
      'reference_versions',
      'operations',
    ]);
    if (Object.keys(payload).some((field) => !allowedPayloadFields.has(field))) {
      throw invalidEvent('Patta payloadida noma’lum maydon mavjud', 'payload');
    }
    const partiyaNumber = canonicalRequired(payload['partiya_number'], 'partiya_number');
    const pattaNumberValue = payload['patta_number'];
    if (
      typeof pattaNumberValue !== 'string' ||
      !/^[1-9][0-9]*$/.test(pattaNumberValue) ||
      pattaNumberValue.length > 19
    ) {
      throw invalidEvent('Patta raqami musbat BIGINT decimal matn bo‘lishi kerak', 'patta_number');
    }
    const pattaNumber = BigInt(pattaNumberValue);
    if (pattaNumber > MAX_POSTGRES_BIGINT) {
      throw invalidEvent('Patta raqami PostgreSQL BIGINT chegarasidan oshmasligi kerak', 'patta_number');
    }

    const modelId = requireUuid(payload['model_id'], 'model_id');
    const modelNameSnapshot = canonicalRequired(payload['model_name_snapshot'], 'model_name_snapshot');
    const templateIdValue = payload['template_id'];
    const templateId = templateIdValue === null
      ? null
      : requireUuid(templateIdValue, 'template_id');
    const conveyor = canonicalRequired(payload['konveyer_snapshot'], 'konveyer_snapshot');
    const size = canonicalOptional(payload['razmer'], 'razmer');
    const color = canonicalOptional(payload['rang'], 'rang');
    const blockId = requireUuid(payload['block_id'], 'block_id');
    const overridesValue = payload['template_overrides'];
    let templateOverrides: ValidatedOfflinePattaRegistration['template_overrides'] = null;
    if (overridesValue !== undefined) {
      if (templateId === null || typeof overridesValue !== 'object' || overridesValue === null || Array.isArray(overridesValue)) {
        throw invalidEvent('Qolipdan tashqari qiymatlar faqat qolip tanlanganda yuboriladi', 'template_overrides');
      }
      const allowedOverrideFields = new Set(['konveyer', 'razmer', 'rang']);
      if (Object.keys(overridesValue).some((field) => !allowedOverrideFields.has(field))) {
        throw invalidEvent('Qolip o‘zgartirishlarida noma’lum maydon mavjud', 'template_overrides');
      }
      const rawConveyor = Reflect.get(overridesValue, 'konveyer') as unknown;
      const rawSize = Reflect.get(overridesValue, 'razmer') as unknown;
      const rawColor = Reflect.get(overridesValue, 'rang') as unknown;
      templateOverrides = {
        ...(rawConveyor === undefined ? {} : { konveyer: canonicalRequired(rawConveyor, 'template_overrides.konveyer') }),
        ...(rawSize === undefined ? {} : { razmer: canonicalOptional(rawSize, 'template_overrides.razmer') }),
        ...(rawColor === undefined ? {} : { rang: canonicalOptional(rawColor, 'template_overrides.rang') }),
      };
    }

    const referenceVersionsValue = payload['reference_versions'];
    if (
      typeof referenceVersionsValue !== 'object' ||
      referenceVersionsValue === null ||
      Array.isArray(referenceVersionsValue)
    ) {
      throw invalidEvent('Ma’lumotnoma versiyalari obyekt bo‘lishi kerak', 'reference_versions');
    }
    if (Object.keys(referenceVersionsValue).some((field) =>
      field !== 'model' && field !== 'template' && field !== 'operations')) {
      throw invalidEvent('Ma’lumotnoma versiyalarida noma’lum maydon mavjud', 'reference_versions');
    }
    const modelVersionValue = Reflect.get(referenceVersionsValue, 'model') as unknown;
    const templateVersionValue = Reflect.get(referenceVersionsValue, 'template') as unknown;
    const operationVersions = Reflect.get(referenceVersionsValue, 'operations') as unknown;
    const modelVersion = requireReferenceVersion(modelVersionValue, 'reference_versions.model');
    const templateVersion = templateVersionValue === null
      ? null
      : requireReferenceVersion(templateVersionValue, 'reference_versions.template');
    if (
      typeof operationVersions !== 'object' ||
      operationVersions === null ||
      Array.isArray(operationVersions)
    ) {
      throw invalidEvent('Operatsiya versiyalari obyekt bo‘lishi kerak', 'reference_versions.operations');
    }
    const versions = operationVersions as Record<string, unknown>;
    for (const [operationKey, version] of Object.entries(versions)) {
      if (!UUID_PATTERN.test(operationKey)) {
        throw invalidEvent('Operatsiya versiyasi uchun UUID formati noto‘g‘ri', 'reference_versions.operations');
      }
      requireReferenceVersion(version, `reference_versions.operations.${operationKey}`);
    }
    if ((templateId === null) !== (templateVersion === null)) {
      throw invalidEvent('Qolip ID va versiyasi bir vaqtda yuborilishi kerak', 'reference_versions.template');
    }

    const snapshot = this.validateSnapshotPayload({ operations: payload['operations'] });
    const snapshotOperationIds = new Set(snapshot.operations.map(({ operation_id }) => operation_id));
    if (
      snapshotOperationIds.size !== Object.keys(versions).length ||
      Object.keys(versions).some((operationKey) => !snapshotOperationIds.has(operationKey.toLowerCase()))
    ) {
      throw invalidEvent('Operatsiya versiyalari Patta snapshot operatsiyalariga mos emas', 'reference_versions.operations');
    }

    return {
      id,
      partiya_number: partiyaNumber,
      patta_number: pattaNumber,
      model_id: modelId,
      model_name_snapshot: modelNameSnapshot,
      template_id: templateId,
      konveyer_snapshot: conveyor,
      razmer: size,
      rang: color,
      block_id: blockId,
      template_overrides: templateOverrides,
      base_version: '0',
      client_created_at: clientCreatedAt,
      occurred_at: occurredAt,
      reference_cursor: referenceCursor,
      reference_versions: {
        model: modelVersion,
        template: templateVersion as string | null,
        operations: Object.fromEntries(
          Object.entries(versions).map(([operationKey, version]) => [
          operationKey.toLowerCase(),
          requireReferenceVersion(version, `reference_versions.operations.${operationKey}`),
          ]),
        ),
      },
      ish_soni: snapshot.ish_soni,
      operations: snapshot.operations,
    };
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
    const seenSnapshotIds = new Set<string>();
    const operations = rawOperations.map((rawOperation: unknown, index: number) => {
      if (typeof rawOperation !== 'object' || rawOperation === null || Array.isArray(rawOperation)) {
        throw invalidSnapshot('Operatsiya snapshoti obyekt bo‘lishi kerak', `operations[${index}]`);
      }
      if (Object.keys(rawOperation).some((field) =>
        field !== 'id' &&
        field !== 'operation_id' &&
        field !== 'operation_name_snapshot' &&
        field !== 'unit_price_snapshot' &&
        field !== 'sort_order')) {
        throw invalidSnapshot('Operatsiya snapshotida noma’lum maydon mavjud', `operations[${index}]`);
      }
      const operationIdValue = Reflect.get(rawOperation, 'operation_id') as unknown;
      const snapshotIdValue = Reflect.get(rawOperation, 'id') as unknown;
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

      if (typeof snapshotIdValue !== 'string' || !UUID_PATTERN.test(snapshotIdValue)) {
        throw invalidSnapshot('Snapshot ID formati noto‘g‘ri', `operations[${index}].id`);
      }
      const snapshotId = snapshotIdValue.toLowerCase();
      if (seenSnapshotIds.has(snapshotId)) {
        throw invalidSnapshot('Snapshot ID takrorlangan', `operations[${index}].id`);
      }
      seenSnapshotIds.add(snapshotId);

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
        id: snapshotId,
        operation_id: operationId,
        operation_name_snapshot: operationName,
        unit_price_snapshot: price.toFixed(2),
        sort_order: sortOrder,
      };
    });

    return { ish_soni: operations.length, operations };
  }
}
