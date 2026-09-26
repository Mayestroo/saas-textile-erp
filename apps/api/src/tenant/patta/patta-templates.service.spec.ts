import type { EntityManager, DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { PattaTemplatesService } from './patta-templates.service.js';

const modelId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const templateId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function createService(
  queryHandler: (sql: string, parameters?: unknown[]) => Promise<unknown>,
) {
  const query = vi.fn((sql: string, parameters?: unknown[]) => queryHandler(sql, parameters));
  const manager = { query } as unknown as EntityManager;
  const dataSource = {
    query,
    transaction: vi.fn(async <T>(callback: (transactionManager: EntityManager) => Promise<T>) =>
      callback(manager)),
  } as unknown as DataSource;
  const auditService = { append: vi.fn(async () => undefined) };
  return {
    service: new PattaTemplatesService(auditService as unknown as AuditService),
    dataSource,
    query,
    auditService,
  };
}

const templateRow = {
  id: templateId,
  name: 'Atlas yeng',
  model_id: modelId,
  konveyer: '1-konveyer',
  razmer: null,
  rang: 'Ko‘k',
  status: 'ACTIVE',
  version: '1',
  created_by: actorId,
  created_at: '2026-09-26T10:00:00.000000Z',
  updated_at: '2026-09-26T10:00:00.000000Z',
};

describe('PattaTemplatesService', () => {
  it('normalizes required and optional fields and appends create audit atomically', async () => {
    const { service, dataSource, query, auditService } = createService(async (sql) => {
      if (sql.includes('FROM "models"')) {
        return [{ id: modelId, status: 'ACTIVE' }];
      }
      if (sql.includes('INSERT INTO "patta_templates"')) {
        return [templateRow];
      }
      return [];
    });

    await expect(service.create(dataSource, actorId, {
      name: '  Atlas\t yeng ',
      model_id: modelId,
      konveyer: '  1   konveyer ',
      razmer: ' \t ',
      rang: ' Ko‘k  ',
    })).resolves.toMatchObject({ name: 'Atlas yeng', version: '1' });

    const insertCall = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO "patta_templates"'));
    expect(insertCall?.[1]).toEqual(['Atlas yeng', modelId, '1 konveyer', null, 'Ko‘k', 'ACTIVE', actorId]);
    expect(auditService.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorUserId: actorId,
      entityType: 'patta_template',
      entityId: templateId,
      action: 'patta_template.create',
    }));
    expect(dataSource.transaction).toHaveBeenCalledOnce();
  });

  it('rejects inactive models before inserting a template', async () => {
    const { service, dataSource, query } = createService(async (sql) =>
      sql.includes('FROM "models"') ? [{ id: modelId, status: 'INACTIVE' }] : []);

    await expect(service.create(dataSource, actorId, {
      name: 'Paused', model_id: modelId, konveyer: '1',
    })).rejects.toMatchObject({ response: { code: 'MODEL_INACTIVE' } });
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO "patta_templates"'))).toBe(false);
  });

  it('maps an active normalized-name index violation to a conflict', async () => {
    const { service, dataSource } = createService(async (sql) => {
      if (sql.includes('FROM "models"')) {
        return [{ id: modelId, status: 'ACTIVE' }];
      }
      if (sql.includes('INSERT INTO "patta_templates"')) {
        throw { driverError: { constraint: 'uq_patta_templates_active_name', code: '23505' } };
      }
      return [];
    });

    await expect(service.create(dataSource, actorId, {
      name: 'Atlas', model_id: modelId, konveyer: '1',
    })).rejects.toMatchObject({ response: { code: 'PATTA_TEMPLATE_NAME_CONFLICT' } });
  });

  it('uses expected_version for optimistic template updates and records deactivation', async () => {
    let returned = { ...templateRow };
    const { service, dataSource, auditService } = createService(async (sql) => {
      if (sql.includes('FROM "patta_templates"') && !sql.includes('FOR UPDATE')) {
        return [{ model_id: modelId, status: 'ACTIVE', version: '2' }];
      }
      if (sql.includes('FROM "patta_templates"') && sql.includes('FOR UPDATE')) {
        return [{ ...returned, version: '2' }];
      }
      if (sql.includes('UPDATE "patta_templates"')) {
        returned = { ...returned, status: 'INACTIVE', version: '3' };
        return [[returned], 1];
      }
      if (sql.includes('SELECT') && sql.includes('FROM "patta_templates"')) {
        return [{ ...returned, status: 'INACTIVE', version: '3' }];
      }
      return [];
    });

    await expect(service.update(dataSource, actorId, templateId, {
      status: 'INACTIVE',
      expected_version: '1',
    })).rejects.toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
    expect(auditService.append).not.toHaveBeenCalled();

    await expect(service.update(dataSource, actorId, templateId, {
      status: 'INACTIVE',
      expected_version: '2',
    })).resolves.toMatchObject({ status: 'INACTIVE', version: '3' });
    expect(auditService.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'patta_template.deactivate',
    }));
  });
});
