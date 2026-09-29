import type { EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from './audit.service.js';

const actorUserId = '11111111-1111-4111-8111-111111111111';

function event(entityId: string, entityType: 'model' | 'worker', action: 'model.create' | 'worker.create') {
  return {
    actorUserId,
    entityType,
    entityId,
    action,
    before: null,
    after: { id: entityId },
  } as const;
}

describe('AuditService', () => {
  it('writes UUID identity to both the legacy UUID and universal string key', async () => {
    const manager = { query: vi.fn(async () => undefined) };
    const service = new AuditService();

    await service.append(
      manager as unknown as EntityManager,
      event('22222222-2222-4222-8222-222222222222', 'model', 'model.create'),
    );

    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('"entity_id", "entity_key"'),
      [
        actorUserId,
        null,
        'model',
        '22222222-2222-4222-8222-222222222222',
        '22222222-2222-4222-8222-222222222222',
        'model.create',
        null,
        JSON.stringify({ id: '22222222-2222-4222-8222-222222222222' }),
      ],
    );
  });

  it('stores a BIGINT identity as a string key and leaves the legacy UUID null', async () => {
    const manager = { query: vi.fn(async () => undefined) };
    const service = new AuditService();

    await service.append(manager as unknown as EntityManager, event('18', 'worker', 'worker.create'));

    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('"entity_id", "entity_key"'),
      [actorUserId, null, 'worker', null, '18', 'worker.create', null, JSON.stringify({ id: '18' })],
    );
  });

  it('stores the validated workstation ID when a mutation supplies it', async () => {
    const manager = { query: vi.fn(async () => undefined) };
    const service = new AuditService();
    await service.append(manager as unknown as EntityManager, {
      ...event('22222222-2222-4222-8222-222222222222', 'model', 'model.create'),
      deviceId: '33333333-3333-4333-8333-333333333333',
    });

    expect(manager.query.mock.calls[0]?.[1]?.slice(0, 3)).toEqual([
      actorUserId, '33333333-3333-4333-8333-333333333333', 'model',
    ]);
  });
});
