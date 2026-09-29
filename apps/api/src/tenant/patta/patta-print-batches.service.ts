import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { OperationPriceService } from '../operations/operation-price.service.js';
import { SyncChangeRecorder } from '../sync/sync-change-recorder.js';
import { canonicalizeBusinessName } from '../models/business-name.js';
import { postgresConstraint } from '../models/model-errors.js';
import { PATTA_CONFIGURATION } from './patta.config.js';
import type { PattaConfiguration } from './patta.config.js';
import {
  pattaBatchSizeInvalid,
  pattaModelHasNoOperations,
  pattaModelInactive,
  pattaNumberInvalid,
  pattaNumberRangeExhausted,
  pattaRecordNotFound,
  pattaReferenceDataStale,
} from './patta-errors.js';
import type { CreatePattaPrintBatchDto, PattaPrintBatchSizeDto } from './dto/create-patta-print-batch.dto.js';
import type { RecordPattaPrintEventDto } from './dto/record-patta-print-event.dto.js';
import type { LookupPattaV2Dto } from './dto/lookup-patta-v2.dto.js';
import type { CorrectPattaPrintBatchDto } from './dto/correct-patta-print-batch.dto.js';
import type { CorrectLegacyPattaQuantityDto } from './dto/correct-legacy-patta-quantity.dto.js';
import type { PattaPrintBatchProjection, PattaPrintBatchPattaProjection, PattaV2LookupMirror, SyncEvent, SyncProjectionV2 } from '@textile/sync-protocol';
import { PattaNumberBlocksService } from './patta-number-blocks.service.js';
import { PattaPartiyaNumberBlocksService } from './patta-partiya-number-blocks.service.js';
import { PattaOfflineRegistrationValidator } from './patta-offline-registration.validator.js';
import { PattaSheetsService } from '../patta-sheets/patta-sheets.service.js';

interface SequenceRow { next_number: string }
interface ModelRow { id: string; name: string; status: 'ACTIVE' | 'INACTIVE' }
interface OperationRow { id: string; name: string; sort_order: number }
interface TransactionTimeRow { transaction_time: string }
interface PattaInsertRow {
  id: string;
  partiya_number: string;
  patta_number: string;
  model_id: string;
  model_name_snapshot: string;
  template_id: string | null;
  konveyer_snapshot: string | null;
  print_batch_id: string;
  ish_soni: number | null;
  legacy_operation_count: number | null;
  status: 'ACTIVE' | 'VOID';
  version: string;
  rang: string;
  razmer: string;
  created_device_id: string;
  created_from_block_id: string | null;
  created_at: Date | string;
  client_created_at: string | null;
  occurred_at: string | null;
}

interface PrintEventRow {
  id: string;
  batch_id: string;
  revision: number;
  kind: 'INITIAL' | 'REPRINT' | 'CORRECTED_REPRINT';
  outcome: 'REQUESTED' | 'SUCCEEDED' | 'FAILED';
  actor_user_id: string;
  device_id: string;
  created_at: Date | string;
}

interface LockedBatchRow {
  id: string;
  revision: number;
  status: 'ACTIVE' | 'VOID' | 'SUPERSEDED';
  printed_at: Date | string | null;
}

interface CorrectableBatchRow extends LockedBatchRow {
  model_id: string;
  model_name_snapshot: string;
  partiya_number: string;
  partiya_block_id: string | null;
  ish_soni: number;
  rang: string;
  version: string;
  corrected_from_batch_id: string | null;
  created_by: string | null;
  created_device_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CorrectablePattaRow {
  id: string;
  partiya_number: string;
  patta_number: string;
  model_id: string;
  model_name_snapshot: string;
  template_id: string | null;
  konveyer_snapshot: string | null;
  razmer: string | null;
  rang: string | null;
  ish_soni: number | null;
  legacy_operation_count: number | null;
  status: 'ACTIVE' | 'VOID';
  print_batch_id: string | null;
  created_device_id: string;
  created_from_block_id: string | null;
  created_by: string | null;
  created_at: Date | string;
  client_created_at: Date | string | null;
  occurred_at: Date | string | null;
  version: string;
}

interface ExistingBatchSizeRow {
  id: string;
  razmer: string;
  patta_count: number;
  sort_order: number;
}

interface CorrectionEntryRow {
  patta_hisob_id: string;
  id: string;
  version: string;
  deleted_at: Date | string | null;
}

interface ExistsRow { present: boolean }
interface ServerSequenceRow { sequence: string }

interface PattaLookupRow {
  id: string;
  partiya_number: string;
  patta_number: string;
  model_id: string;
  model_name_snapshot: string;
  template_id: string | null;
  konveyer_snapshot: string | null;
  razmer: string | null;
  rang: string | null;
  ish_soni: number | null;
  legacy_operation_count: number | null;
  status: 'ACTIVE' | 'VOID';
  print_batch_id: string | null;
  created_device_id: string;
  created_from_block_id: string | null;
  version: string;
  client_created_at: Date | string | null;
  occurred_at: Date | string | null;
  printed_at: Date | string | null;
  created_at: Date | string;
}

interface PattaLookupOperationRow {
  id: string;
  operation_id: string;
  operation_name_snapshot: string;
  unit_price_snapshot: string;
  sort_order: number;
  created_at: Date | string;
}

interface BatchProjectionRow {
  id: string;
  model_id: string;
  model_name_snapshot: string;
  partiya_number: string;
  partiya_block_id: string | null;
  ish_soni: number;
  rang: string;
  status: 'ACTIVE';
  version: string;
  revision: number;
  corrected_from_batch_id: string | null;
  created_by: string | null;
  created_device_id: string;
  created_at: Date | string;
  updated_at: Date | string;
  printed_at: Date | string | null;
}

interface BatchSnapshotRow extends PattaLookupOperationRow {
  patta_hisob_id: string;
  created_at: Date | string;
}

interface CorrectedLegacyProjectionRow extends PattaLookupRow {
  created_device_id: string;
  created_from_block_id: string | null;
  client_created_at: Date | string | null;
  occurred_at: Date | string | null;
}

interface ValidatedOfflineBatchPatta {
  id: string;
  patta_number: string;
  block_id: string;
  razmer: string;
  operation_snapshots: unknown[];
}

interface ValidatedOfflineBatchPayload {
  model_id: string;
  model_name_snapshot: string;
  partiya_block_id: string;
  partiya_number: string;
  ish_soni: number;
  rang: string;
  size_distribution: Array<PattaPrintBatchSizeDto & { id: string }>;
  pattas: ValidatedOfflineBatchPatta[];
  depends_on_event_ids: string[];
}

interface ValidatedOfflineCorrectionPatta extends Omit<ValidatedOfflineBatchPatta, 'block_id'> {
  block_id: string | null;
}

interface ValidatedOfflineBatchCorrectionPayload {
  model_id: string;
  model_name_snapshot: string;
  partiya_block_id: string | null;
  partiya_number: string;
  ish_soni: number;
  rang: string;
  size_distribution: Array<PattaPrintBatchSizeDto & { id: string }>;
  pattas: ValidatedOfflineCorrectionPatta[];
  depends_on_event_ids: string[];
  correction_reason: string;
}

interface OperationSnapshotRecord {
  id: string;
  patta_hisob_id: string;
  operation_id: string;
  operation_name_snapshot: string;
  unit_price_snapshot: string;
  sort_order: number;
  created_at: string;
}

export interface PattaPrintBatchPattaRecord extends Omit<PattaInsertRow, 'created_at'> {
  created_at: string;
  operations: OperationSnapshotRecord[];
}

export interface PattaPrintBatchResult {
  id: string;
  model_id: string;
  model_name_snapshot: string;
  partiya_number: string;
  partiya_block_id: string | null;
  ish_soni: number;
  rang: string;
  status: 'ACTIVE';
  version: string;
  revision: number;
  corrected_from_batch_id: string | null;
  created_by: string | null;
  created_device_id: string;
  created_at: string;
  updated_at: string;
  printed_at: string | null;
  size_distribution: Array<{ id: string; print_batch_id: string; razmer: string; patta_count: number; sort_order: number }>;
  pattas: PattaPrintBatchPattaRecord[];
}

export interface OfflineBatchRegistrationResult {
  batch: PattaPrintBatchResult;
  changeSequence: string;
}

export interface OfflinePrintEventRegistrationResult {
  projection: SyncProjectionV2;
  changeSequence: string;
}

export interface PattaPrintEventResult {
  id: string;
  batch_id: string;
  revision: number;
  kind: PrintEventRow['kind'];
  outcome: PrintEventRow['outcome'];
  actor_user_id: string;
  device_id: string;
  created_at: string;
  printed_at: string | null;
}

export interface PattaV2LookupRecord extends Omit<PattaLookupRow, 'created_at' | 'printed_at'> {
  created_at: string;
  printed_at: string | null;
  operation_count: number;
  operations: Omit<PattaLookupOperationRow, 'created_at'>[];
  model: { id: string; name: string };
  mirror: PattaV2LookupMirror;
}

interface NormalizedSize {
  razmer: string;
  patta_count: number;
  sort_order: number;
}

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException({ code: 'PAYLOAD_INVALID', message, details: {} });
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException({ code: 'PAYLOAD_INVALID', message: `${field} noto‘g‘ri`, details: { field } });
  }
  return value;
}

function requiredUuid(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (!UUID_PATTERN.test(text)) {
    throw new BadRequestException({ code: 'PAYLOAD_INVALID', message: `${field} UUID bo‘lishi kerak`, details: { field } });
  }
  return text.toLowerCase();
}

function parseOfflineBatchPayload(value: unknown, maximum: number): ValidatedOfflineBatchPayload {
  const payload = record(value, 'Bosma to‘plam hodisasi obyekti noto‘g‘ri');
  const allowedFields = new Set([
    'model_id', 'model_name_snapshot', 'partiya_block_id', 'partiya_number', 'ish_soni', 'rang',
    'size_distribution', 'pattas', 'depends_on_event_ids',
  ]);
  if (Object.keys(payload).some((field) => !allowedFields.has(field))) {
    throw new BadRequestException({ code: 'PAYLOAD_INVALID', message: 'Bosma to‘plamda noma’lum maydon bor', details: {} });
  }
  const modelId = requiredUuid(payload['model_id'], 'model_id');
  const modelNameSnapshot = canonicalizeBusinessName(requiredText(payload['model_name_snapshot'], 'model_name_snapshot'));
  const partiyaBlockId = requiredUuid(payload['partiya_block_id'], 'partiya_block_id');
  const partiyaNumber = requiredText(payload['partiya_number'], 'partiya_number');
  if (!POSITIVE_INTEGER_PATTERN.test(partiyaNumber) || partiyaNumber.length > 19 ||
    BigInt(partiyaNumber) > MAX_POSTGRES_BIGINT) {
    throw new BadRequestException({ code: 'PATTA_PARTIYA_NUMBER_INVALID', message: 'Partiya raqami musbat BIGINT bo‘lishi kerak', details: {} });
  }
  const ishSoni = payload['ish_soni'];
  if (typeof ishSoni !== 'number' || !Number.isSafeInteger(ishSoni) || ishSoni <= 0) {
    throw new BadRequestException({ code: 'PATTA_PRINT_BATCH_INPUT_INVALID', message: 'Ish soni 0 dan katta butun son bo‘lishi kerak', details: {} });
  }
  const rang = canonicalizeBusinessName(requiredText(payload['rang'], 'rang'));
  const rawSizes = payload['size_distribution'];
  if (!Array.isArray(rawSizes) || rawSizes.length === 0) {
    throw new BadRequestException({ code: 'PATTA_SIZE_DISTRIBUTION_INVALID', message: 'Razmer taqsimoti bo‘sh bo‘lishi mumkin emas', details: {} });
  }
  const seenSizes = new Set<string>();
  const seenSortOrders = new Set<number>();
  const sizes = rawSizes.map((value) => {
    const row = record(value, 'Razmer qatori noto‘g‘ri');
    if (Object.keys(row).some((key) => !['id', 'razmer', 'patta_count', 'sort_order'].includes(key))) {
      throw new BadRequestException({ code: 'PAYLOAD_INVALID', message: 'Razmer qatorida noma’lum maydon bor', details: {} });
    }
    const id = requiredUuid(row['id'], 'size.id');
    const razmer = canonicalizeBusinessName(requiredText(row['razmer'], 'size.razmer'));
    const count = row['patta_count'];
    const order = row['sort_order'];
    if (!Number.isSafeInteger(count) || (count as number) <= 0 ||
      !Number.isSafeInteger(order) || (order as number) < 0 || seenSizes.has(razmer) ||
      seenSortOrders.has(order as number)) {
      throw new BadRequestException({ code: 'PATTA_SIZE_DISTRIBUTION_INVALID', message: 'Razmer taqsimoti noto‘g‘ri', details: {} });
    }
    seenSizes.add(razmer);
    seenSortOrders.add(order as number);
    return { id, razmer, patta_count: count as number, sort_order: order as number };
  }).sort((left, right) => left.sort_order - right.sort_order || left.razmer.localeCompare(right.razmer));
  const totalCount = sizes.reduce((sum, size) => sum + size.patta_count, 0);
  if (!Number.isSafeInteger(totalCount) || totalCount > maximum) throw pattaBatchSizeInvalid(maximum);
  const rawPattas = payload['pattas'];
  if (!Array.isArray(rawPattas) || rawPattas.length !== totalCount) {
    throw new BadRequestException({ code: 'PATTA_SIZE_DISTRIBUTION_INVALID', message: 'Patta ro‘yxati razmer taqsimotiga mos emas', details: {} });
  }
  const pattaNumbers = new Set<string>();
  const pattaIds = new Set<string>();
  const pattas = rawPattas.map((value) => {
    const row = record(value, 'Patta qatori noto‘g‘ri');
    if (Object.keys(row).some((key) => !['id', 'patta_number', 'block_id', 'razmer', 'operation_snapshots'].includes(key))) {
      throw new BadRequestException({ code: 'PAYLOAD_INVALID', message: 'Patta qatorida noma’lum maydon bor', details: {} });
    }
    const id = requiredUuid(row['id'], 'patta.id');
    const pattaNumber = requiredText(row['patta_number'], 'patta_number');
    if (!POSITIVE_INTEGER_PATTERN.test(pattaNumber) || pattaNumber.length > 19 ||
      BigInt(pattaNumber) > MAX_POSTGRES_BIGINT || pattaNumbers.has(pattaNumber) || pattaIds.has(id)) {
      throw new BadRequestException({ code: 'PATTA_NUMBER_INVALID', message: 'Patta raqami yoki identifikatori takrorlangan yoki noto‘g‘ri', details: {} });
    }
    const razmer = canonicalizeBusinessName(requiredText(row['razmer'], 'patta.razmer'));
    if (!seenSizes.has(razmer)) {
      throw new BadRequestException({ code: 'PATTA_SIZE_DISTRIBUTION_INVALID', message: 'Patta razmeri taqsimotda yo‘q', details: {} });
    }
    const snapshots = row['operation_snapshots'];
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      throw new BadRequestException({ code: 'PATTA_SNAPSHOT_MISMATCH', message: 'Patta snapshotida operatsiyalar bo‘lishi kerak', details: {} });
    }
    pattaNumbers.add(pattaNumber);
    pattaIds.add(id);
    return { id, patta_number: pattaNumber, block_id: requiredUuid(row['block_id'], 'patta.block_id'), razmer, operation_snapshots: snapshots };
  });
  const countsBySize = new Map<string, number>();
  for (const patta of pattas) countsBySize.set(patta.razmer, (countsBySize.get(patta.razmer) ?? 0) + 1);
  if (sizes.some((size) => countsBySize.get(size.razmer) !== size.patta_count)) {
    throw new BadRequestException({ code: 'PATTA_SIZE_DISTRIBUTION_INVALID', message: 'Patta soni razmer qatorlariga mos emas', details: {} });
  }
  const rawDependencies = payload['depends_on_event_ids'];
  if (!Array.isArray(rawDependencies)) {
    throw new BadRequestException({ code: 'PAYLOAD_INVALID', message: 'depends_on_event_ids ro‘yxati noto‘g‘ri', details: {} });
  }
  const dependsOnEventIds = rawDependencies.map((id) => requiredUuid(id, 'depends_on_event_id'));
  if (new Set(dependsOnEventIds).size !== dependsOnEventIds.length) {
    throw new BadRequestException({ code: 'PAYLOAD_INVALID', message: 'Bog‘liq event ID takrorlangan', details: {} });
  }
  return {
    model_id: modelId,
    model_name_snapshot: modelNameSnapshot,
    partiya_block_id: partiyaBlockId,
    partiya_number: partiyaNumber,
    ish_soni: ishSoni,
    rang,
    size_distribution: sizes,
    pattas,
    depends_on_event_ids: dependsOnEventIds,
  };
}

function normalizeSizeRows(input: readonly PattaPrintBatchSizeDto[], maximum: number): NormalizedSize[] {
  if (!Array.isArray(input) || input.length === 0) throw pattaBatchSizeInvalid(maximum);
  const seen = new Set<string>();
  const seenSortOrders = new Set<number>();
  let total = 0;
  const rows = input.map((row) => {
    const razmer = canonicalizeBusinessName(row.razmer);
    if (!razmer || !Number.isSafeInteger(row.patta_count) || row.patta_count <= 0 ||
      !Number.isSafeInteger(row.sort_order) || row.sort_order < 0 || seen.has(razmer) || seenSortOrders.has(row.sort_order)) {
      throw new BadRequestException({ code: 'PATTA_SIZE_DISTRIBUTION_INVALID', message: 'Razmer taqsimoti noto‘g‘ri', details: {} });
    }
    seen.add(razmer);
    seenSortOrders.add(row.sort_order);
    total += row.patta_count;
    return { razmer, patta_count: row.patta_count, sort_order: row.sort_order };
  });
  if (total > maximum) throw pattaBatchSizeInvalid(maximum);
  return rows.sort((left, right) => left.sort_order - right.sort_order || left.razmer.localeCompare(right.razmer));
}

function parseOfflineBatchCorrectionPayload(value: unknown, maximum: number): ValidatedOfflineBatchCorrectionPayload {
  const payload = record(value, 'Patta to‘plamini tuzatish hodisasi obyekti noto‘g‘ri');
  const allowedFields = new Set([
    'model_id', 'model_name_snapshot', 'partiya_block_id', 'partiya_number', 'ish_soni', 'rang',
    'size_distribution', 'pattas', 'depends_on_event_ids', 'correction_reason',
  ]);
  if (Object.keys(payload).some((field) => !allowedFields.has(field))) {
    throw new BadRequestException({ code: 'PAYLOAD_INVALID', message: 'Patta tuzatish hodisasida noma’lum maydon bor', details: {} });
  }
  const modelId = requiredUuid(payload['model_id'], 'model_id');
  const modelName = canonicalizeBusinessName(requiredText(payload['model_name_snapshot'], 'model_name_snapshot'));
  const partiyaBlockId = payload['partiya_block_id'] === null
    ? null : requiredUuid(payload['partiya_block_id'], 'partiya_block_id');
  const partiyaNumber = requiredText(payload['partiya_number'], 'partiya_number');
  if (!POSITIVE_INTEGER_PATTERN.test(partiyaNumber) || partiyaNumber.length > 19 ||
    BigInt(partiyaNumber) > MAX_POSTGRES_BIGINT) {
    throw new BadRequestException({ code: 'PATTA_PARTIYA_NUMBER_INVALID', message: 'Partiya raqami musbat BIGINT bo‘lishi kerak', details: {} });
  }
  const ishSoni = payload['ish_soni'];
  if (typeof ishSoni !== 'number' || !Number.isSafeInteger(ishSoni) || ishSoni < 1 || ishSoni > 2_147_483_647) {
    throw new BadRequestException({ code: 'PATTA_PRINT_BATCH_INPUT_INVALID', message: 'Ish soni noto‘g‘ri', details: {} });
  }
  const rang = canonicalizeBusinessName(requiredText(payload['rang'], 'rang'));
  const reason = canonicalizeBusinessName(requiredText(payload['correction_reason'], 'correction_reason'));
  if (reason.length < 3 || reason.length > 500) {
    throw new BadRequestException({ code: 'PATTA_CORRECTION_REASON_REQUIRED', message: 'Tuzatish sababini kiriting', details: {} });
  }
  const rawSizes = payload['size_distribution'];
  if (!Array.isArray(rawSizes)) {
    throw new BadRequestException({ code: 'PATTA_SIZE_DISTRIBUTION_INVALID', message: 'Razmer taqsimoti noto‘g‘ri', details: {} });
  }
  const sizeIds = new Set<string>();
  const sizes = rawSizes.map((value) => {
    const row = record(value, 'Razmer qatori noto‘g‘ri');
    if (Object.keys(row).some((field) => !['id', 'razmer', 'patta_count', 'sort_order'].includes(field))) {
      throw new BadRequestException({ code: 'PAYLOAD_INVALID', message: 'Razmer qatorida noma’lum maydon bor', details: {} });
    }
    const id = requiredUuid(row['id'], 'size.id');
    const count = row['patta_count'];
    const sortOrder = row['sort_order'];
    if (sizeIds.has(id) || typeof count !== 'number' || !Number.isSafeInteger(count) ||
      typeof sortOrder !== 'number' || !Number.isSafeInteger(sortOrder)) {
      throw new BadRequestException({ code: 'PATTA_SIZE_DISTRIBUTION_INVALID', message: 'Razmer taqsimoti noto‘g‘ri', details: {} });
    }
    sizeIds.add(id);
    return {
      id,
      razmer: canonicalizeBusinessName(requiredText(row['razmer'], 'size.razmer')),
      patta_count: count,
      sort_order: sortOrder,
    };
  });
  const normalizedSizes = normalizeSizeRows(sizes, maximum);
  const sizesWithIds = normalizedSizes.map((size) => {
    const source = sizes.find(({ razmer }) => razmer === size.razmer);
    if (!source) throw new Error('Validated correction size disappeared');
    return { ...size, id: source.id };
  });
  const totalCount = sizesWithIds.reduce((count, size) => count + size.patta_count, 0);
  const rawPattas = payload['pattas'];
  if (!Array.isArray(rawPattas) || rawPattas.length !== totalCount) {
    throw new BadRequestException({ code: 'PATTA_SIZE_DISTRIBUTION_INVALID', message: 'Faol Patta ro‘yxati razmer taqsimotiga mos emas', details: {} });
  }
  const pattaIds = new Set<string>();
  const pattaNumbers = new Set<string>();
  const operationSnapshotIds = new Set<string>();
  const pattas = rawPattas.map((value) => {
    const row = record(value, 'Patta qatori noto‘g‘ri');
    if (Object.keys(row).some((field) => !['id', 'patta_number', 'block_id', 'razmer', 'operation_snapshots'].includes(field))) {
      throw new BadRequestException({ code: 'PAYLOAD_INVALID', message: 'Patta qatorida noma’lum maydon bor', details: {} });
    }
    const id = requiredUuid(row['id'], 'patta.id');
    const pattaNumber = requiredText(row['patta_number'], 'patta_number');
    if (!POSITIVE_INTEGER_PATTERN.test(pattaNumber) || pattaNumber.length > 19 ||
      BigInt(pattaNumber) > MAX_POSTGRES_BIGINT || pattaIds.has(id) || pattaNumbers.has(pattaNumber)) {
      throw new BadRequestException({ code: 'PATTA_NUMBER_INVALID', message: 'Patta raqami yoki identifikatori takrorlangan yoki noto‘g‘ri', details: {} });
    }
    const blockId = row['block_id'] === null ? null : requiredUuid(row['block_id'], 'patta.block_id');
    const razmer = canonicalizeBusinessName(requiredText(row['razmer'], 'patta.razmer'));
    const operations = row['operation_snapshots'];
    if (!sizesWithIds.some((size) => size.razmer === razmer) || !Array.isArray(operations) || operations.length === 0) {
      throw new BadRequestException({ code: 'PATTA_SNAPSHOT_MISMATCH', message: 'Patta tuzatish snapshoti yoki razmeri noto‘g‘ri', details: {} });
    }
    for (const operation of operations) {
      const snapshot = record(operation, 'Patta operatsiya snapshoti noto‘g‘ri');
      const snapshotId = requiredUuid(snapshot['id'], 'operation_snapshot.id');
      if (operationSnapshotIds.has(snapshotId)) {
        throw new BadRequestException({ code: 'PATTA_SNAPSHOT_MISMATCH', message: 'Operatsiya snapshot identifikatori takrorlangan', details: {} });
      }
      operationSnapshotIds.add(snapshotId);
    }
    pattaIds.add(id);
    pattaNumbers.add(pattaNumber);
    return { id, patta_number: pattaNumber, block_id: blockId, razmer, operation_snapshots: operations };
  });
  const sizeCounts = new Map<string, number>();
  for (const patta of pattas) sizeCounts.set(patta.razmer, (sizeCounts.get(patta.razmer) ?? 0) + 1);
  if (sizesWithIds.some((size) => sizeCounts.get(size.razmer) !== size.patta_count)) {
    throw new BadRequestException({ code: 'PATTA_SIZE_DISTRIBUTION_INVALID', message: 'Faol Patta soni razmer qatorlariga mos emas', details: {} });
  }
  const dependencies = payload['depends_on_event_ids'];
  if (!Array.isArray(dependencies)) {
    throw new BadRequestException({ code: 'PAYLOAD_INVALID', message: 'Bog‘liq hodisalar ro‘yxati noto‘g‘ri', details: {} });
  }
  const dependsOnEventIds = dependencies.map((id) => requiredUuid(id, 'depends_on_event_id'));
  if (new Set(dependsOnEventIds).size !== dependsOnEventIds.length) {
    throw new BadRequestException({ code: 'PAYLOAD_INVALID', message: 'Bog‘liq hodisa identifikatori takrorlangan', details: {} });
  }
  return {
    model_id: modelId,
    model_name_snapshot: modelName,
    partiya_block_id: partiyaBlockId,
    partiya_number: partiyaNumber,
    ish_soni: ishSoni,
    rang,
    size_distribution: sizesWithIds,
    pattas,
    depends_on_event_ids: dependsOnEventIds,
    correction_reason: reason,
  };
}

function timestamp(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return value.replace(' ', 'T').replace(/([+-][0-9]{2})$/, '$1:00');
}

function serializePrintEvent(row: PrintEventRow): Omit<PattaPrintEventResult, 'printed_at'> {
  return {
    id: row.id,
    batch_id: row.batch_id,
    revision: row.revision,
    kind: row.kind,
    outcome: row.outcome,
    actor_user_id: row.actor_user_id,
    device_id: row.device_id,
    created_at: timestamp(row.created_at),
  };
}

@Injectable()
export class PattaPrintBatchesService {
  constructor(
    private readonly auditService: AuditService,
    private readonly operationPriceService: OperationPriceService,
    @Inject(PATTA_CONFIGURATION) private readonly configuration: PattaConfiguration,
    private readonly syncChangeRecorder: SyncChangeRecorder,
    private readonly pattaNumberBlocks: PattaNumberBlocksService,
    private readonly partiyaNumberBlocks: PattaPartiyaNumberBlocksService,
    private readonly offlineRegistrationValidator: PattaOfflineRegistrationValidator,
    @Optional() @Inject(PattaSheetsService) private readonly pattaSheetsService?: PattaSheetsService,
  ) {}

  async create(
    dataSource: DataSource,
    actorUserId: string,
    validatedDeviceId: string,
    input: CreatePattaPrintBatchDto,
  ): Promise<PattaPrintBatchResult> {
    if (!Number.isSafeInteger(input.ish_soni) || input.ish_soni <= 0 || !canonicalizeBusinessName(input.rang)) {
      throw new BadRequestException({ code: 'PATTA_PRINT_BATCH_INPUT_INVALID', message: 'Patta miqdori yoki rangi noto‘g‘ri', details: {} });
    }
    const sizes = normalizeSizeRows(input.size_distribution, this.configuration.maxBatchSize);
    const pattaCount = sizes.reduce((sum, row) => sum + row.patta_count, 0);
    return dataSource.transaction(async (manager) => {
      const modelRows: ModelRow[] = await manager.query(
        `SELECT "id", "name", "status" FROM "models" WHERE "id" = $1 FOR SHARE`, [input.model_id],
      );
      const model = modelRows[0];
      if (!model) throw new NotFoundException({ code: 'MODEL_NOT_FOUND', message: 'Model topilmadi', details: {} });
      if (model.status !== 'ACTIVE') throw pattaModelInactive();
      const operations: OperationRow[] = await manager.query(
        `SELECT "id", "name", "sort_order" FROM "model_operations"
         WHERE "model_id" = $1 AND "status" = 'ACTIVE' ORDER BY "sort_order", "id" FOR SHARE`,
        [model.id],
      );
      if (operations.length === 0) throw pattaModelHasNoOperations();
      const timeRows: TransactionTimeRow[] = await manager.query(
        'SELECT transaction_timestamp()::text AS "transaction_time"',
      );
      const transactionTime = timeRows[0]?.transaction_time;
      if (!transactionTime) throw new Error('Database transaction timestamp was not returned');
      const operationSnapshots: Array<{
        operation_id: string;
        operation_name_snapshot: string;
        unit_price_snapshot: string;
        sort_order: number;
      }> = [];
      for (const operation of operations) {
        operationSnapshots.push({
          operation_id: operation.id,
          operation_name_snapshot: operation.name,
          unit_price_snapshot: await this.operationPriceService.resolvePrice(operation.id, transactionTime, manager),
          sort_order: operation.sort_order,
        });
      }

      // All print paths acquire number allocators in this same order.
      const partiyaSequenceRows: SequenceRow[] = await manager.query(
        `SELECT "next_number"::text AS "next_number" FROM "patta_partiya_number_sequence" WHERE "id" = 1 FOR UPDATE`,
      );
      const pattaSequenceRows: SequenceRow[] = await manager.query(
        `SELECT "next_number"::text AS "next_number" FROM "patta_number_sequence" WHERE "id" = 1 FOR UPDATE`,
      );
      const partiyaSequence = partiyaSequenceRows[0];
      const pattaSequence = pattaSequenceRows[0];
      if (!partiyaSequence || !pattaSequence) {
        throw new Error('Patta print number sequences are not initialized');
      }
      const partiyaNumber = BigInt(partiyaSequence.next_number);
      const firstPattaNumber = BigInt(pattaSequence.next_number);
      const lastPattaNumber = firstPattaNumber + BigInt(pattaCount) - 1n;
      if (partiyaNumber >= MAX_POSTGRES_BIGINT || lastPattaNumber >= MAX_POSTGRES_BIGINT) {
        throw pattaNumberRangeExhausted();
      }

      const batchId = randomUUID();
      const batchRows = await manager.query(
        `INSERT INTO "patta_print_batches"
          ("id", "model_id", "model_name_snapshot", "partiya_number", "ish_soni", "rang", "created_by", "created_device_id")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
           to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at"`,
        [batchId, model.id, model.name, partiyaNumber.toString(), input.ish_soni, canonicalizeBusinessName(input.rang), actorUserId, validatedDeviceId],
      );
      const createdAt = batchRows[0]?.created_at as string | undefined;
      const updatedAt = batchRows[0]?.updated_at as string | undefined;
      if (!createdAt) throw new Error('Patta print batch insert did not return created_at');
      if (!updatedAt) throw new Error('Patta print batch insert did not return updated_at');

      const persistedSizes: PattaPrintBatchResult['size_distribution'] = [];
      const pattas: PattaPrintBatchPattaRecord[] = [];
      for (const size of sizes) {
        const sizeId = randomUUID();
        await manager.query(
          `INSERT INTO "patta_print_batch_sizes" ("id", "print_batch_id", "razmer", "patta_count", "sort_order")
           VALUES ($1, $2, $3, $4, $5)`,
          [sizeId, batchId, size.razmer, size.patta_count, size.sort_order],
        );
        persistedSizes.push({ id: sizeId, print_batch_id: batchId, ...size });
      }

      let numberOffset = 0n;
      for (const size of sizes) {
        for (let index = 0; index < size.patta_count; index += 1) {
          const pattaId = randomUUID();
          const pattaNumber = firstPattaNumber + numberOffset;
          numberOffset += 1n;
          const pattaRows: PattaInsertRow[] = await manager.query(
            `INSERT INTO "patta_hisob"
              ("id", "partiya_number", "patta_number", "model_id", "model_name_snapshot", "konveyer_snapshot",
               "razmer", "rang", "ish_soni", "created_device_id", "created_by", "print_batch_id", "status")
             VALUES ($1, $2, $3::bigint, $4, $5, NULL, $6, $7, $8, $9, $10, $11, 'ACTIVE')
             RETURNING "id", "partiya_number", "patta_number"::text AS "patta_number", "model_id",
               "model_name_snapshot", "template_id", "konveyer_snapshot", "print_batch_id", "ish_soni",
               "legacy_operation_count", "status", "version"::text AS "version", "rang", "razmer", "created_device_id",
               "created_from_block_id", "client_created_at", "occurred_at",
               to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at"`,
            [pattaId, partiyaNumber.toString(), pattaNumber.toString(), model.id, model.name, size.razmer,
              canonicalizeBusinessName(input.rang), input.ish_soni, validatedDeviceId, actorUserId, batchId],
          );
          const patta = pattaRows[0];
          if (!patta) throw new Error('Patta insert did not return a record');
          const snapshots: OperationSnapshotRecord[] = [];
          for (const snapshot of operationSnapshots) {
            const snapshotId = randomUUID();
            await manager.query(
              `INSERT INTO "patta_operation_snapshots"
                ("id", "patta_hisob_id", "operation_id", "operation_name_snapshot", "unit_price_snapshot", "sort_order")
               VALUES ($1, $2, $3, $4, $5::numeric(14,2), $6)`,
              [snapshotId, pattaId, snapshot.operation_id, snapshot.operation_name_snapshot,
                snapshot.unit_price_snapshot, snapshot.sort_order],
            );
            snapshots.push({
              id: snapshotId,
              patta_hisob_id: pattaId,
              ...snapshot,
              created_at: timestamp(transactionTime),
            });
          }
          pattas.push({ ...patta, created_at: timestamp(patta.created_at), operations: snapshots });
        }
      }
      await manager.query(
        `UPDATE "patta_partiya_number_sequence" SET "next_number" = $1::bigint,
         "version" = "version" + 1, "updated_at" = transaction_timestamp() WHERE "id" = 1`,
        [(partiyaNumber + 1n).toString()],
      );
      await manager.query(
        `UPDATE "patta_number_sequence" SET "next_number" = $1::bigint,
         "version" = "version" + 1, "updated_at" = transaction_timestamp() WHERE "id" = 1`,
        [(lastPattaNumber + 1n).toString()],
      );

      const result: PattaPrintBatchResult = {
        id: batchId,
        model_id: model.id,
        model_name_snapshot: model.name,
        partiya_number: partiyaNumber.toString(),
        partiya_block_id: null,
        ish_soni: input.ish_soni,
        rang: canonicalizeBusinessName(input.rang),
        status: 'ACTIVE',
        version: '1',
        revision: 1,
        corrected_from_batch_id: null,
        created_by: actorUserId,
        created_device_id: validatedDeviceId,
        created_at: timestamp(createdAt),
        updated_at: timestamp(updatedAt),
        printed_at: null,
        size_distribution: persistedSizes,
        pattas,
      };
      await this.auditService.append(manager, {
        actorUserId,
        deviceId: validatedDeviceId,
        entityType: 'patta_print_batch',
        entityId: batchId,
        action: 'patta_print_batch.create',
        before: null,
        after: result,
      });
      await this.recordBatchChange(manager, result);
      return result;
    });
  }

  async correctBatch(
    dataSource: DataSource,
    actorUserId: string,
    validatedDeviceId: string,
    batchIdInput: string,
    input: CorrectPattaPrintBatchDto,
  ): Promise<PattaPrintBatchResult> {
    return dataSource.transaction(async (manager) => {
      const corrected = await this.correctBatchInTransaction(
        manager, actorUserId, validatedDeviceId, batchIdInput, input,
      );
      return corrected.batch;
    });
  }

  async correctBatchInTransaction(
    manager: EntityManager,
    actorUserId: string,
    validatedDeviceId: string,
    batchIdInput: string,
    input: CorrectPattaPrintBatchDto,
    correctionEventId: string | null = null,
    offlineCorrection?: ValidatedOfflineBatchCorrectionPayload,
    offlineTimestamps?: { clientCreatedAt: string; occurredAt: string },
  ): Promise<{ batch: PattaPrintBatchResult; changeSequence: string }> {
    const batchId = requiredUuid(batchIdInput, 'batch_id');
    const expectedVersion = requiredText(input.expected_version, 'expected_version');
    if (!POSITIVE_INTEGER_PATTERN.test(expectedVersion) || expectedVersion.length > 19 ||
      BigInt(expectedVersion) > MAX_POSTGRES_BIGINT) {
      throw new BadRequestException({ code: 'VERSION_INVALID', message: 'Versiya musbat BIGINT bo‘lishi kerak', details: {} });
    }
    const reason = canonicalizeBusinessName(requiredText(input.correction_reason, 'correction_reason'));
    if (reason.length < 3 || reason.length > 500) {
      throw new BadRequestException({ code: 'PATTA_CORRECTION_REASON_REQUIRED', message: 'Tuzatish sababini kiriting', details: {} });
    }
    if (!Number.isSafeInteger(input.ish_soni) || input.ish_soni < 1 || input.ish_soni > 2_147_483_647) {
      throw new BadRequestException({ code: 'PATTA_PRINT_BATCH_INPUT_INVALID', message: 'Ish soni noto‘g‘ri', details: {} });
    }
    const rang = canonicalizeBusinessName(input.rang);
    if (!rang) throw new BadRequestException({ code: 'PATTA_PRINT_BATCH_INPUT_INVALID', message: 'Rangni kiriting', details: {} });
    const sizes = normalizeSizeRows(input.size_distribution, this.configuration.maxBatchSize);

      const batchRows: CorrectableBatchRow[] = await manager.query(
        `SELECT "id", "model_id", "model_name_snapshot", "partiya_number", "partiya_block_id",
                "ish_soni", "rang", "status", "version"::text AS "version", "revision",
                "corrected_from_batch_id", "created_by", "created_device_id", "printed_at",
                to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
                to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at"
         FROM "patta_print_batches" WHERE "id" = $1 FOR UPDATE`,
        [batchId],
      );
      const batch = batchRows[0];
      if (!batch) throw new NotFoundException({ code: 'PATTA_PRINT_BATCH_NOT_FOUND', message: 'Patta bosma to‘plami topilmadi', details: {} });
      await this.assertTenantPermission(manager, actorUserId, 'patta.chiqarish.correct');
      if (offlineCorrection && (
        offlineCorrection.model_id !== batch.model_id ||
        offlineCorrection.model_name_snapshot !== batch.model_name_snapshot ||
        offlineCorrection.partiya_number !== batch.partiya_number ||
        offlineCorrection.partiya_block_id !== batch.partiya_block_id
      )) {
        throw new ConflictException({
          code: 'PATTA_BATCH_IDENTITY_CORRECTION_REQUIRES_REPLACEMENT',
          message: 'Model yoki Partiya o‘zgarishi yangi Patta to‘plami orqali bajariladi',
          details: {},
        });
      }
      if (batch.status !== 'ACTIVE') {
        throw new ConflictException({ code: 'PATTA_PRINT_BATCH_INACTIVE', message: 'Faol bo‘lmagan Patta to‘plamini tuzatib bo‘lmaydi', details: {} });
      }
      if (batch.version !== expectedVersion) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          message: 'Patta to‘plami boshqa foydalanuvchi tomonidan o‘zgartirilgan',
          details: { expected_version: expectedVersion, current_version: batch.version },
        });
      }
      const nextVersion = BigInt(batch.version) + 1n;
      const nextRevision = batch.revision + 1;
      if (nextVersion > MAX_POSTGRES_BIGINT || !Number.isSafeInteger(nextRevision)) {
        throw pattaNumberRangeExhausted();
      }

      const existingSizes: ExistingBatchSizeRow[] = await manager.query(
        `SELECT "id", "razmer", "patta_count", "sort_order" FROM "patta_print_batch_sizes"
         WHERE "print_batch_id" = $1 ORDER BY "sort_order", "razmer" FOR UPDATE`,
        [batchId],
      );
      if (offlineCorrection?.size_distribution.some((size) => {
        const original = existingSizes.find((candidate) => candidate.razmer === size.razmer);
        return (original !== undefined && original.id !== size.id) ||
          (original === undefined && existingSizes.some((candidate) => candidate.id === size.id));
      })) {
        throw new ConflictException({ code: 'PATTA_CORRECTION_PAYLOAD_MISMATCH', message: 'Razmer qatori identifikatori o‘zgartirilgan', details: {} });
      }
      const activePattas: CorrectablePattaRow[] = await manager.query(
        `SELECT "id", "partiya_number", "patta_number"::text AS "patta_number", "model_id",
                "model_name_snapshot", "template_id", "konveyer_snapshot", "razmer", "rang",
                "ish_soni", "legacy_operation_count", "status", "print_batch_id",
                "created_device_id", "created_from_block_id", "created_by",
                "created_at", "client_created_at", "occurred_at", "version"::text AS "version"
         FROM "patta_hisob" WHERE "print_batch_id" = $1 AND "status" = 'ACTIVE'
         ORDER BY "patta_number" FOR UPDATE`,
        [batchId],
      );
      const entryTableRows: ExistsRow[] = await manager.query(
        `SELECT to_regclass('public.patta_sheets') IS NOT NULL AS "present"`,
      );
      let entries: CorrectionEntryRow[] = [];
      if (entryTableRows[0]?.present === true && activePattas.length > 0) {
        entries = await manager.query(
          `SELECT "id", "patta_hisob_id"::text AS "patta_hisob_id",
                  "version"::text AS "version", "deleted_at"
           FROM "patta_sheets" WHERE "patta_hisob_id" = ANY($1::uuid[])
           ORDER BY "patta_hisob_id" FOR UPDATE`,
          [activePattas.map(({ id }) => id)],
        );
      }
      const entriesByPatta = new Map<string, CorrectionEntryRow>();
      for (const entry of entries) entriesByPatta.set(entry.patta_hisob_id, entry);

      const remaining = new Map(sizes.map((size) => [size.razmer, size.patta_count]));
      const assignments = new Map<string, string>();
      const unmatched: CorrectablePattaRow[] = [];
      for (const patta of activePattas) {
        const available = patta.razmer === null ? 0 : (remaining.get(patta.razmer) ?? 0);
        if (available > 0 && patta.razmer !== null) {
          assignments.set(patta.id, patta.razmer);
          remaining.set(patta.razmer, available - 1);
        } else {
          unmatched.push(patta);
        }
      }
      const targetSlots = sizes.flatMap((size) =>
        Array.from({ length: remaining.get(size.razmer) ?? 0 }, () => size.razmer),
      );
      const remappableCount = Math.min(unmatched.length, targetSlots.length);
      for (let index = 0; index < remappableCount; index += 1) {
        const patta = unmatched[index];
        const targetSize = targetSlots[index];
        if (patta && targetSize) assignments.set(patta.id, targetSize);
      }
      const surplus = unmatched.slice(remappableCount);
      const deficits = targetSlots.slice(remappableCount);
      const affectedPattaIds = new Set<string>([
        ...[...assignments.entries()]
          .filter(([id, newSize]) => activePattas.find((patta) => patta.id === id)?.razmer !== newSize)
          .map(([id]) => id),
        ...surplus.map(({ id }) => id),
      ]);
      if ([...affectedPattaIds].some((id) => entriesByPatta.has(id))) {
        throw new ConflictException({
          code: 'PATTA_ALREADY_IN_USE',
          message: 'Kiritilgan yoki Korzinkadagi Patta razmeri/raqamini tuzatib bo‘lmaydi',
          details: { patta_ids: [...affectedPattaIds].filter((id) => entriesByPatta.has(id)) },
        });
      }
      if (entries.length > 0) {
        await this.assertTenantPermission(manager, actorUserId, 'patta_varaq.edit');
      }

      const batchSnapshotRows: BatchSnapshotRow[] = activePattas.length > 0 &&
        (offlineCorrection !== undefined || deficits.length > 0)
        ? await manager.query(
          `SELECT snapshot."id", snapshot."patta_hisob_id", snapshot."operation_id",
                  snapshot."operation_name_snapshot", snapshot."unit_price_snapshot"::text AS "unit_price_snapshot",
                  snapshot."sort_order",
                  to_char(snapshot."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at"
           FROM "patta_operation_snapshots" snapshot
           JOIN "patta_hisob" patta ON patta."id" = snapshot."patta_hisob_id"
           WHERE patta."print_batch_id" = $1 ORDER BY patta."patta_number", snapshot."sort_order"`,
          [batchId],
        )
        : [];
      const snapshotsByPatta = new Map<string, BatchSnapshotRow[]>();
      for (const snapshot of batchSnapshotRows) {
        const rows = snapshotsByPatta.get(snapshot.patta_hisob_id) ?? [];
        rows.push(snapshot);
        snapshotsByPatta.set(snapshot.patta_hisob_id, rows);
      }
      const offlineNewPattas = new Map<string, ValidatedOfflineCorrectionPatta>();
      const offlineNewPattasBySize = new Map<string, ValidatedOfflineCorrectionPatta[]>();
      const validatedOfflineSnapshots = new Map<string, ReturnType<PattaOfflineRegistrationValidator['validateSnapshotPayload']>['operations']>();
      if (offlineCorrection) {
        const currentById = new Map(activePattas.map((patta) => [patta.id, patta]));
        if (offlineCorrection.pattas.length !== assignments.size + deficits.length) {
          throw new ConflictException({ code: 'PATTA_CORRECTION_PAYLOAD_MISMATCH', message: 'Tuzatish hodisasidagi Patta ro‘yxati noto‘g‘ri', details: {} });
        }
        for (const submitted of offlineCorrection.pattas) {
          const current = currentById.get(submitted.id);
          if (current) {
            const expectedSize = assignments.get(current.id);
            if (!expectedSize || submitted.patta_number !== current.patta_number || submitted.razmer !== expectedSize ||
              submitted.block_id !== current.created_from_block_id) {
              throw new ConflictException({ code: 'PATTA_CORRECTION_PAYLOAD_MISMATCH', message: 'Mavjud Patta identifikatori yoki raqami o‘zgartirilgan', details: { patta_id: submitted.id } });
            }
          } else {
            offlineNewPattas.set(submitted.id, submitted);
            const bySize = offlineNewPattasBySize.get(submitted.razmer) ?? [];
            bySize.push(submitted);
            offlineNewPattasBySize.set(submitted.razmer, bySize);
          }
          const validated = this.offlineRegistrationValidator.validateSnapshotPayload({
            ish_soni: input.ish_soni,
            operations: submitted.operation_snapshots,
          });
          const original = current
            ? snapshotsByPatta.get(current.id) ?? []
            : (activePattas[0] ? snapshotsByPatta.get(activePattas[0].id) ?? [] : []);
          if (validated.operations.length !== original.length || validated.operations.some((operation, index) => {
            const snapshot = original[index];
            return !snapshot || operation.operation_id !== snapshot.operation_id ||
              operation.operation_name_snapshot !== snapshot.operation_name_snapshot ||
              operation.unit_price_snapshot !== snapshot.unit_price_snapshot ||
              operation.sort_order !== snapshot.sort_order || (current && operation.id !== snapshot.id);
          })) {
            throw new ConflictException({ code: 'PATTA_SNAPSHOT_MISMATCH', message: 'Tuzatish Patta operatsiya tarixi o‘zgartirilgan', details: { patta_id: submitted.id } });
          }
          validatedOfflineSnapshots.set(submitted.id, validated.operations);
        }
        if (offlineNewPattas.size !== deficits.length) {
          throw new ConflictException({ code: 'PATTA_CORRECTION_PAYLOAD_MISMATCH', message: 'Yangi Patta soni tuzatilgan taqsimotga mos emas', details: {} });
        }
        const availableOfflinePattas = new Map(
          [...offlineNewPattasBySize.entries()].map(([size, pattas]) => [size, [...pattas]]),
        );
        for (const sizeName of deficits) {
          const matching = availableOfflinePattas.get(sizeName)?.shift();
          if (!matching) {
            throw new ConflictException({ code: 'PATTA_CORRECTION_PAYLOAD_MISMATCH', message: 'Yangi Patta razmerlari taqsimotga mos emas', details: {} });
          }
          const validated = validatedOfflineSnapshots.get(matching.id) ?? [];
          if (matching.block_id === null) {
            throw new ConflictException({ code: 'PATTA_NUMBER_OUTSIDE_BLOCK', message: 'Yangi offline Patta ajratilgan blokdan raqam olishi kerak', details: {} });
          }
          await this.pattaNumberBlocks.assertAllocatedNumber(manager, validatedDeviceId, matching.block_id, BigInt(matching.patta_number));
          const usedRows: Array<{ used: boolean }> = await manager.query(
            `SELECT EXISTS (SELECT 1 FROM "patta_hisob" WHERE "patta_number" = $1::bigint OR "id" = $2::uuid) AS "used"`,
            [matching.patta_number, matching.id],
          );
          if (usedRows[0]?.used === true) {
            throw new ConflictException({ code: 'PATTA_ALREADY_EXISTS', message: 'Ajratilgan Patta raqami oldin ishlatilgan', details: { patta_number: matching.patta_number } });
          }
          const expectedSnapshotRows = activePattas[0] ? snapshotsByPatta.get(activePattas[0].id) ?? [] : [];
          if (validated.length !== expectedSnapshotRows.length || validated.some((operation, index) => {
            const snapshot = expectedSnapshotRows[index];
            return !snapshot || operation.operation_id !== snapshot.operation_id ||
              operation.operation_name_snapshot !== snapshot.operation_name_snapshot ||
              operation.unit_price_snapshot !== snapshot.unit_price_snapshot ||
              operation.sort_order !== snapshot.sort_order;
          })) {
            throw new ConflictException({ code: 'PATTA_SNAPSHOT_MISMATCH', message: 'Yangi Patta tarixiy operatsiya narxlari mos emas', details: { patta_id: matching.id } });
          }
        }
      }

      const correctionId = randomUUID();
      const oldSizeIds = new Map(existingSizes.map(({ razmer, id }) => [razmer, id]));
      const offlineSizeIds = new Map(offlineCorrection?.size_distribution.map(({ id, razmer }) => [razmer, id]) ?? []);
      const nextSizes = sizes.map((size) => ({
        id: oldSizeIds.get(size.razmer) ?? offlineSizeIds.get(size.razmer) ?? randomUUID(),
        print_batch_id: batchId,
        ...size,
      }));
      const before = {
        model_id: batch.model_id,
        model_name_snapshot: batch.model_name_snapshot,
        partiya_number: batch.partiya_number,
        ish_soni: batch.ish_soni,
        rang: batch.rang,
        revision: batch.revision,
        version: batch.version,
        size_distribution: existingSizes,
        pattas: activePattas.map(({ id, patta_number, razmer, ish_soni, rang, status }) =>
          ({ id, patta_number, razmer, ish_soni, rang, status })),
      };
      const after = {
        ish_soni: input.ish_soni,
        rang,
        revision: nextRevision,
        version: nextVersion.toString(),
        size_distribution: nextSizes,
        remapped_patta_ids: [...assignments.entries()]
          .filter(([id, size]) => activePattas.find((patta) => patta.id === id)?.razmer !== size)
          .map(([id]) => id),
        voided_patta_ids: surplus.map(({ id }) => id),
        new_patta_count: deficits.length,
      };
      await manager.query(
        `INSERT INTO "patta_print_batch_corrections"
          ("id", "batch_id", "from_version", "to_version", "from_revision", "to_revision",
           "reason", "before_json", "after_json", "actor_user_id", "device_id", "event_id")
          VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)`,
        [correctionId, batchId, batch.version, nextVersion.toString(), batch.revision, nextRevision,
          reason, JSON.stringify(before), JSON.stringify(after), actorUserId, validatedDeviceId, correctionEventId],
      );

      for (const oldSize of existingSizes) {
        const replacement = nextSizes.find(({ razmer }) => razmer === oldSize.razmer);
        if (replacement) {
          await manager.query(
            `UPDATE "patta_print_batch_sizes" SET "patta_count" = $1, "sort_order" = $2
             WHERE "id" = $3`,
            [replacement.patta_count, replacement.sort_order, oldSize.id],
          );
        } else {
          await manager.query('DELETE FROM "patta_print_batch_sizes" WHERE "id" = $1', [oldSize.id]);
        }
      }
      for (const size of nextSizes) {
        if (oldSizeIds.has(size.razmer)) continue;
        await manager.query(
          `INSERT INTO "patta_print_batch_sizes" ("id", "print_batch_id", "razmer", "patta_count", "sort_order")
           VALUES ($1, $2, $3, $4, $5)`,
          [size.id, batchId, size.razmer, size.patta_count, size.sort_order],
        );
      }
      const nextNumber = offlineCorrection
        ? 0n
        : await this.allocateCorrectionPattaNumbers(manager, deficits.length);
      await manager.query(
        `UPDATE "patta_print_batches" SET "ish_soni" = $1, "rang" = $2,
          "version" = $3::bigint, "revision" = $4, "updated_at" = transaction_timestamp()
         WHERE "id" = $5`,
        [input.ish_soni, rang, nextVersion.toString(), nextRevision, batchId],
      );

      for (const patta of activePattas) {
        const assignedSize = assignments.get(patta.id);
        if (assignedSize) {
          await manager.query(
            `UPDATE "patta_hisob" SET "ish_soni" = $1, "rang" = $2, "razmer" = $3,
              "version" = "version" + 1, "updated_at" = transaction_timestamp()
             WHERE "id" = $4`,
            [input.ish_soni, rang, assignedSize, patta.id],
          );
        }
      }
      for (const patta of surplus) {
        await manager.query(
          `UPDATE "patta_hisob" SET "status" = 'VOID', "version" = "version" + 1,
            "updated_at" = transaction_timestamp() WHERE "id" = $1`,
          [patta.id],
        );
      }
      if (deficits.length > 0) {
        const templateSnapshots = batchSnapshotRows.filter(({ patta_hisob_id }) =>
          activePattas.some(({ id }) => id === patta_hisob_id),
        );
        const distinctSnapshots = new Map(templateSnapshots.map((snapshot) => [snapshot.operation_id, snapshot]));
        if (distinctSnapshots.size === 0) {
          throw new ConflictException({ code: 'PATTA_SNAPSHOT_MISMATCH', message: 'Yangi Patta uchun operatsiya tarixi topilmadi', details: {} });
        }
        const offlinePattaOffsets = new Map<string, number>();
        for (const [index, sizeName] of deficits.entries()) {
          const sizeOffset = offlinePattaOffsets.get(sizeName) ?? 0;
          const offlinePatta = offlineNewPattasBySize.get(sizeName)?.[sizeOffset];
          offlinePattaOffsets.set(sizeName, sizeOffset + 1);
          if (offlineCorrection && !offlinePatta) {
            throw new ConflictException({ code: 'PATTA_CORRECTION_PAYLOAD_MISMATCH', message: 'Yangi Patta taqsimoti topilmadi', details: {} });
          }
          const pattaId = offlinePatta?.id ?? randomUUID();
          const pattaNumber = offlinePatta ? BigInt(offlinePatta.patta_number) : nextNumber + BigInt(index);
          const size = nextSizes.find(({ razmer }) => razmer === sizeName);
          if (!size) throw new Error('Correction target size disappeared');
          await manager.query(
            `INSERT INTO "patta_hisob"
              ("id", "partiya_number", "patta_number", "model_id", "model_name_snapshot",
               "template_id", "konveyer_snapshot", "razmer", "rang", "ish_soni",
                "created_device_id", "created_from_block_id", "created_by", "client_created_at",
                "occurred_at", "print_batch_id", "status")
              VALUES ($1, $2, $3::bigint, $4, $5, NULL, NULL, $6, $7, $8, $9, $10, $11,
                $12::timestamptz, $13::timestamptz, $14, 'ACTIVE')`,
            [pattaId, batch.partiya_number, pattaNumber.toString(), batch.model_id, batch.model_name_snapshot,
              sizeName, rang, input.ish_soni, validatedDeviceId, offlinePatta?.block_id ?? null,
              actorUserId, offlineTimestamps?.clientCreatedAt ?? null, offlineTimestamps?.occurredAt ?? null, batchId],
          );
          const snapshotsForNewPatta = offlinePatta
            ? validatedOfflineSnapshots.get(offlinePatta.id) ?? []
            : [...distinctSnapshots.values()].map((snapshot) => ({
              id: randomUUID(), operation_id: snapshot.operation_id,
              operation_name_snapshot: snapshot.operation_name_snapshot,
              unit_price_snapshot: snapshot.unit_price_snapshot, sort_order: snapshot.sort_order,
            }));
          for (const snapshot of snapshotsForNewPatta) {
            await manager.query(
              `INSERT INTO "patta_operation_snapshots"
                ("id", "patta_hisob_id", "operation_id", "operation_name_snapshot", "unit_price_snapshot", "sort_order")
               VALUES ($1, $2, $3, $4, $5::numeric(14,2), $6)`,
              [snapshot.id, pattaId, snapshot.operation_id, snapshot.operation_name_snapshot,
                snapshot.unit_price_snapshot, snapshot.sort_order],
            );
          }
        }
      }
      if (entries.length > 0 && batch.ish_soni !== input.ish_soni) {
        if (!this.pattaSheetsService) throw new Error('Patta Sheet correction service is not registered');
        await this.pattaSheetsService.correctQuantitySnapshots(
          manager, actorUserId, validatedDeviceId, entries.map(({ id }) => id), input.ish_soni, reason,
        );
      }
      const result = await this.loadBatchProjection(manager, batchId);
      await this.auditService.append(manager, {
        actorUserId,
        deviceId: validatedDeviceId,
        entityType: 'patta_print_batch',
        entityId: batchId,
        action: 'patta_print_batch.correct',
        before,
        after: { ...after, correction_reason: reason, batch: result },
      });
      const change = await this.recordBatchChange(manager, result);
      return { batch: result, changeSequence: change.sequenceId };
  }

  async correctLegacyQuantity(
    dataSource: DataSource,
    actorUserId: string,
    validatedDeviceId: string,
    pattaIdInput: string,
    input: CorrectLegacyPattaQuantityDto,
  ): Promise<{ patta_id: string; ish_soni: number; legacy_operation_count: number; version: string }> {
    const pattaId = requiredUuid(pattaIdInput, 'patta_id');
    const expectedVersion = requiredText(input.expected_version, 'expected_version');
    const reason = canonicalizeBusinessName(requiredText(input.correction_reason, 'correction_reason'));
    if (!POSITIVE_INTEGER_PATTERN.test(expectedVersion) || reason.length < 3 || reason.length > 500 ||
      !Number.isSafeInteger(input.ish_soni) || input.ish_soni < 1 || input.ish_soni > 2_147_483_647) {
      throw new BadRequestException({ code: 'PATTA_LEGACY_QUANTITY_CORRECTION_INVALID', message: 'Legacy Patta miqdorini tuzatish ma’lumoti noto‘g‘ri', details: {} });
    }
    return dataSource.transaction(async (manager) => {
      const rows: Array<{
        id: string; ish_soni: number | null; legacy_operation_count: number | null;
        version: string; print_batch_id: string | null;
      }> = await manager.query(
        `SELECT "id", "ish_soni", "legacy_operation_count", "version"::text AS "version", "print_batch_id"
         FROM "patta_hisob" WHERE "id" = $1 FOR UPDATE`, [pattaId],
      );
      const patta = rows[0];
      if (!patta) throw pattaRecordNotFound();
      await this.assertTenantPermission(manager, actorUserId, 'patta.chiqarish.correct');
      if (patta.print_batch_id !== null || patta.ish_soni !== null || patta.legacy_operation_count === null) {
        throw new ConflictException({ code: 'PATTA_LEGACY_QUANTITY_ALREADY_CORRECTED', message: 'Bu legacy Patta miqdorini bir marta tuzatish mumkin', details: {} });
      }
      if (patta.version !== expectedVersion) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          message: 'Patta boshqa foydalanuvchi tomonidan o‘zgartirilgan',
          details: { expected_version: expectedVersion, current_version: patta.version },
        });
      }
      if (BigInt(patta.version) >= MAX_POSTGRES_BIGINT) throw pattaNumberRangeExhausted();
      await manager.query(
        `INSERT INTO "patta_legacy_quantity_corrections"
          ("id", "patta_hisob_id", "from_version", "to_version", "legacy_operation_count",
           "ish_soni", "reason", "actor_user_id", "device_id")
         VALUES ($1, $2, $3::bigint, ($3::bigint + 1), $4, $5, $6, $7, $8)`,
        [randomUUID(), pattaId, patta.version, patta.legacy_operation_count, input.ish_soni,
          reason, actorUserId, validatedDeviceId],
      );
      const version = (BigInt(patta.version) + 1n).toString();
      await manager.query(
        `UPDATE "patta_hisob" SET "ish_soni" = $1, "version" = $2::bigint,
          "updated_at" = transaction_timestamp() WHERE "id" = $3`,
        [input.ish_soni, version, pattaId],
      );
      const sheetTable: ExistsRow[] = await manager.query(
        `SELECT to_regclass('public.patta_sheets') IS NOT NULL AS "present"`,
      );
      if (sheetTable[0]?.present === true) {
        const sheets: Array<{ id: string }> = await manager.query(
          `SELECT "id"::text AS "id" FROM "patta_sheets"
           WHERE "patta_hisob_id" = $1 FOR UPDATE`,
          [pattaId],
        );
        if (sheets.length > 0) await this.assertTenantPermission(manager, actorUserId, 'patta_varaq.edit');
        if (sheets.length > 0) {
          if (!this.pattaSheetsService) throw new Error('Patta Sheet correction service is not registered');
          await this.pattaSheetsService.correctQuantitySnapshots(
            manager, actorUserId, validatedDeviceId, sheets.map(({ id }) => id), input.ish_soni, reason,
          );
        }
      }
      const auditResult = {
        patta_id: pattaId,
        ish_soni: input.ish_soni,
        legacy_operation_count: patta.legacy_operation_count,
        version,
        reason,
      };
      await this.auditService.append(manager, {
        actorUserId,
        deviceId: validatedDeviceId,
        entityType: 'patta',
        entityId: pattaId,
        action: 'patta.quantity_correct',
        before: { ish_soni: null, legacy_operation_count: patta.legacy_operation_count, version: patta.version },
        after: auditResult,
      });
      const projectionRows: CorrectedLegacyProjectionRow[] = await manager.query(
        `SELECT patta."id", patta."partiya_number", patta."patta_number"::text AS "patta_number",
          patta."model_id", patta."model_name_snapshot", patta."template_id", patta."konveyer_snapshot",
          patta."razmer", patta."rang", patta."ish_soni", patta."legacy_operation_count", patta."status",
          patta."print_batch_id", patta."created_device_id", patta."created_from_block_id",
          patta."client_created_at", patta."occurred_at", NULL AS "printed_at",
          to_char(patta."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at"
         FROM "patta_hisob" patta WHERE patta."id" = $1`,
        [pattaId],
      );
      const current = projectionRows[0];
      if (!current) throw pattaRecordNotFound();
      const projection: SyncProjectionV2 = {
        projection_version: 2,
        entity_type: 'patta_hisob',
        entity_id: pattaId,
        entity_version: version,
        data: {
          id: current.id,
          partiya_number: current.partiya_number,
          patta_number: current.patta_number,
          model_id: current.model_id,
          model_name_snapshot: current.model_name_snapshot,
          template_id: current.template_id,
          konveyer_snapshot: current.konveyer_snapshot,
          razmer: current.razmer,
          rang: current.rang,
          ish_soni: current.ish_soni,
          legacy_operation_count: current.legacy_operation_count,
          status: current.status,
          print_batch_id: null,
          created_device_id: current.created_device_id,
          created_from_block_id: current.created_from_block_id,
          created_at: timestamp(current.created_at),
          client_created_at: current.client_created_at === null ? null : timestamp(current.client_created_at),
          occurred_at: current.occurred_at === null ? null : timestamp(current.occurred_at),
        },
      };
      await this.syncChangeRecorder.record(manager, {
        entityType: 'patta_hisob', entityId: pattaId, operation: 'UPSERT',
        entityVersion: version, projectionVersion: 2, payload: projection,
      });
      return {
        patta_id: pattaId,
        ish_soni: input.ish_soni,
        legacy_operation_count: patta.legacy_operation_count,
        version,
      };
    });
  }

  async registerOfflineBatchCorrection(
    manager: EntityManager,
    actorUserId: string,
    validatedDeviceId: string,
    event: SyncEvent,
  ): Promise<{ batch: PattaPrintBatchResult; changeSequence: string }> {
    if (event.entity_type !== 'patta_print_batch' || event.operation !== 'UPDATE' ||
      event.base_version === null || !event.entity_id || !POSITIVE_INTEGER_PATTERN.test(event.base_version)) {
      throw new BadRequestException({ code: 'PAYLOAD_INVALID', message: 'Bosma to‘plam UPDATE hodisasi noto‘g‘ri', details: {} });
    }
    const correction = parseOfflineBatchCorrectionPayload(event.payload, this.configuration.maxBatchSize);
    if (correction.depends_on_event_ids.length > 0) {
      throw new ConflictException({
        code: 'PATTA_CORRECTION_DEPENDENCY_UNSUPPORTED',
        message: 'Patta tuzatish uchun kutilayotgan ma’lumotnoma hodisalari bo‘lmasligi kerak',
        details: { depends_on_event_ids: correction.depends_on_event_ids },
      });
    }
    return this.correctBatchInTransaction(
      manager,
      actorUserId,
      validatedDeviceId,
      event.entity_id,
      {
        expected_version: event.base_version,
        correction_reason: correction.correction_reason,
        ish_soni: correction.ish_soni,
        rang: correction.rang,
        size_distribution: correction.size_distribution,
        device_id: validatedDeviceId,
      },
      event.event_id,
      correction,
      { clientCreatedAt: event.client_created_at, occurredAt: event.occurred_at },
    );
  }

  async registerOfflineBatch(
    manager: EntityManager,
    actorUserId: string,
    validatedDeviceId: string,
    event: SyncEvent,
  ): Promise<OfflineBatchRegistrationResult> {
    if (event.entity_type !== 'patta_print_batch' || event.operation !== 'CREATE' ||
      event.base_version !== '0' || !event.entity_id) {
      throw new BadRequestException({ code: 'PAYLOAD_INVALID', message: 'Bosma to‘plam CREATE hodisasi noto‘g‘ri', details: {} });
    }
    const input = parseOfflineBatchPayload(event.payload, this.configuration.maxBatchSize);
    const batchId = requiredUuid(event.entity_id, 'entity_id');
    await this.partiyaNumberBlocks.assertAllocatedNumber(
      manager,
      validatedDeviceId,
      input.partiya_block_id,
      BigInt(input.partiya_number),
    );
    for (const patta of input.pattas) {
      await this.pattaNumberBlocks.assertAllocatedNumber(
        manager,
        validatedDeviceId,
        patta.block_id,
        BigInt(patta.patta_number),
      );
    }

    const modelRows: ModelRow[] = await manager.query(
      `SELECT "id", "name", "status" FROM "models" WHERE "id" = $1 FOR SHARE`,
      [input.model_id],
    );
    const model = modelRows[0];
    if (!model) throw new NotFoundException({ code: 'MODEL_NOT_FOUND', message: 'Model topilmadi', details: {} });
    if (model.status !== 'ACTIVE') throw pattaModelInactive();
    if (model.name !== input.model_name_snapshot) {
      throw pattaReferenceDataStale({ model_id: model.id, reason: 'model_name_changed' });
    }

    const operationRows: OperationRow[] = await manager.query(
      `SELECT "id", "name", "sort_order" FROM "model_operations"
       WHERE "model_id" = $1 AND "status" = 'ACTIVE'
       ORDER BY "sort_order", "id" FOR SHARE`,
      [model.id],
    );
    if (operationRows.length === 0) throw pattaModelHasNoOperations();
    const operationIds = operationRows.map(({ id }) => id.toLowerCase());
    const firstPatta = input.pattas[0];
    if (!firstPatta) throw new BadRequestException({ code: 'PATTA_SIZE_DISTRIBUTION_INVALID', message: 'Bosma to‘plamda Patta yo‘q', details: {} });
    const firstSnapshot = this.offlineRegistrationValidator.validateSnapshotPayload({
      ish_soni: input.ish_soni,
      operations: firstPatta.operation_snapshots,
    });
    if (firstSnapshot.operations.length !== operationRows.length ||
      firstSnapshot.operations.some((snapshot, index) => {
        const operation = operationRows[index];
        return !operation || snapshot.operation_id !== operation.id.toLowerCase() ||
          snapshot.operation_name_snapshot !== operation.name || snapshot.sort_order !== operation.sort_order;
      })) {
      throw pattaReferenceDataStale({ model_id: model.id, reason: 'operation_set_changed' });
    }

    const referenceRows: Array<{ latest_sequence: string; changed: boolean }> = await manager.query(
      `SELECT COALESCE(MAX(change."sequence_id"), 0)::text AS "latest_sequence",
              EXISTS (
                SELECT 1 FROM "server_change_log" changed
                WHERE changed."sequence_id" > $1::bigint AND (
                  (changed."entity_type" = 'models' AND changed."entity_id" = $2::text) OR
                  (changed."entity_type" = 'model_operations' AND changed."entity_id" = ANY($3::text[])) OR
                  (changed."entity_type" = 'model_operation_prices' AND
                    changed."payload_json" #>> '{data,operation_id}' = ANY($3::text[]))
                )
              ) AS "changed"
       FROM "server_change_log" change`,
      [event.reference_cursor, model.id, operationIds],
    );
    const referenceState = referenceRows[0];
    if (!referenceState || !/^(0|[1-9][0-9]*)$/.test(event.reference_cursor) ||
      BigInt(event.reference_cursor) > BigInt(referenceState.latest_sequence)) {
      throw pattaReferenceDataStale({ reference_cursor: event.reference_cursor });
    }
    if (referenceState.changed) {
      throw pattaReferenceDataStale({ reference_cursor: event.reference_cursor, model_id: model.id });
    }

    const transactionRows: TransactionTimeRow[] = await manager.query(
      'SELECT transaction_timestamp()::text AS "transaction_time"',
    );
    const transactionTime = transactionRows[0]?.transaction_time;
    if (!transactionTime) throw new Error('Database transaction timestamp was not returned');
    const prices = new Map<string, string>();
    for (const operation of operationRows) {
      prices.set(
        operation.id.toLowerCase(),
        await this.operationPriceService.resolvePrice(operation.id, event.occurred_at, manager),
      );
    }

    const sizeCounts = new Map<string, number>();
    const validatedPattas = input.pattas.map((item) => {
      sizeCounts.set(item.razmer, (sizeCounts.get(item.razmer) ?? 0) + 1);
      const snapshot = this.offlineRegistrationValidator.validateSnapshotPayload({
        ish_soni: input.ish_soni,
        operations: item.operation_snapshots,
      });
      if (snapshot.operations.length !== firstSnapshot.operations.length ||
        snapshot.operations.some((operation, index) => {
          const first = firstSnapshot.operations[index];
          const expectedPrice = prices.get(operation.operation_id);
          return !first || operation.operation_id !== first.operation_id ||
            operation.operation_name_snapshot !== first.operation_name_snapshot ||
            operation.sort_order !== first.sort_order || operation.unit_price_snapshot !== expectedPrice;
        })) {
        throw pattaReferenceDataStale({ reason: 'operation_snapshot_mismatch', patta_id: item.id });
      }
      return { item, snapshot };
    });
    if (input.size_distribution.some((size) => sizeCounts.get(size.razmer) !== size.patta_count)) {
      throw new BadRequestException({ code: 'PATTA_SIZE_DISTRIBUTION_INVALID', message: 'Patta soni razmer qatorlariga mos emas', details: {} });
    }

    const batchRows: Array<{ created_at: string; updated_at: string }> = await manager.query(
      `INSERT INTO "patta_print_batches"
        ("id", "model_id", "model_name_snapshot", "partiya_number", "partiya_block_id",
         "ish_soni", "rang", "created_by", "created_device_id")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
         to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at"`,
      [batchId, model.id, input.model_name_snapshot, input.partiya_number, input.partiya_block_id,
        input.ish_soni, input.rang, actorUserId, validatedDeviceId],
    );
    const createdBatch = batchRows[0];
    if (!createdBatch) throw new Error('Offline print batch insert did not return timestamps');
    for (const size of input.size_distribution) {
      await manager.query(
        `INSERT INTO "patta_print_batch_sizes" ("id", "print_batch_id", "razmer", "patta_count", "sort_order")
         VALUES ($1, $2, $3, $4, $5)`,
        [size.id, batchId, size.razmer, size.patta_count, size.sort_order],
      );
    }

    const pattaDrafts: PattaPrintBatchPattaRecord[] = [];
    for (const { item, snapshot } of validatedPattas) {
      const insertRows: PattaInsertRow[] = await manager.query(
        `INSERT INTO "patta_hisob"
          ("id", "partiya_number", "patta_number", "model_id", "model_name_snapshot",
           "template_id", "konveyer_snapshot", "razmer", "rang", "ish_soni",
           "created_device_id", "created_from_block_id", "created_by", "client_created_at",
           "occurred_at", "print_batch_id", "status")
         VALUES ($1, $2, $3::bigint, $4, $5, NULL, NULL, $6, $7, $8,
                 $9, $10, $11, $12::timestamptz, $13::timestamptz, $14, 'ACTIVE')
           RETURNING "id", "partiya_number", "patta_number"::text AS "patta_number", "model_id",
             "model_name_snapshot", "template_id", "konveyer_snapshot", "print_batch_id", "ish_soni",
             "legacy_operation_count", "status", "version"::text AS "version", "rang", "razmer", "created_device_id",
           "created_from_block_id", "client_created_at", "occurred_at",
           to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at"`,
        [item.id, input.partiya_number, item.patta_number, model.id, model.name, item.razmer,
          input.rang, input.ish_soni, validatedDeviceId, item.block_id, actorUserId,
          event.client_created_at, event.occurred_at, batchId],
      );
      const insertedPatta = insertRows[0];
      if (!insertedPatta) throw new Error('Offline Patta insert did not return a record');
      const operationSnapshots: OperationSnapshotRecord[] = [];
      for (const operation of snapshot.operations) {
        await manager.query(
          `INSERT INTO "patta_operation_snapshots"
            ("id", "patta_hisob_id", "operation_id", "operation_name_snapshot",
             "unit_price_snapshot", "sort_order")
           VALUES ($1, $2, $3, $4, $5::numeric(14,2), $6)`,
          [operation.id, item.id, operation.operation_id, operation.operation_name_snapshot,
            operation.unit_price_snapshot, operation.sort_order],
        );
        operationSnapshots.push({
          id: operation.id,
          patta_hisob_id: item.id,
          operation_id: operation.operation_id,
          operation_name_snapshot: operation.operation_name_snapshot,
          unit_price_snapshot: operation.unit_price_snapshot,
          sort_order: operation.sort_order,
          created_at: timestamp(transactionTime),
        });
      }
      pattaDrafts.push({
        ...insertedPatta,
        created_at: timestamp(insertedPatta.created_at),
        client_created_at: event.client_created_at,
        occurred_at: event.occurred_at,
        operations: operationSnapshots,
      });
    }
    const result: PattaPrintBatchResult = {
      id: batchId,
      model_id: model.id,
      model_name_snapshot: input.model_name_snapshot,
      partiya_number: input.partiya_number,
      partiya_block_id: input.partiya_block_id,
      ish_soni: input.ish_soni,
      rang: input.rang,
      status: 'ACTIVE',
      version: '1',
      revision: 1,
      corrected_from_batch_id: null,
      created_by: actorUserId,
      created_device_id: validatedDeviceId,
      created_at: timestamp(createdBatch.created_at),
      updated_at: timestamp(createdBatch.updated_at),
      printed_at: null,
      size_distribution: input.size_distribution.map((size) => ({ ...size, print_batch_id: batchId })),
      pattas: pattaDrafts,
    };
      await this.auditService.append(manager, {
        actorUserId,
        deviceId: validatedDeviceId,
        entityType: 'patta_print_batch',
      entityId: batchId,
      action: 'patta_print_batch.create',
      before: null,
      after: { ...result, event_id: event.event_id, source: 'OFFLINE' },
    });
    const change = await this.recordBatchChange(manager, result);
    return { batch: result, changeSequence: change.sequenceId };
  }

  async registerOfflinePrintEvent(
    manager: EntityManager,
    actorUserId: string,
    validatedDeviceId: string,
    event: SyncEvent,
  ): Promise<OfflinePrintEventRegistrationResult> {
    if (event.entity_type !== 'patta_print_event' || event.operation !== 'CREATE' ||
      event.base_version !== '0' || !event.entity_id) {
      throw new BadRequestException({ code: 'PAYLOAD_INVALID', message: 'Chop etish hodisasi CREATE noto‘g‘ri', details: {} });
    }
    const payload = record(event.payload, 'Chop etish hodisasi ma’lumoti obyekt bo‘lishi kerak');
    const allowed = new Set(['batch_id', 'revision', 'kind', 'outcome', 'device_id']);
    if (Object.keys(payload).some((field) => !allowed.has(field))) {
      throw new BadRequestException({ code: 'PAYLOAD_INVALID', message: 'Chop etish hodisasida noma’lum maydon bor', details: {} });
    }
    const eventId = requiredUuid(event.entity_id, 'entity_id');
    const batchId = requiredUuid(payload['batch_id'], 'batch_id');
    const eventDeviceId = requiredUuid(payload['device_id'], 'device_id');
    if (eventDeviceId !== validatedDeviceId.toLowerCase()) {
      throw new ConflictException({ code: 'DEVICE_TENANT_MISMATCH', message: 'Chop etish hodisasi boshqa qurilmaga tegishli', details: {} });
    }
    const revision = payload['revision'];
    const kind = payload['kind'];
    const outcome = payload['outcome'];
    if (!Number.isSafeInteger(revision) || (revision as number) < 1 ||
      !['INITIAL', 'REPRINT', 'CORRECTED_REPRINT'].includes(String(kind)) ||
      !['REQUESTED', 'SUCCEEDED', 'FAILED'].includes(String(outcome))) {
      throw new BadRequestException({ code: 'PAYLOAD_INVALID', message: 'Chop etish hodisasi qiymatlari noto‘g‘ri', details: {} });
    }
    const batchRows: LockedBatchRow[] = await manager.query(
      `SELECT "id", "revision", "status", "printed_at" FROM "patta_print_batches" WHERE "id" = $1 FOR UPDATE`,
      [batchId],
    );
    const batch = batchRows[0];
    if (!batch) throw new NotFoundException({ code: 'PATTA_PRINT_BATCH_NOT_FOUND', message: 'Patta bosma to‘plami topilmadi', details: {} });
    if (batch.status !== 'ACTIVE' || batch.revision !== revision) {
      throw new ConflictException({
        code: batch.status === 'ACTIVE' ? 'PATTA_PRINT_REVISION_CONFLICT' : 'PATTA_PRINT_BATCH_INACTIVE',
        message: 'Chop etish uchun Patta bosma to‘plami faol va joriy versiyada bo‘lishi kerak',
        details: { expected_revision: revision, current_revision: batch.revision },
      });
    }
    const eventRows: PrintEventRow[] = await manager.query(
      `INSERT INTO "patta_print_events"
        ("id", "batch_id", "revision", "kind", "outcome", "actor_user_id", "device_id")
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING "id", "batch_id", "revision", "kind", "outcome", "actor_user_id", "device_id",
         to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at"`,
      [eventId, batchId, revision, kind, outcome, actorUserId, validatedDeviceId],
    );
    const inserted = eventRows[0];
    if (!inserted) throw new Error('Offline print event insert did not return a record');
    let printedAt = batch.printed_at === null ? null : timestamp(batch.printed_at);
    if (outcome === 'SUCCEEDED' && printedAt === null) {
      const updatedRows: Array<{ id: string }> = await manager.query(
        `UPDATE "patta_print_batches" SET "printed_at" = $2::timestamptz
         WHERE "id" = $1 AND "printed_at" IS NULL
         RETURNING "id"`,
        [batchId, event.occurred_at],
      );
      if (!updatedRows[0]) throw new Error('Successful print event did not update its active batch');
      const rows: Array<{ printed_at: string }> = await manager.query(
        `SELECT to_char("printed_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "printed_at"
         FROM "patta_print_batches" WHERE "id" = $1`,
        [batchId],
      );
      printedAt = rows[0]?.printed_at ?? null;
      if (!printedAt) throw new Error('Successful print event did not persist printed_at');
    }
    const result: PattaPrintEventResult = {
      ...serializePrintEvent(inserted),
      printed_at: printedAt,
    };
    await this.auditService.append(manager, {
      actorUserId,
      deviceId: validatedDeviceId,
      entityType: 'patta_print_event',
      entityId: eventId,
      action: 'patta_print_event.record',
      before: null,
      after: result,
    });
    const projection: SyncProjectionV2 = {
      projection_version: 2,
      entity_type: 'patta_print_events',
      entity_id: eventId,
      entity_version: null,
      data: result,
    };
    const change = await this.syncChangeRecorder.record(manager, {
      entityType: 'patta_print_events',
      entityId: eventId,
      operation: 'UPSERT',
      entityVersion: null,
      projectionVersion: 2,
      payload: projection,
    });
    return { projection, changeSequence: change.sequenceId };
  }

  async lookup(dataSource: DataSource, input: LookupPattaV2Dto): Promise<PattaV2LookupRecord> {
    const partiyaNumber = canonicalizeBusinessName(input.partiya_number);
    const pattaNumber = input.patta_number;
    if (!partiyaNumber || !/^[1-9][0-9]*$/.test(pattaNumber) || pattaNumber.length > 19 ||
      BigInt(pattaNumber) > MAX_POSTGRES_BIGINT) {
      throw pattaNumberInvalid();
    }
    const rows: PattaLookupRow[] = await dataSource.query(
      `SELECT patta."id", patta."partiya_number", patta."patta_number"::text AS "patta_number",
              patta."model_id", patta."model_name_snapshot", patta."template_id", patta."konveyer_snapshot",
              patta."razmer", patta."rang", patta."ish_soni", patta."legacy_operation_count", patta."status",
              patta."print_batch_id", patta."created_device_id", patta."created_from_block_id",
              patta."version"::text AS "version", patta."client_created_at", patta."occurred_at", batch."printed_at",
              to_char(patta."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
              CASE WHEN batch."printed_at" IS NULL THEN NULL ELSE
                to_char(batch."printed_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "printed_at"
       FROM "patta_hisob" patta
       LEFT JOIN "patta_print_batches" batch ON batch."id" = patta."print_batch_id"
       WHERE patta."partiya_number" = $1 AND patta."patta_number" = $2::bigint`,
      [partiyaNumber, pattaNumber],
    );
    const patta = rows[0];
    if (!patta) throw pattaRecordNotFound();
    const operations: PattaLookupOperationRow[] = await dataSource.query(
      `SELECT "id", "operation_id", "operation_name_snapshot",
              "unit_price_snapshot"::text AS "unit_price_snapshot", "sort_order",
              to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at"
       FROM "patta_operation_snapshots" WHERE "patta_hisob_id" = $1
       ORDER BY "sort_order", "operation_id"`,
      [patta.id],
    );
    const batchProjection: PattaPrintBatchProjection | null = patta.print_batch_id === null
      ? null
      : await this.loadBatchProjection(dataSource.manager, patta.print_batch_id);
    const mirrorPatta: PattaPrintBatchPattaProjection = batchProjection?.pattas.find(({ id }) => id === patta.id) ?? {
      id: patta.id,
      partiya_number: patta.partiya_number,
      patta_number: patta.patta_number,
      model_id: patta.model_id,
      model_name_snapshot: patta.model_name_snapshot,
      template_id: patta.template_id,
      konveyer_snapshot: patta.konveyer_snapshot,
      razmer: patta.razmer,
      rang: patta.rang,
      ish_soni: patta.ish_soni,
      legacy_operation_count: patta.legacy_operation_count,
      status: patta.status,
      version: patta.version,
      print_batch_id: patta.print_batch_id,
      created_device_id: patta.created_device_id,
      created_from_block_id: patta.created_from_block_id,
      created_at: timestamp(patta.created_at),
      client_created_at: patta.client_created_at === null ? null : timestamp(patta.client_created_at),
      occurred_at: patta.occurred_at === null ? null : timestamp(patta.occurred_at),
      operations: operations.map((operation) => ({
        id: operation.id,
        patta_hisob_id: patta.id,
        operation_id: operation.operation_id,
        operation_name_snapshot: operation.operation_name_snapshot,
        unit_price_snapshot: operation.unit_price_snapshot,
        sort_order: operation.sort_order,
        created_at: timestamp(operation.created_at),
      })),
    };
    const affectedIds = [
      patta.id,
      ...operations.map(({ id }) => id),
      ...(batchProjection === null ? [] : [
        batchProjection.id,
        ...batchProjection.size_distribution.map(({ id }) => id),
        ...batchProjection.pattas.flatMap((item) => [item.id, ...item.operations.map(({ id }) => id)]),
      ]),
    ];
    const sequenceRows: ServerSequenceRow[] = await dataSource.query(
      `SELECT COALESCE(MAX("sequence_id"), 0)::text AS "sequence"
       FROM "server_change_log"
       WHERE "entity_type" IN ('patta_print_batches', 'patta_print_batch_sizes', 'patta_hisob', 'patta_operation_snapshots')
         AND "entity_id" = ANY($1::varchar[])`,
      [affectedIds],
    );
    const mirror: PattaV2LookupMirror = {
      server_sequence: sequenceRows[0]?.sequence ?? '0',
      patta: mirrorPatta,
      batch: batchProjection,
    };
    return {
      ...patta,
      created_at: timestamp(patta.created_at),
      printed_at: patta.printed_at === null ? null : timestamp(patta.printed_at),
      operation_count: operations.length,
      operations: operations.map(({ id, operation_id, operation_name_snapshot, unit_price_snapshot, sort_order }) => ({
        id, operation_id, operation_name_snapshot, unit_price_snapshot, sort_order,
      })),
      model: { id: patta.model_id, name: patta.model_name_snapshot },
      mirror,
    };
  }

  async recordPrintEvent(
    dataSource: DataSource,
    actorUserId: string,
    validatedDeviceId: string,
    batchId: string,
    input: RecordPattaPrintEventDto,
  ): Promise<PattaPrintEventResult> {
    try {
      return await dataSource.transaction(async (manager) => {
      const batchRows: LockedBatchRow[] = await manager.query(
        `SELECT "id", "revision", "status",
          CASE WHEN "printed_at" IS NULL THEN NULL ELSE
            to_char("printed_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "printed_at"
         FROM "patta_print_batches" WHERE "id" = $1 FOR UPDATE`,
        [batchId],
      );
      const batch = batchRows[0];
      if (!batch) {
        throw new NotFoundException({ code: 'PATTA_PRINT_BATCH_NOT_FOUND', message: 'Patta bosma to‘plami topilmadi', details: {} });
      }

      const existingRows: PrintEventRow[] = await manager.query(
        `SELECT "id", "batch_id", "revision", "kind", "outcome", "actor_user_id", "device_id",
         to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at"
         FROM "patta_print_events" WHERE "id" = $1 FOR SHARE`,
        [input.event_id],
      );
      const existing = existingRows[0];
      if (existing) {
        if (existing.batch_id !== batchId || existing.revision !== input.revision ||
          existing.kind !== input.kind || existing.outcome !== input.outcome ||
          existing.actor_user_id !== actorUserId || existing.device_id !== validatedDeviceId) {
          throw new ConflictException({
            code: 'SYNC_EVENT_ID_REUSE_MISMATCH',
            message: 'Chop etish hodisasi identifikatori boshqa ma’lumot bilan ishlatilgan',
            details: {},
          });
        }
        return {
          ...serializePrintEvent(existing),
          printed_at: batch.printed_at === null ? null : timestamp(batch.printed_at),
        };
      }
      if (batch.status !== 'ACTIVE') {
        throw new ConflictException({
          code: 'PATTA_PRINT_BATCH_INACTIVE',
          message: 'Faol bo‘lmagan Patta to‘plamini chop etib bo‘lmaydi',
          details: {},
        });
      }
      if (batch.revision !== input.revision) {
        throw new ConflictException({
          code: 'PATTA_PRINT_REVISION_CONFLICT',
          message: 'Patta to‘plami boshqa versiyada; qayta yuklang',
          details: { expected_revision: input.revision, current_revision: batch.revision },
        });
      }

      const eventRows: PrintEventRow[] = await manager.query(
        `INSERT INTO "patta_print_events"
          ("id", "batch_id", "revision", "kind", "outcome", "actor_user_id", "device_id")
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING "id", "batch_id", "revision", "kind", "outcome", "actor_user_id", "device_id",
         to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at"`,
        [input.event_id, batchId, input.revision, input.kind, input.outcome, actorUserId, validatedDeviceId],
      );
      const event = eventRows[0];
      if (!event) throw new Error('Patta print event insert did not return a record');

      let printedAt = batch.printed_at === null ? null : timestamp(batch.printed_at);
      if (input.outcome === 'SUCCEEDED' && printedAt === null) {
        const updatedRows: Array<{ id: string }> = await manager.query(
          `UPDATE "patta_print_batches" SET "printed_at" = transaction_timestamp()
           WHERE "id" = $1 AND "printed_at" IS NULL
           RETURNING "id"`,
          [batchId],
        );
        if (!updatedRows[0]) throw new Error('Successful print event did not update its active batch');
        const printedRows: Array<{ printed_at: string }> = await manager.query(
          `SELECT to_char("printed_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "printed_at"
           FROM "patta_print_batches" WHERE "id" = $1`,
          [batchId],
        );
        printedAt = printedRows[0]?.printed_at ?? null;
        if (printedAt === null) throw new Error('Successful print event did not persist first printed_at');
      }

      const result: PattaPrintEventResult = { ...serializePrintEvent(event), printed_at: printedAt };
      await this.auditService.append(manager, {
        actorUserId,
        deviceId: validatedDeviceId,
        entityType: 'patta_print_event',
        entityId: result.id,
        action: 'patta_print_event.record',
        before: null,
        after: result,
      });
      await this.syncChangeRecorder.record(manager, {
        entityType: 'patta_print_events',
        entityId: result.id,
        operation: 'UPSERT',
        entityVersion: null,
        projectionVersion: 2,
        payload: {
          projection_version: 2,
          entity_type: 'patta_print_events',
          entity_id: result.id,
          entity_version: null,
          data: result,
        },
      });
      return result;
      });
    } catch (error) {
      if (postgresConstraint(error) === 'uq_patta_print_events_initial_revision') {
        throw new ConflictException({
          code: 'PATTA_INITIAL_PRINT_ALREADY_RECORDED',
          message: 'Ushbu bosma versiyasi uchun boshlang‘ich chop etish allaqachon qayd qilingan',
          details: {},
        });
      }
      throw error;
    }
  }

  private recordBatchChange(
    manager: EntityManager,
    batch: PattaPrintBatchResult,
  ): Promise<{ sequenceId: string }> {
    const payload = {
      projection_version: 2,
      entity_type: 'patta_print_batches',
      entity_id: batch.id,
      entity_version: batch.version,
      data: batch,
    };
    return this.syncChangeRecorder.record(manager, {
      entityType: 'patta_print_batches',
      entityId: batch.id,
      operation: 'UPSERT',
      entityVersion: batch.version,
      projectionVersion: 2,
      payload,
    });
  }

  private async assertTenantPermission(
    manager: EntityManager,
    actorUserId: string,
    permissionCode: string,
  ): Promise<void> {
    const rows: Array<{ allowed: boolean }> = await manager.query(
      `SELECT EXISTS (
         SELECT 1 FROM "users" user_account
         JOIN "roles" role ON role."id" = user_account."role_id"
         JOIN "role_permissions" assignment ON assignment."role_id" = role."id"
         JOIN "permissions" permission ON permission."id" = assignment."permission_id"
         WHERE user_account."id" = $1::uuid AND user_account."status" = 'ACTIVE'
           AND permission."code" = $2
       ) AS "allowed"`,
      [actorUserId, permissionCode],
    );
    if (rows[0]?.allowed !== true) {
      throw new ConflictException({
        code: 'TENANT_PERMISSION_REQUIRED',
        message: 'Bu amalni bajarish uchun korxona ruxsati yetarli emas',
        details: { permission: permissionCode },
      });
    }
  }

  private async allocateCorrectionPattaNumbers(manager: EntityManager, count: number): Promise<bigint> {
    if (count === 0) return 0n;
    const rows: SequenceRow[] = await manager.query(
      `SELECT "next_number"::text AS "next_number"
       FROM "patta_number_sequence" WHERE "id" = 1 FOR UPDATE`,
    );
    const sequence = rows[0];
    if (!sequence) throw new Error('Patta number sequence is not initialized');
    const first = BigInt(sequence.next_number);
    const last = first + BigInt(count) - 1n;
    if (first < 1n || last >= MAX_POSTGRES_BIGINT) throw pattaNumberRangeExhausted();
    await manager.query(
      `UPDATE "patta_number_sequence" SET "next_number" = $1::bigint,
        "version" = "version" + 1, "updated_at" = transaction_timestamp() WHERE "id" = 1`,
      [(last + 1n).toString()],
    );
    return first;
  }

  private async loadBatchProjection(manager: EntityManager, batchId: string): Promise<PattaPrintBatchResult> {
    const batchRows: BatchProjectionRow[] = await manager.query(
      `SELECT id, model_id, model_name_snapshot, partiya_number, partiya_block_id,
        ish_soni, rang, status, version::text AS version, revision, corrected_from_batch_id,
        created_by, created_device_id,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
        CASE WHEN printed_at IS NULL THEN NULL ELSE
          to_char(printed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS printed_at
       FROM patta_print_batches WHERE id = $1`,
      [batchId],
    );
    const batch = batchRows[0];
    if (!batch) throw new NotFoundException({ code: 'PATTA_PRINT_BATCH_NOT_FOUND', message: 'Patta bosma to‘plami topilmadi', details: {} });
    const sizes: PattaPrintBatchResult['size_distribution'] = await manager.query(
      `SELECT id, print_batch_id, razmer, patta_count, sort_order
       FROM patta_print_batch_sizes WHERE print_batch_id = $1 ORDER BY sort_order, razmer`,
      [batchId],
    );
    const pattas: PattaInsertRow[] = await manager.query(
      `SELECT id, partiya_number, patta_number::text AS patta_number, model_id,
        model_name_snapshot, template_id, konveyer_snapshot, print_batch_id, ish_soni,
        legacy_operation_count, status, version::text AS version, rang, razmer,
        created_device_id, created_from_block_id, created_by,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
        CASE WHEN client_created_at IS NULL THEN NULL ELSE
          to_char(client_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS client_created_at,
        CASE WHEN occurred_at IS NULL THEN NULL ELSE
          to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS occurred_at
       FROM patta_hisob WHERE print_batch_id = $1 ORDER BY patta_number`,
      [batchId],
    );
    const snapshotRows: BatchSnapshotRow[] = pattas.length === 0 ? [] : await manager.query(
      `SELECT snapshot.id, snapshot.patta_hisob_id, snapshot.operation_id,
        snapshot.operation_name_snapshot, snapshot.unit_price_snapshot::text AS unit_price_snapshot,
        snapshot.sort_order,
        to_char(snapshot.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM patta_operation_snapshots snapshot
       JOIN patta_hisob patta ON patta.id = snapshot.patta_hisob_id
       WHERE patta.print_batch_id = $1
       ORDER BY patta.patta_number, snapshot.sort_order, snapshot.operation_id`,
      [batchId],
    );
    const snapshotsByPatta = new Map<string, OperationSnapshotRecord[]>();
    for (const row of snapshotRows) {
      const snapshots = snapshotsByPatta.get(row.patta_hisob_id) ?? [];
      snapshots.push({
        id: row.id,
        patta_hisob_id: row.patta_hisob_id,
        operation_id: row.operation_id,
        operation_name_snapshot: row.operation_name_snapshot,
        unit_price_snapshot: row.unit_price_snapshot,
        sort_order: row.sort_order,
        created_at: timestamp(row.created_at),
      });
      snapshotsByPatta.set(row.patta_hisob_id, snapshots);
    }
    return {
      id: batch.id,
      model_id: batch.model_id,
      model_name_snapshot: batch.model_name_snapshot,
      partiya_number: batch.partiya_number,
      partiya_block_id: batch.partiya_block_id,
      ish_soni: batch.ish_soni,
      rang: batch.rang,
      status: batch.status,
      version: batch.version,
      revision: batch.revision,
      corrected_from_batch_id: batch.corrected_from_batch_id,
      created_by: batch.created_by,
      created_device_id: batch.created_device_id,
      created_at: timestamp(batch.created_at),
      updated_at: timestamp(batch.updated_at),
      printed_at: batch.printed_at === null ? null : timestamp(batch.printed_at),
      size_distribution: sizes,
      pattas: pattas.map((patta) => ({
        ...patta,
        created_at: timestamp(patta.created_at),
        operations: snapshotsByPatta.get(patta.id) ?? [],
      })),
    };
  }
}
