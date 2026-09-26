import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestMasterDataSourceOptions } from '../../database/master/master-database.config.js';
import {
  createTenantMigrationDataSourceOptions,
  createTenantRuntimeDataSourceOptions,
  createTestTenantProvisionerCredentials,
  type TenantDatabaseCredentials,
} from '../../database/tenant/tenant-database.config.js';
import { TenantDatabaseManager } from '../../database/tenant/tenant-database-manager.js';
import { PattaSequenceInitializer } from '../../database/tenant/patta-sequence.initializer.js';
import { TenantTestDatabaseCleanup } from '../../database/tenant/tenant-test-database-cleanup.js';
import { AuditService } from '../audit/audit.service.js';
import { BadgeHistoryService } from '../badges/badge-history.service.js';
import { BadgeResolutionService } from '../badges/badge-resolution.service.js';
import { WorkersService } from './workers.service.js';

const TEST_DATABASE_VARIABLES = [
  'TEST_MASTER_DB_HOST',
  'TEST_MASTER_DB_PORT',
  'TEST_MASTER_DB_NAME',
  'TEST_MASTER_DB_USER',
  'TEST_MASTER_DB_PASSWORD',
] as const;

const configuredVariables = TEST_DATABASE_VARIABLES.filter((key) => Boolean(process.env[key]?.trim()));
if (configuredVariables.length > 0 && configuredVariables.length !== TEST_DATABASE_VARIABLES.length) {
  const missing = TEST_DATABASE_VARIABLES.filter((key) => !process.env[key]?.trim());
  throw new Error(`Workers/badges integration configuration is incomplete: ${missing.join(', ')}`);
}

const integrationDescribe = configuredVariables.length === TEST_DATABASE_VARIABLES.length
  ? describe
  : describe.skip;
const masterOptions = configuredVariables.length === TEST_DATABASE_VARIABLES.length
  ? createTestMasterDataSourceOptions(process.env)
  : undefined;
const provisionerCredentials = configuredVariables.length === TEST_DATABASE_VARIABLES.length
  ? createTestTenantProvisionerCredentials(process.env)
  : undefined;
const MIGRATION_NAME = 'AddWorkersAndBadgeHistory20260926000400';
const PATTA_MIGRATION_NAME = 'AddPattaFoundation20260926000500';

interface DriverError {
  message?: string;
  constraint?: string;
}

interface DatabaseError extends Error {
  driverError?: DriverError;
}

interface TenantFixture {
  companyId: string;
  databaseName: string;
  credentials: TenantDatabaseCredentials;
  runtimeDataSource: DataSource;
  migrationDataSource: DataSource;
}

async function expectConstraintViolation(
  operation: Promise<unknown>,
  expectedConstraint: string,
): Promise<void> {
  const unexpectedSuccess = `Expected ${expectedConstraint} to reject the write`;
  try {
    await operation;
    throw new Error(unexpectedSuccess);
  } catch (error) {
    if (error instanceof Error && error.message === unexpectedSuccess) {
      throw error;
    }
    expect((error as DatabaseError).driverError?.constraint).toBe(expectedConstraint);
  }
}

async function expectMigrationRefusal(
  migrationDataSource: DataSource,
  expectedConstraint: string,
): Promise<void> {
  const unexpectedSuccess = `Expected migration down to reject with ${expectedConstraint}`;
  try {
    await migrationDataSource.undoLastMigration({ transaction: 'all' });
    throw new Error(unexpectedSuccess);
  } catch (error) {
    if (error instanceof Error && error.message === unexpectedSuccess) {
      throw error;
    }
    expect((error as DatabaseError).driverError?.constraint).toBe(expectedConstraint);
  }
}

integrationDescribe(
  configuredVariables.length === 0
    ? 'Workers and badges PostgreSQL integration (BLOCKED: TEST_MASTER_DB_* is not configured)'
    : 'Workers and badges PostgreSQL integration',
  () => {
    if (!masterOptions || !provisionerCredentials) {
      it.skip('requires a dedicated _test Master database and TEST_MASTER_DB_* credentials', () => {});
      return;
    }

    let masterDataSource: DataSource;
    let tenantDatabaseManager: TenantDatabaseManager;
    let cleanup: TenantTestDatabaseCleanup;
    const tenants: TenantFixture[] = [];
    let tenantA: TenantFixture;
    let tenantB: TenantFixture;

    beforeAll(async () => {
      masterDataSource = new DataSource(masterOptions);
      await masterDataSource.initialize();
      await masterDataSource.runMigrations({ transaction: 'all' });
      tenantDatabaseManager = new TenantDatabaseManager({
        provisioner: provisionerCredentials,
        masterDataSource,
        runtimeHost: provisionerCredentials.host,
        runtimePort: provisionerCredentials.port,
        mode: 'test',
      });
      cleanup = new TenantTestDatabaseCleanup(
        process.env.TEST_MASTER_DB_NAME ?? '',
        provisionerCredentials,
      );
      tenantA = await createTenant();
      tenantB = await createTenant();
    }, 60_000);

    afterAll(async () => {
      await Promise.all(tenants.flatMap(({ runtimeDataSource, migrationDataSource }) => [
        runtimeDataSource.isInitialized ? runtimeDataSource.destroy() : Promise.resolve(),
        migrationDataSource.isInitialized ? migrationDataSource.destroy() : Promise.resolve(),
      ]));
      await cleanup?.cleanup();
      if (masterDataSource?.isInitialized) {
        await masterDataSource.destroy();
      }
    }, 60_000);

    async function createTenant(): Promise<TenantFixture> {
      const companyId = randomUUID();
      const databaseName = cleanup.trackCompany(companyId);
      const secret = tenantDatabaseManager.createSecret(companyId);
      await tenantDatabaseManager.ensureDatabase(companyId, databaseName, secret);

      const migrationDataSource = new DataSource(
        createTenantMigrationDataSourceOptions(tenantDatabaseManager.migrationCredentials(databaseName)),
      );
      await migrationDataSource.initialize();
      await migrationDataSource.runMigrations({ transaction: 'all' });
      await tenantDatabaseManager.grantRuntimePrivileges(companyId, databaseName, secret);

      const credentials = tenantDatabaseManager.runtimeCredentials(companyId, databaseName, secret);
      const runtimeDataSource = new DataSource(createTenantRuntimeDataSourceOptions(credentials));
      await runtimeDataSource.initialize();
      const fixture = { companyId, databaseName, credentials, runtimeDataSource, migrationDataSource };
      tenants.push(fixture);
      return fixture;
    }

    async function createActor(dataSource: DataSource): Promise<string> {
      const roleRows: Array<{ id: string }> = await dataSource.query(
        `INSERT INTO "roles" ("name") VALUES ($1) RETURNING "id"`,
        [`Workers integration ${randomUUID()}`],
      );
      const roleId = roleRows[0]?.id;
      if (!roleId) {
        throw new Error('Workers integration actor role insert did not return an ID');
      }
      const userRows: Array<{ id: string }> = await dataSource.query(
        `INSERT INTO "users" ("role_id", "email", "full_name", "password_hash")
         VALUES ($1, $2, 'Workers Integration Actor', 'test-hash') RETURNING "id"`,
        [roleId, `${randomUUID()}@example.test`],
      );
      const userId = userRows[0]?.id;
      if (!userId) {
        throw new Error('Workers integration actor insert did not return an ID');
      }
      return userId;
    }

    function services() {
      const audit = new AuditService();
      const badges = new BadgeHistoryService(audit);
      return {
        audit,
        badges,
        resolution: new BadgeResolutionService(),
        workers: new WorkersService(audit, badges),
      };
    }

    it('applies the additive schema, grants runtime access, and enforces DB identity/interval constraints', async () => {
      const rows: Array<{ name: string }> = await tenantA.migrationDataSource.query(
        `SELECT "name" FROM "tenant_typeorm_migrations" ORDER BY "timestamp"`,
      );
      expect(rows.at(-1)?.name).toBe(PATTA_MIGRATION_NAME);

      const schemaRows: Array<{ table_name: string }> = await tenantA.runtimeDataSource.query(
        `SELECT "table_name" FROM "information_schema"."tables"
         WHERE "table_schema" = 'public'
           AND "table_name" = ANY($1::varchar[])`,
        [['workers', 'worker_badge_history']],
      );
      expect(schemaRows.map(({ table_name }) => table_name).sort())
        .toEqual(['worker_badge_history', 'workers']);
      const columnRows: Array<{ column_name: string; is_nullable: string }> =
        await tenantA.migrationDataSource.query(
          `SELECT "column_name", "is_nullable"
           FROM "information_schema"."columns"
           WHERE "table_schema" = 'public' AND "table_name" = 'audit_log'
             AND "column_name" IN ('entity_id', 'entity_key')`,
        );
      expect(columnRows).toEqual(expect.arrayContaining([
        { column_name: 'entity_id', is_nullable: 'YES' },
        { column_name: 'entity_key', is_nullable: 'NO' },
      ]));
      const indexRows: Array<{ indexname: string }> = await tenantA.runtimeDataSource.query(
        `SELECT "indexname" FROM "pg_indexes"
         WHERE "schemaname" = 'public' AND "indexname" = 'ix_audit_log_entity_key'`,
      );
      expect(indexRows).toHaveLength(1);
      const inserted: Array<{ id: string }> = await tenantA.runtimeDataSource.query(
        `INSERT INTO "workers" ("full_name") VALUES ('Same Name') RETURNING "id"::text AS "id"`,
      );
      const insertedDuplicate: Array<{ id: string }> = await tenantA.runtimeDataSource.query(
        `INSERT INTO "workers" ("full_name") VALUES ('Same Name') RETURNING "id"::text AS "id"`,
      );
      const workerOne = inserted[0]?.id;
      const workerTwo = insertedDuplicate[0]?.id;
      expect(workerOne).toBe('1');
      expect(workerTwo).toBe('2');

      const actorUserId = await createActor(tenantA.runtimeDataSource);
      await expectConstraintViolation(
        tenantA.runtimeDataSource.query(
          `INSERT INTO "workers" ("full_name", "status") VALUES ('Invalid Status', 'DELETED')`,
        ),
        'ck_workers_status',
      );
      await expectConstraintViolation(
        tenantA.runtimeDataSource.query(
          `INSERT INTO "workers" ("full_name", "version") VALUES ('Invalid Version', 0)`,
        ),
        'ck_workers_version_positive',
      );
      await expectConstraintViolation(
        tenantA.runtimeDataSource.query(
          `INSERT INTO "workers" ("full_name") VALUES ('Noncanonical  Name')`,
        ),
        'ck_workers_full_name_canonical',
      );
      await tenantA.runtimeDataSource.query(
        `INSERT INTO "worker_badge_history"
           ("badge_number", "worker_id", "valid_from", "valid_to", "created_by")
         VALUES ('DB-OVERLAP', $1, '2026-01-01T00:00:00Z', '2026-05-16T00:00:00Z', $3),
                ('DB-OVERLAP', $2, '2026-05-16T00:00:00Z', NULL, $3)`,
        [workerOne, workerTwo, actorUserId],
      );
      await expectConstraintViolation(
        tenantA.runtimeDataSource.query(
          `INSERT INTO "worker_badge_history" ("badge_number", "worker_id", "valid_from")
           VALUES ('DB-OVERLAP', $1, '2026-05-15T00:00:00Z')`,
          [workerOne],
        ),
        'ex_worker_badge_history_no_overlap',
      );
      await expectConstraintViolation(
        tenantA.runtimeDataSource.query(
          `INSERT INTO "worker_badge_history" ("badge_number", "worker_id", "valid_from")
           VALUES ('BAD-FK', 999999, transaction_timestamp())`,
        ),
        'fk_worker_badge_history_worker_id',
      );
      await expectConstraintViolation(
        tenantA.runtimeDataSource.query(
          `INSERT INTO "worker_badge_history"
             ("badge_number", "worker_id", "valid_from", "valid_to")
           VALUES ('BAD-INTERVAL', $1, '2026-05-16T00:00:00Z', '2026-05-16T00:00:00Z')`,
          [workerOne],
        ),
        'ck_worker_badge_history_interval',
      );
      await expectConstraintViolation(
        tenantA.runtimeDataSource.query(
          `INSERT INTO "worker_badge_history" ("badge_number", "worker_id", "valid_from")
           VALUES (' BAD-TRIM ', $1, transaction_timestamp())`,
          [workerOne],
        ),
        'ck_worker_badge_history_badge_number',
      );
      await expectConstraintViolation(
        tenantA.runtimeDataSource.query('DELETE FROM "workers" WHERE "id" = $1', [workerOne]),
        'trg_workers_no_delete',
      );
      await expectConstraintViolation(
        tenantA.runtimeDataSource.query(
          'DELETE FROM "worker_badge_history" WHERE "badge_number" = $1',
          ['DB-OVERLAP'],
        ),
        'trg_worker_badge_history_close_only',
      );
      await expectConstraintViolation(
        tenantA.runtimeDataSource.query(
          `UPDATE "worker_badge_history" SET "badge_number" = 'CHANGED'
           WHERE "badge_number" = 'DB-OVERLAP' AND "worker_id" = $1`,
          [workerOne],
        ),
        'trg_worker_badge_history_close_only',
      );
    }, 30_000);

    it('backfills UUID audit keys and supports only lossless empty/UUID-compatible rollback', async () => {
      const tenant = await createTenant();
      await tenant.migrationDataSource.undoLastMigration({ transaction: 'all' });
      await tenant.migrationDataSource.undoLastMigration({ transaction: 'all' });
      const actorUserId = await createActor(tenant.runtimeDataSource);
      const entityId = randomUUID();
      const auditRows: Array<{ id: string }> = await tenant.runtimeDataSource.query(
        `INSERT INTO "audit_log"
           ("actor_user_id", "entity_type", "entity_id", "action", "before_json", "after_json")
         VALUES ($1, 'model', $2, 'model.create', NULL, '{"id":"legacy"}'::jsonb)
         RETURNING "id"::text AS "id"`,
        [actorUserId, entityId],
      );
      const auditId = auditRows[0]?.id;
      if (!auditId) {
        throw new Error('Legacy audit fixture did not return its ID');
      }

      const reapplied = await tenant.migrationDataSource.runMigrations({ transaction: 'all' });
      expect(reapplied.map(({ name }) => name)).toEqual([MIGRATION_NAME, PATTA_MIGRATION_NAME]);
      await new PattaSequenceInitializer().initialize(tenant.migrationDataSource, 1n);
      const backfilled: Array<{ entity_key: string; entity_id: string }> = await tenant.runtimeDataSource.query(
        'SELECT "entity_key", "entity_id"::text AS "entity_id" FROM "audit_log" WHERE "id" = $1',
        [auditId],
      );
      expect(backfilled[0]).toEqual({ entity_key: entityId, entity_id: entityId });

      await tenant.migrationDataSource.undoLastMigration({ transaction: 'all' });
      await tenant.migrationDataSource.undoLastMigration({ transaction: 'all' });
      const legacyAfterDown: Array<{ entity_id: string }> = await tenant.runtimeDataSource.query(
        'SELECT "entity_id"::text AS "entity_id" FROM "audit_log" WHERE "id" = $1',
        [auditId],
      );
      expect(legacyAfterDown[0]?.entity_id).toBe(entityId);
      const finalReapply = await tenant.migrationDataSource.runMigrations({ transaction: 'all' });
      expect(finalReapply.map(({ name }) => name)).toEqual([MIGRATION_NAME, PATTA_MIGRATION_NAME]);
      await new PattaSequenceInitializer().initialize(tenant.migrationDataSource, 1n);
      await tenantDatabaseManager.grantRuntimePrivileges(tenant.companyId, tenant.databaseName,
        tenantDatabaseManager.createSecret(tenant.companyId));
    }, 30_000);

    it('fails down without changing audit/schema when entity_key is a BIGINT identity', async () => {
      const tenant = await createTenant();
      const actorUserId = await createActor(tenant.runtimeDataSource);
      await tenant.runtimeDataSource.query(
        `INSERT INTO "audit_log"
           ("actor_user_id", "entity_type", "entity_id", "entity_key", "action", "before_json", "after_json")
         VALUES ($1, 'worker', NULL, '18', 'worker.create', NULL, '{"id":"18"}'::jsonb)`,
        [actorUserId],
      );

      await tenant.migrationDataSource.undoLastMigration({ transaction: 'all' });
      await expectMigrationRefusal(tenant.migrationDataSource, 'ck_audit_log_entity_key_reversible');
      const remaining: Array<{ entity_key: string; entity_id: string | null }> =
        await tenant.runtimeDataSource.query(
          'SELECT "entity_key", "entity_id"::text AS "entity_id" FROM "audit_log"',
        );
      expect(remaining).toEqual([{ entity_key: '18', entity_id: null }]);
      const tables: Array<{ table_name: string }> = await tenant.runtimeDataSource.query(
        `SELECT "table_name" FROM "information_schema"."tables"
         WHERE "table_schema" = 'public' AND "table_name" = 'workers'`,
      );
      expect(tables).toHaveLength(1);
    }, 30_000);

    it('refuses to roll audit checks back while a worker/badge event remains', async () => {
      const tenant = await createTenant();
      const actorUserId = await createActor(tenant.runtimeDataSource);
      const entityId = randomUUID();
      await tenant.runtimeDataSource.query(
        `INSERT INTO "audit_log"
           ("actor_user_id", "entity_type", "entity_id", "entity_key", "action", "before_json", "after_json")
         VALUES ($1, 'worker', $2::uuid, $2::uuid::text, 'worker.create', NULL, '{"id":"18"}'::jsonb)`,
        [actorUserId, entityId],
      );

      await tenant.migrationDataSource.undoLastMigration({ transaction: 'all' });
      await expectMigrationRefusal(tenant.migrationDataSource, 'ck_audit_log_legacy_values');
      const remains: Array<{ entity_type: string; action: string; entity_key: string }> =
        await tenant.runtimeDataSource.query(
          'SELECT "entity_type", "action", "entity_key" FROM "audit_log"',
        );
      expect(remains).toEqual([{ entity_type: 'worker', action: 'worker.create', entity_key: entityId }]);
      const typeChecks: Array<{ definition: string }> = await tenant.runtimeDataSource.query(
        `SELECT pg_get_constraintdef(oid) AS "definition" FROM pg_constraint
         WHERE conrelid = 'audit_log'::regclass AND conname = 'ck_audit_log_entity_type'`,
      );
      expect(typeChecks[0]?.definition).toContain("'worker'");
    }, 30_000);

    it('creates workers, preserves same names, updates optimistically, and audits atomically', async () => {
      const actorUserId = await createActor(tenantA.runtimeDataSource);
      await tenantA.runtimeDataSource.query(
        `SELECT setval(pg_get_serial_sequence('public.workers', 'id'), 17, true)`,
      );
      const feature = services();
      const worker18 = await feature.workers.create(tenantA.runtimeDataSource, actorUserId, {
        full_name: '  Abdullayeva\t Nodira  ',
      });
      expect(worker18).toMatchObject({ id: '18', full_name: 'Abdullayeva Nodira', version: '1' });

      await tenantA.runtimeDataSource.query(
        `SELECT setval(pg_get_serial_sequence('public.workers', 'id'), 46, true)`,
      );
      const worker47 = await feature.workers.create(tenantA.runtimeDataSource, actorUserId, {
        full_name: 'Abdullayeva Nodira',
      });
      expect(worker47).toMatchObject({ id: '47', full_name: 'Abdullayeva Nodira', version: '1' });

      await tenantA.runtimeDataSource.query(
        `SELECT setval(pg_get_serial_sequence('public.workers', 'id'), 9007199254740992::bigint, true)`,
      );
      const largeIdWorker = await feature.workers.create(tenantA.runtimeDataSource, actorUserId, {
        full_name: 'Large ID Worker',
      });
      expect(largeIdWorker.id).toBe('9007199254740993');

      const updated = await feature.workers.update(tenantA.runtimeDataSource, actorUserId, '18', {
        full_name: 'aBDULLAYEVA nODIRA',
        expected_version: '1',
      });
      expect(updated).toMatchObject({ full_name: 'aBDULLAYEVA nODIRA', version: '2' });
      await expect(feature.workers.update(tenantA.runtimeDataSource, actorUserId, '18', {
        full_name: 'Stale Update',
        expected_version: '1',
      })).rejects.toMatchObject({ response: { code: 'VERSION_CONFLICT' } });

      const beforeCount: Array<{ count: string }> = await tenantA.runtimeDataSource.query(
        'SELECT count(*)::text AS "count" FROM "workers"',
      );
      await expect(feature.workers.create(tenantA.runtimeDataSource, randomUUID(), {
        full_name: 'Must Roll Back',
      })).rejects.toMatchObject({ driverError: { constraint: 'fk_audit_log_actor_user_id' } });
      const afterCount: Array<{ count: string }> = await tenantA.runtimeDataSource.query(
        'SELECT count(*)::text AS "count" FROM "workers"',
      );
      expect(afterCount[0]?.count).toBe(beforeCount[0]?.count);

      const auditRows: Array<{ entity_type: string; entity_key: string; entity_id: string | null; action: string }> =
        await tenantA.runtimeDataSource.query(
          `SELECT "entity_type", "entity_key", "entity_id"::text AS "entity_id", "action"
           FROM "audit_log" WHERE "entity_type" = 'worker' ORDER BY "created_at", "id"`,
        );
      expect(auditRows).toEqual(expect.arrayContaining([
        { entity_type: 'worker', entity_key: '18', entity_id: null, action: 'worker.create' },
        { entity_type: 'worker', entity_key: '47', entity_id: null, action: 'worker.create' },
        { entity_type: 'worker', entity_key: '18', entity_id: null, action: 'worker.update' },
      ]));
    }, 30_000);

    it('assigns/reassigns/releases badges, resolves historical fixtures, and closes badges on deactivation', async () => {
      const actorUserId = await createActor(tenantA.runtimeDataSource);
      const feature = services();
      await tenantA.runtimeDataSource.query(
        `INSERT INTO "worker_badge_history"
           ("badge_number", "worker_id", "valid_from", "valid_to", "created_by")
         VALUES ('125', 18, '2026-01-01T00:00:00Z', '2026-05-16T00:00:00Z', $1),
                ('125', 47, '2026-05-16T00:00:00Z', NULL, $1)`,
        [actorUserId],
      );
      const workerHistory = await feature.badges.listByWorker(tenantA.runtimeDataSource, '18');
      const historyStartTimes = workerHistory.map(({ valid_from }) => valid_from);
      expect(historyStartTimes).toEqual(historyStartTimes.slice().sort());
      expect(workerHistory).toEqual(expect.arrayContaining([
        expect.objectContaining({ badge_number: '125', worker_id: '18', valid_to: '2026-05-16T00:00:00.000000Z' }),
      ]));

      await expect(feature.resolution.resolve(
        tenantA.runtimeDataSource,
        '125',
        '2026-01-15T00:00:00Z',
      )).resolves.toMatchObject({ worker_id: '18' });
      await expect(feature.resolution.resolve(
        tenantA.runtimeDataSource,
        '125',
        '2026-06-15T00:00:00Z',
      )).resolves.toMatchObject({ worker_id: '47' });
      await expect(feature.resolution.resolve(
        tenantA.runtimeDataSource,
        '125',
        '2026-05-16T00:00:00Z',
      )).resolves.toMatchObject({ worker_id: '47' });

      await expect(feature.badges.reassign(tenantA.runtimeDataSource, actorUserId, '125', {
        worker_id: '18',
        effective_at: '2026-06-01T00:00:00Z',
      })).rejects.toMatchObject({ response: { code: 'BADGE_EFFECTIVE_AT_IN_PAST' } });
      const current = await feature.badges.reassign(tenantA.runtimeDataSource, actorUserId, '125', {
        worker_id: '18',
      });
      expect(current.worker_id).toBe('18');
      await expect(feature.resolution.resolve(
        tenantA.runtimeDataSource,
        '125',
        '2026-06-15T00:00:00Z',
      )).resolves.toMatchObject({ worker_id: '47' });
      await expect(feature.resolution.resolveCurrent(tenantA.runtimeDataSource, '125'))
        .resolves.toMatchObject({ worker_id: '18' });

      const released = await feature.badges.release(tenantA.runtimeDataSource, actorUserId, '125', {});
      expect(released.worker_id).toBe('18');
      await expect(feature.resolution.resolveCurrent(tenantA.runtimeDataSource, '125'))
        .rejects.toMatchObject({ response: { code: 'BADGE_ASSIGNMENT_NOT_FOUND' } });
      const assignedAgain = await feature.badges.assign(tenantA.runtimeDataSource, actorUserId, '47', {
        badge_number: '125',
      });
      expect(assignedAgain.worker_id).toBe('47');
      await expect(feature.resolution.resolveCurrent(tenantA.runtimeDataSource, '125'))
        .resolves.toMatchObject({ worker_id: '47' });

      await feature.badges.assign(tenantA.runtimeDataSource, actorUserId, '18', {
        badge_number: 'DEACT-125',
      });
      await feature.badges.assign(tenantA.runtimeDataSource, actorUserId, '18', {
        badge_number: 'DEACT-126',
      });
      const deactivated = await feature.workers.update(tenantA.runtimeDataSource, actorUserId, '18', {
        status: 'INACTIVE',
        expected_version: '2',
      });
      expect(deactivated).toMatchObject({ status: 'INACTIVE', version: '3' });
      const deactivatedHistory: Array<{ valid_to: string; worker_updated_at: string }> =
        await tenantA.runtimeDataSource.query(
          `SELECT to_char(history."valid_to" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "valid_to",
                  to_char(worker."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "worker_updated_at"
           FROM "worker_badge_history" AS history
           INNER JOIN "workers" AS worker ON worker."id" = history."worker_id"
           WHERE history."badge_number" IN ('DEACT-125', 'DEACT-126')
           ORDER BY history."badge_number"`,
        );
      expect(deactivatedHistory).toHaveLength(2);
      expect(deactivatedHistory.every(({ valid_to, worker_updated_at }) => valid_to === worker_updated_at)).toBe(true);
      await expect(feature.badges.assign(tenantA.runtimeDataSource, actorUserId, '18', {
        badge_number: 'INACTIVE-125',
      })).rejects.toMatchObject({ response: { code: 'WORKER_INACTIVE' } });

      const badgeAuditRows: Array<{ action: string; entity_key: string; after_json: Record<string, unknown> }> =
        await tenantA.runtimeDataSource.query(
          `SELECT "action", "entity_key", "after_json"
           FROM "audit_log" WHERE "entity_type" = 'badge' ORDER BY "created_at", "id"`,
        );
      expect(badgeAuditRows.map(({ action }) => action)).toEqual(expect.arrayContaining([
        'badge.reassign', 'badge.release', 'badge.close',
      ]));
      expect(badgeAuditRows.every(({ entity_key }) => entity_key.length === 36)).toBe(true);
      expect(badgeAuditRows.every(({ after_json }) => 'badge_number' in after_json)).toBe(true);
      const deactivationAudit: Array<{ entity_key: string; action: string }> =
        await tenantA.runtimeDataSource.query(
          `SELECT "entity_key", "action" FROM "audit_log"
           WHERE "entity_type" = 'worker' AND "entity_key" = '18' AND "action" = 'worker.deactivate'`,
        );
      expect(deactivationAudit).toHaveLength(1);
    }, 30_000);

    it('rolls back badge interval and worker deactivation when badge audit insert fails', async () => {
      const actorUserId = await createActor(tenantA.runtimeDataSource);
      const feature = services();
      await tenantA.migrationDataSource.query(`
        CREATE FUNCTION "reject_test_badge_audit"()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF (NEW."action" = 'badge.assign' AND NEW."after_json"->>'badge_number' = 'ROLLBACK-125')
            OR NEW."action" = 'badge.close' THEN
            RAISE EXCEPTION 'test audit failure' USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END $$
      `);
      await tenantA.migrationDataSource.query(`
        CREATE TRIGGER "trg_test_badge_audit_failure"
        BEFORE INSERT ON "audit_log" FOR EACH ROW
        EXECUTE FUNCTION "reject_test_badge_audit"()
      `);
      try {
        await expect(feature.badges.assign(tenantA.runtimeDataSource, actorUserId, '47', {
          badge_number: 'ROLLBACK-125',
        })).rejects.toThrow(/test audit failure/);
        const noAssignment: Array<{ count: string }> = await tenantA.runtimeDataSource.query(
          `SELECT count(*)::text AS "count" FROM "worker_badge_history"
           WHERE "badge_number" = 'ROLLBACK-125'`,
        );
        expect(noAssignment[0]?.count).toBe('0');

        await feature.badges.assign(tenantA.runtimeDataSource, actorUserId, '47', {
          badge_number: 'ROLLBACK-CLOSE',
        });
        await expect(feature.workers.update(tenantA.runtimeDataSource, actorUserId, '47', {
          status: 'INACTIVE',
          expected_version: '1',
        })).rejects.toThrow(/test audit failure/);
        const afterRollback: Array<{ status: string; version: string; valid_to: string | null }> =
          await tenantA.runtimeDataSource.query(
            `SELECT worker."status", worker."version"::text AS "version",
                    history."valid_to"::text AS "valid_to"
             FROM "workers" AS worker
             INNER JOIN "worker_badge_history" AS history ON history."worker_id" = worker."id"
             WHERE worker."id" = 47 AND history."badge_number" = 'ROLLBACK-CLOSE'`,
          );
        expect(afterRollback).toEqual([{ status: 'ACTIVE', version: '1', valid_to: null }]);
      } finally {
        await tenantA.migrationDataSource.query('DROP TRIGGER "trg_test_badge_audit_failure" ON "audit_log"');
        await tenantA.migrationDataSource.query('DROP FUNCTION "reject_test_badge_audit"()');
      }
    }, 30_000);

    it('isolates identical worker IDs and badge numbers between tenant databases', async () => {
      const actorUserId = await createActor(tenantB.runtimeDataSource);
      const feature = services();
      const tenantBWorker = await feature.workers.create(tenantB.runtimeDataSource, actorUserId, {
        full_name: 'Tenant B worker',
      });
      expect(tenantBWorker.id).toBe('1');
      await feature.badges.assign(tenantB.runtimeDataSource, actorUserId, '1', {
        badge_number: '125',
      });

      await expect(feature.resolution.resolveCurrent(tenantB.runtimeDataSource, '125'))
        .resolves.toMatchObject({ worker_id: '1', full_name: 'Tenant B worker' });
      await expect(feature.resolution.resolve(
        tenantA.runtimeDataSource,
        '125',
        '2026-06-15T00:00:00Z',
      )).resolves.toMatchObject({ worker_id: '47' });
      expect(tenantA.databaseName).not.toBe(tenantB.databaseName);
    }, 30_000);

    it('serializes concurrent first assignments for the same badge', async () => {
      const actorUserId = await createActor(tenantA.runtimeDataSource);
      const feature = services();
      const results = await Promise.allSettled([
        feature.badges.assign(tenantA.runtimeDataSource, actorUserId, '1', {
          badge_number: 'RACE-125',
        }),
        feature.badges.assign(tenantA.runtimeDataSource, actorUserId, '47', {
          badge_number: 'RACE-125',
        }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected).toMatchObject({
        status: 'rejected',
        reason: { response: { code: 'BADGE_ALREADY_ASSIGNED' } },
      });
      const openRows: Array<{ count: string }> = await tenantA.runtimeDataSource.query(
        `SELECT count(*)::text AS "count" FROM "worker_badge_history"
         WHERE "badge_number" = 'RACE-125' AND "valid_to" IS NULL`,
      );
      expect(openRows[0]?.count).toBe('1');
    }, 30_000);

    it('refuses to revert a populated worker/badge tenant without changing migration state', async () => {
      await tenantA.migrationDataSource.undoLastMigration({ transaction: 'all' });
      await expectMigrationRefusal(tenantA.migrationDataSource, 'ck_workers_badges_empty_before_revert');
      const migrations: Array<{ name: string }> = await tenantA.migrationDataSource.query(
        'SELECT "name" FROM "tenant_typeorm_migrations" ORDER BY "timestamp" DESC LIMIT 1',
      );
      expect(migrations[0]?.name).toBe(MIGRATION_NAME);
      const auditRows: Array<{ count: string }> = await tenantA.runtimeDataSource.query(
        'SELECT count(*)::text AS "count" FROM "audit_log"',
      );
      expect(BigInt(auditRows[0]?.count ?? '0')).toBeGreaterThan(0n);
    }, 30_000);
  },
);
