import { NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { canonicalizeBusinessName } from './business-name.js';
import { ModelsService } from './models.service.js';

const actorUserId = '11111111-1111-4111-8111-111111111111';
const modelId = '22222222-2222-4222-8222-222222222222';

interface ModelRow {
  id: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  version: string;
  created_at: Date;
  updated_at: Date;
}

function row(overrides: Partial<ModelRow> = {}): ModelRow {
  const now = new Date('2026-09-26T00:00:00.000Z');
  return {
    id: modelId,
    name: 'Atlas Knit',
    status: 'ACTIVE',
    version: '1',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function createHarness() {
  const manager = { query: vi.fn() };
  const dataSource = {
    query: vi.fn(),
    transaction: vi.fn(async (work: (transaction: EntityManager) => Promise<unknown>) =>
      work(manager as unknown as EntityManager)),
  };
  const auditService = { append: vi.fn(async () => undefined) };
  return {
    manager,
    dataSource: dataSource as unknown as DataSource,
    query: dataSource.query,
    transaction: dataSource.transaction,
    auditService,
    service: new ModelsService(auditService as unknown as AuditService),
  };
}

describe('canonicalizeBusinessName', () => {
  it('trims and collapses the same ASCII whitespace characters used by PostgreSQL', () => {
    expect(canonicalizeBusinessName(' \tAtlas\r\n   Knit\v ')).toBe('Atlas Knit');
  });
});

describe('ModelsService', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it('creates a normalized model and appends its audit event in the transaction', async () => {
    const created = row();
    harness.manager.query.mockResolvedValueOnce([created]);

    await expect(harness.service.create(
      harness.dataSource,
      actorUserId,
      { name: '  Atlas\t  Knit  ' },
    )).resolves.toEqual({
      ...created,
      created_at: created.created_at.toISOString(),
      updated_at: created.updated_at.toISOString(),
    });

    expect(harness.transaction).toHaveBeenCalledOnce();
    expect(harness.manager.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO "models"'),
      ['Atlas Knit', 'ACTIVE'],
    );
    expect(harness.auditService.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserId,
        entityType: 'model',
        entityId: modelId,
        action: 'model.create',
        before: null,
      }),
    );
  });

  it('lists and gets a model using the supplied tenant DataSource', async () => {
    const existing = row();
    harness.query.mockResolvedValue([existing]);

    await expect(harness.service.list(harness.dataSource)).resolves.toHaveLength(1);
    await expect(harness.service.getById(harness.dataSource, modelId)).resolves.toMatchObject({
      id: modelId,
      version: '1',
    });
    expect(harness.query).toHaveBeenCalledWith(expect.stringContaining('FROM "models"'), ['ACTIVE']);
  });

  it('returns a structured not-found response for a missing model', async () => {
    harness.query.mockResolvedValueOnce([]);

    await expect(harness.service.getById(harness.dataSource, modelId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('updates only when expected_version matches and increments the version', async () => {
    const before = row();
    const after = row({ name: 'Atlas Woven', version: '2' });
    const serializedBefore = { ...before, created_at: before.created_at.toISOString(), updated_at: before.updated_at.toISOString() };
    const serializedAfter = { ...after, created_at: after.created_at.toISOString(), updated_at: after.updated_at.toISOString() };
    harness.manager.query
      .mockResolvedValueOnce([before])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([after]);

    await expect(harness.service.update(
      harness.dataSource,
      actorUserId,
      modelId,
      { name: ' Atlas  Woven ', expected_version: '1' },
    )).resolves.toMatchObject({ name: 'Atlas Woven', version: '2' });

    expect(harness.manager.query.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(harness.manager.query.mock.calls[1]?.[0]).toContain('"version" = "version" + 1');
    expect(harness.auditService.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'model.update', before: serializedBefore, after: serializedAfter }),
    );
  });

  it('returns VERSION_CONFLICT after locking a stale model and writes no audit', async () => {
    harness.manager.query.mockResolvedValueOnce([row({ version: '3' })]);

    await expect(harness.service.update(
      harness.dataSource,
      actorUserId,
      modelId,
      { name: 'New Name', expected_version: '2' },
    )).rejects.toMatchObject({
      response: { code: 'VERSION_CONFLICT' },
    });
    expect(harness.manager.query).toHaveBeenCalledOnce();
    expect(harness.auditService.append).not.toHaveBeenCalled();
  });

  it('deactivates without deleting and records model.deactivate in the same transaction', async () => {
    const before = row();
    const after = row({ status: 'INACTIVE', version: '2' });
    const serializedBefore = { ...before, created_at: before.created_at.toISOString(), updated_at: before.updated_at.toISOString() };
    const serializedAfter = { ...after, created_at: after.created_at.toISOString(), updated_at: after.updated_at.toISOString() };
    harness.manager.query
      .mockResolvedValueOnce([before])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([after]);

    await expect(harness.service.update(
      harness.dataSource,
      actorUserId,
      modelId,
      { status: 'INACTIVE', expected_version: '1' },
    )).resolves.toMatchObject({ status: 'INACTIVE', version: '2' });

    expect(harness.manager.query.mock.calls[1]?.[0]).toContain('UPDATE "models"');
    expect(harness.manager.query.mock.calls[1]?.[0]).not.toContain('DELETE');
    expect(harness.auditService.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'model.deactivate', before: serializedBefore, after: serializedAfter }),
    );
  });

  it('maps the active normalized-name unique index to a structured conflict', async () => {
    const uniqueViolation = Object.assign(new Error('database detail'), {
      driverError: { code: '23505', constraint: 'uq_models_active_name' },
    });
    harness.manager.query.mockRejectedValueOnce(uniqueViolation);

    await expect(harness.service.create(
      harness.dataSource,
      actorUserId,
      { name: 'Atlas Knit' },
    )).rejects.toMatchObject({
      response: { code: 'MODEL_NAME_CONFLICT' },
    });
    expect(harness.service.create).toBeDefined();
    expect(harness.auditService.append).not.toHaveBeenCalled();
  });

  it('rejects updates with no mutable fields', async () => {
    await expect(harness.service.update(
      harness.dataSource,
      actorUserId,
      modelId,
      { expected_version: '1' },
    )).rejects.toMatchObject({ response: { code: 'EMPTY_UPDATE' } });
    expect(harness.transaction).not.toHaveBeenCalled();
  });
});
