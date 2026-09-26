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
import { OperationPriceService } from '../operations/operation-price.service.js';
import { OperationsService } from '../operations/operations.service.js';
import { TenantRbacService } from '../rbac/tenant-rbac.service.js';
import { ModelsService } from './models.service.js';

const TEST_DATABASE_VARIABLES = [
  'TEST_MASTER_DB_HOST',
  'TEST_MASTER_DB_PORT',
  'TEST_MASTER_DB_NAME',
  'TEST_MASTER_DB_USER',
  'TEST_MASTER_DB_PASSWORD',
] as const;

const configuredVariables = TEST_DATABASE_VARIABLES.filter((key) =>
  Boolean(process.env[key]?.trim()),
);
if (configuredVariables.length > 0 && configuredVariables.length !== TEST_DATABASE_VARIABLES.length) {
  const missing = TEST_DATABASE_VARIABLES.filter((key) => !process.env[key]?.trim());
  throw new Error(`Models/operations integration configuration is incomplete: ${missing.join(', ')}`);
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
const MIGRATION_NAME = 'AddModelsOperationsAndPriceHistory20260926000300';
const WORKERS_BADGES_MIGRATION_NAME = 'AddWorkersAndBadgeHistory20260926000400';
const PATTA_MIGRATION_NAME = 'AddPattaFoundation20260926000500';

interface ConstraintError {
  driverError?: {
    constraint?: string;
  };
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
    const constraint = (error as ConstraintError).driverError?.constraint;
    expect(constraint).toBe(expectedConstraint);
  }
}

integrationDescribe(
  configuredVariables.length === 0
    ? 'Models and operation PostgreSQL integration (BLOCKED: TEST_MASTER_DB_* is not configured)'
    : 'Models and operation PostgreSQL integration',
  () => {
    if (!masterOptions || !provisionerCredentials) {
      it.skip('requires a dedicated _test Master database and TEST_MASTER_DB_* credentials', () => {});
      return;
    }

    let masterDataSource: DataSource;
    let tenantDatabaseManager: TenantDatabaseManager;
    let cleanup: TenantTestDatabaseCleanup;
    const tenants: TenantFixture[] = [];

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
      await createTenant();
    }, 30_000);

    afterAll(async () => {
      await Promise.all(tenants.flatMap(({ runtimeDataSource, migrationDataSource }) => [
        runtimeDataSource.isInitialized ? runtimeDataSource.destroy() : Promise.resolve(),
        migrationDataSource.isInitialized ? migrationDataSource.destroy() : Promise.resolve(),
      ]));
      await cleanup?.cleanup();
      if (masterDataSource?.isInitialized) {
        await masterDataSource.destroy();
      }
    }, 30_000);

    async function createTenant(): Promise<TenantFixture> {
      const companyId = randomUUID();
      const databaseName = cleanup.trackCompany(companyId);
      const secret = tenantDatabaseManager.createSecret(companyId);
      await tenantDatabaseManager.ensureDatabase(companyId, databaseName, secret);

      const migrationCredentials = tenantDatabaseManager.migrationCredentials(databaseName);
      const migrationDataSource = new DataSource(
        createTenantMigrationDataSourceOptions(migrationCredentials),
      );
      await migrationDataSource.initialize();
      await migrationDataSource.runMigrations({ transaction: 'all' });

      await tenantDatabaseManager.grantRuntimePrivileges(companyId, databaseName, secret);
      const credentials = tenantDatabaseManager.runtimeCredentials(
        companyId,
        databaseName,
        secret,
      );
      const runtimeDataSource = new DataSource(createTenantRuntimeDataSourceOptions(credentials));
      await runtimeDataSource.initialize();
      const fixture = {
        companyId,
        databaseName,
        credentials,
        runtimeDataSource,
        migrationDataSource,
      };
      tenants.push(fixture);
      return fixture;
    }

    async function createActor(dataSource: DataSource): Promise<string> {
      const roleRows: Array<{ id: string }> = await dataSource.query(
        `INSERT INTO "roles" ("name") VALUES ($1) RETURNING "id"`,
        [`Models integration role ${randomUUID()}`],
      );
      const roleId = roleRows[0]?.id;
      if (!roleId) {
        throw new Error('Test actor role insert did not return an ID');
      }
      const userRows: Array<{ id: string }> = await dataSource.query(
        `INSERT INTO "users" ("role_id", "email", "full_name", "password_hash")
         VALUES ($1, $2, 'Models Integration Actor', 'test-hash') RETURNING "id"`,
        [roleId, `${randomUUID()}@example.test`],
      );
      const userId = userRows[0]?.id;
      if (!userId) {
        throw new Error('Test actor user insert did not return an ID');
      }
      return userId;
    }

    function featureServices() {
      const audit = new AuditService();
      const prices = new OperationPriceService(audit);
      return {
        audit,
        prices,
        models: new ModelsService(audit),
        operations: new OperationsService(audit, prices),
      };
    }

    async function futureTimestamp(dataSource: DataSource, offset: string): Promise<string> {
      const rows: Array<{ value: string }> = await dataSource.query(
        `SELECT to_char(
           (transaction_timestamp() + $1::interval) AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) AS "value"`,
        [offset],
      );
      const value = rows[0]?.value;
      if (!value) {
        throw new Error('Database did not return the test schedule timestamp');
      }
      return value;
    }

    it('applies the additive tenant migration and grants DML to the runtime role', async () => {
      const tenant = tenants[0];
      if (!tenant) {
        throw new Error('Tenant fixture was not initialized');
      }
      const migrations: Array<{ name: string }> = await tenant.migrationDataSource.query(
        `SELECT "name" FROM "tenant_typeorm_migrations" ORDER BY "timestamp"`,
      );
      expect(migrations.at(-1)?.name).toBe(PATTA_MIGRATION_NAME);
      expect(migrations.map(({ name }) => name)).toContain(MIGRATION_NAME);

      const tableRows: Array<{ table_name: string }> = await tenant.runtimeDataSource.query(
        `SELECT "table_name" FROM "information_schema"."tables"
         WHERE "table_schema" = 'public' AND "table_name" = ANY($1::varchar[])`,
        [['models', 'model_operations', 'model_operation_prices', 'audit_log']],
      );
      expect(tableRows.map(({ table_name }) => table_name).sort()).toEqual([
        'audit_log',
        'model_operation_prices',
        'model_operations',
        'models',
      ]);

      const inserted: Array<{ id: string }> = await tenant.runtimeDataSource.query(
        `INSERT INTO "models" ("name") VALUES ('Runtime grant check') RETURNING "id"`,
      );
      expect(inserted).toHaveLength(1);
    });

    it('enforces canonical active-name uniqueness, status checks, and foreign keys', async () => {
      const tenant = tenants[0];
      if (!tenant) {
        throw new Error('Tenant fixture was not initialized');
      }
      await tenant.runtimeDataSource.query(
        `INSERT INTO "models" ("name") VALUES ($1)`,
        [' \tAtlas\r\n\v\f  Knit  '],
      );
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `INSERT INTO "models" ("name") VALUES ($1)`,
          ['atlas knit'],
        ),
        'uq_models_active_name',
      );
      await tenant.runtimeDataSource.query(
        `INSERT INTO "models" ("name", "status") VALUES ($1, 'INACTIVE')`,
        ['ATLAS KNIT'],
      );
      const inactiveModelRows: Array<{ id: string }> = await tenant.runtimeDataSource.query(
        `SELECT "id" FROM "models" WHERE "name" = 'ATLAS KNIT'`,
      );
      const inactiveModelId = inactiveModelRows[0]?.id;
      if (!inactiveModelId) {
        throw new Error('Inactive duplicate model was not created');
      }
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(`DELETE FROM "models" WHERE "id" = $1`, [inactiveModelId]),
        'trg_models_no_delete',
      );
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `INSERT INTO "models" ("name", "status") VALUES ('Invalid status', 'ARCHIVED')`,
        ),
        'ck_models_status',
      );
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `INSERT INTO "model_operations" ("model_id", "name", "price", "sort_order")
           VALUES ($1, 'Missing model', 0, 0)`,
          [randomUUID()],
        ),
        'fk_model_operations_model_id',
      );
    });

    it('enforces operation checks and non-overlapping half-open price intervals', async () => {
      const tenant = tenants[0];
      if (!tenant) {
        throw new Error('Tenant fixture was not initialized');
      }
      const modelRows: Array<{ id: string }> = await tenant.runtimeDataSource.query(
        `INSERT INTO "models" ("name") VALUES ($1) RETURNING "id"`,
        [`Constraint model ${randomUUID()}`],
      );
      const modelId = modelRows[0]?.id;
      if (!modelId) {
        throw new Error('Model insert did not return an ID');
      }
      const operationRows: Array<{ id: string }> = await tenant.runtimeDataSource.query(
        `INSERT INTO "model_operations" ("model_id", "name", "price", "sort_order")
         VALUES ($1, 'Seam', 10.00, 0) RETURNING "id"`,
        [modelId],
      );
      const operationId = operationRows[0]?.id;
      if (!operationId) {
        throw new Error('Operation insert did not return an ID');
      }
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `INSERT INTO "model_operations" ("model_id", "name", "price", "sort_order")
           VALUES ($1, 'Negative', -1.00, 0)`,
          [modelId],
        ),
        'ck_model_operations_price_nonnegative',
      );
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `INSERT INTO "model_operations" ("model_id", "name", "price", "sort_order")
           VALUES ($1, 'Bad order', 0, -1)`,
          [modelId],
        ),
        'ck_model_operations_sort_order_nonnegative',
      );
      await tenant.runtimeDataSource.query(
        `INSERT INTO "model_operations" ("model_id", "name", "price", "sort_order")
         VALUES ($1, $2, 0, 1)`,
        [modelId, '  Yeng\t   Tikish  '],
      );
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `INSERT INTO "model_operations" ("model_id", "name", "price", "sort_order")
           VALUES ($1, 'yeng tikish', 0, 2)`,
          [modelId],
        ),
        'uq_model_operations_active_name',
      );

      await tenant.runtimeDataSource.query(
        `INSERT INTO "model_operation_prices" ("operation_id", "price", "valid_from", "valid_to")
         VALUES ($1, 10.00, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
        [operationId],
      );
      await tenant.runtimeDataSource.query(
        `INSERT INTO "model_operation_prices" ("operation_id", "price", "valid_from")
         VALUES ($1, 11.00, '2026-10-01T00:00:00Z')`,
        [operationId],
      );
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `INSERT INTO "model_operation_prices" ("operation_id", "price", "valid_from")
           VALUES ($1, 12.00, '2026-09-15T00:00:00Z')`,
          [operationId],
        ),
        'ex_model_operation_prices_no_overlap',
      );
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `INSERT INTO "model_operation_prices" ("operation_id", "price", "valid_from", "valid_to")
           VALUES ($1, -1.00, '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z')`,
          [operationId],
        ),
        'ck_model_operation_prices_price_nonnegative',
      );
      const firstPriceRows: Array<{ id: string }> = await tenant.runtimeDataSource.query(
        `SELECT "id" FROM "model_operation_prices" WHERE "operation_id" = $1 AND "price" = 10.00`,
        [operationId],
      );
      const firstPriceId = firstPriceRows[0]?.id;
      if (!firstPriceId) {
        throw new Error('Initial constraint-test price was not created');
      }
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `UPDATE "model_operation_prices" SET "price" = 10.50 WHERE "id" = $1`,
          [firstPriceId],
        ),
        'trg_model_operation_prices_immutable',
      );
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `DELETE FROM "model_operation_prices" WHERE "id" = $1`,
          [firstPriceId],
        ),
        'trg_model_operation_prices_immutable',
      );
    });

    it('creates initial history and resolves chained future schedules without changing current or prior prices', async () => {
      const tenant = tenants[0];
      if (!tenant) {
        throw new Error('Tenant fixture was not initialized');
      }
      const actorUserId = await createActor(tenant.runtimeDataSource);
      const { models, operations, prices } = featureServices();
      const model = await models.create(tenant.runtimeDataSource, actorUserId, {
        name: '  Historical\t Knit  ',
      });
      const operation = await operations.create(
        tenant.runtimeDataSource,
        model.id,
        actorUserId,
        { name: '  Yeng   tikish ', price: '1000', sort_order: 0 },
      );
      expect(operation).toMatchObject({ name: 'Yeng tikish', price: '1000.00', version: '1' });

      const initialHistory = await prices.listHistory(tenant.runtimeDataSource, operation.id);
      expect(initialHistory).toHaveLength(1);
      expect(initialHistory[0]).toMatchObject({ price: '1000.00', valid_to: null });

      const firstEffectiveFrom = await futureTimestamp(tenant.runtimeDataSource, '1 day');
      const firstSchedule = await prices.changePrice(tenant.runtimeDataSource, {
        operationId: operation.id,
        actorUserId,
        price: '1200.00',
        effectiveFrom: firstEffectiveFrom,
        expectedVersion: '1',
      });
      expect(firstSchedule).toMatchObject({ price: '1200.00', operation_version: '2' });

      const currentBeforeFuture = await prices.resolveCurrentPrice(
        tenant.runtimeDataSource,
        operation.id,
      );
      expect(currentBeforeFuture).toBe('1000.00');
      await expect(prices.resolvePrice(
        operation.id,
        initialHistory[0]?.valid_from ?? '',
        tenant.runtimeDataSource,
      )).resolves.toBe('1000.00');
      await expect(prices.resolvePrice(
        operation.id,
        firstEffectiveFrom,
        tenant.runtimeDataSource,
      )).resolves.toBe('1200.00');

      const secondEffectiveFrom = await tenant.runtimeDataSource.query(
        `SELECT to_char(($1::timestamptz + interval '1 day') AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "value"`,
        [firstEffectiveFrom],
      ).then((rows: Array<{ value: string }>) => rows[0]?.value);
      if (!secondEffectiveFrom) {
        throw new Error('Database did not return the second future schedule timestamp');
      }
      const secondSchedule = await prices.changePrice(tenant.runtimeDataSource, {
        operationId: operation.id,
        actorUserId,
        price: '1350.00',
        effectiveFrom: secondEffectiveFrom,
        expectedVersion: '2',
      });
      expect(secondSchedule).toMatchObject({ price: '1350.00', operation_version: '3' });

      const intervals = await prices.listHistory(tenant.runtimeDataSource, operation.id);
      expect(intervals).toHaveLength(3);
      expect(intervals.map(({ price }) => price)).toEqual(['1000.00', '1200.00', '1350.00']);
      expect(intervals[0]?.valid_to).toBe(intervals[1]?.valid_from);
      expect(intervals[1]?.valid_to).toBe(intervals[2]?.valid_from);
      expect(intervals[2]?.valid_to).toBeNull();
      await expect(prices.resolvePrice(operation.id, secondEffectiveFrom, tenant.runtimeDataSource))
        .resolves.toBe('1350.00');

      const currentOperation = await operations.getById(tenant.runtimeDataSource, operation.id);
      expect(currentOperation.price).toBe('1000.00');
      const storedCompatibilityPrice: Array<{ price: string }> = await tenant.runtimeDataSource.query(
        `SELECT "price"::text AS "price" FROM "model_operations" WHERE "id" = $1`,
        [operation.id],
      );
      expect(storedCompatibilityPrice[0]?.price).toBe('1350.00');

      await expect(prices.changePrice(tenant.runtimeDataSource, {
        operationId: operation.id,
        actorUserId,
        price: '1250.00',
        effectiveFrom: await futureTimestamp(tenant.runtimeDataSource, '12 hours'),
        expectedVersion: '3',
      })).rejects.toMatchObject({ response: { code: 'OPERATION_PRICE_CONFLICT' } });
    });

    it('rejects backdating, accepts an omitted DB-now effective time, and rolls back audit failures', async () => {
      const tenant = tenants[0];
      if (!tenant) {
        throw new Error('Tenant fixture was not initialized');
      }
      const actorUserId = await createActor(tenant.runtimeDataSource);
      const { models, operations, prices } = featureServices();
      const model = await models.create(tenant.runtimeDataSource, actorUserId, {
        name: `Backdate model ${randomUUID()}`,
      });
      const operation = await operations.create(
        tenant.runtimeDataSource,
        model.id,
        actorUserId,
        { name: 'Stitch', price: '900.00', sort_order: 0 },
      );
      const pastTime = await tenant.runtimeDataSource.query(
        `SELECT to_char((transaction_timestamp() - interval '1 day') AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "value"`,
      ).then((rows: Array<{ value: string }>) => rows[0]?.value);
      if (!pastTime) {
        throw new Error('Database did not return a past timestamp');
      }
      await expect(prices.changePrice(tenant.runtimeDataSource, {
        operationId: operation.id,
        actorUserId,
        price: '950.00',
        effectiveFrom: pastTime,
        expectedVersion: '1',
      })).rejects.toMatchObject({ response: { code: 'PRICE_EFFECTIVE_FROM_IN_PAST' } });
      expect(await prices.listHistory(tenant.runtimeDataSource, operation.id)).toHaveLength(1);

      const immediate = await prices.changePrice(tenant.runtimeDataSource, {
        operationId: operation.id,
        actorUserId,
        price: '950.00',
        expectedVersion: '1',
      });
      expect(immediate).toMatchObject({ price: '950.00', operation_version: '2' });
      const adjacentHistory = await prices.listHistory(tenant.runtimeDataSource, operation.id);
      expect(adjacentHistory).toHaveLength(2);
      expect(adjacentHistory[0]?.valid_to).toBe(adjacentHistory[1]?.valid_from);

      const modelToRollback = await models.create(tenant.runtimeDataSource, actorUserId, {
        name: `Audit rollback model ${randomUUID()}`,
      });
      const failedActorId = randomUUID();
      await expect(models.update(
        tenant.runtimeDataSource,
        failedActorId,
        modelToRollback.id,
        { name: 'Should not persist', expected_version: '1' },
      )).rejects.toBeDefined();
      await expect(models.getById(tenant.runtimeDataSource, modelToRollback.id)).resolves.toMatchObject({
        name: modelToRollback.name,
        version: '1',
      });
    });

    it('serializes concurrent schedules, enforces inactive state rules, and isolates tenants', async () => {
      const tenantA = tenants[0];
      if (!tenantA) {
        throw new Error('Tenant fixture was not initialized');
      }
      const tenantB = await createTenant();
      const actorA = await createActor(tenantA.runtimeDataSource);
      const actorB = await createActor(tenantB.runtimeDataSource);
      const roleRows: Array<{ role_id: string }> = await tenantA.runtimeDataSource.query(
        `SELECT "role_id" FROM "users" WHERE "id" = $1`,
        [actorA],
      );
      const roleId = roleRows[0]?.role_id;
      if (!roleId) {
        throw new Error('Tenant actor did not have an assigned role');
      }
      const permissionService = new TenantRbacService();
      await tenantA.runtimeDataSource.query(
        `INSERT INTO "permissions" ("code", "description") VALUES
           ('models.view', 'test models view'), ('models.manage', 'test models manage')
         ON CONFLICT ("code") DO NOTHING`,
      );
      await tenantA.runtimeDataSource.query(
        `INSERT INTO "role_permissions" ("role_id", "permission_id")
         SELECT $1, "id" FROM "permissions" WHERE "code" IN ('models.view', 'models.manage')
         ON CONFLICT DO NOTHING`,
        [roleId],
      );
      await expect(permissionService.hasAllPermissions(
        tenantA.runtimeDataSource,
        actorA,
        ['models.view'],
      )).resolves.toBe(true);
      await expect(permissionService.hasAllPermissions(
        tenantA.runtimeDataSource,
        actorA,
        ['models.manage'],
      )).resolves.toBe(true);
      await tenantA.runtimeDataSource.query(
        `DELETE FROM "role_permissions" WHERE "role_id" = $1 AND "permission_id" = (
           SELECT "id" FROM "permissions" WHERE "code" = 'models.manage'
         )`,
        [roleId],
      );
      await expect(permissionService.hasAllPermissions(
        tenantA.runtimeDataSource,
        actorA,
        ['models.manage'],
      )).resolves.toBe(false);

      const servicesA = featureServices();
      const servicesB = featureServices();
      const modelA = await servicesA.models.create(tenantA.runtimeDataSource, actorA, {
        name: 'Same name in independent tenant',
      });
      const modelB = await servicesB.models.create(tenantB.runtimeDataSource, actorB, {
        name: 'Same name in independent tenant',
      });
      expect(modelA.id).not.toBe(modelB.id);
      await expect(servicesA.models.getById(tenantA.runtimeDataSource, modelA.id))
        .resolves.toMatchObject({ name: 'Same name in independent tenant' });
      await expect(servicesB.models.getById(tenantB.runtimeDataSource, modelB.id))
        .resolves.toMatchObject({ name: 'Same name in independent tenant' });
      await expect(servicesB.models.getById(tenantB.runtimeDataSource, modelA.id))
        .rejects.toMatchObject({ response: { code: 'MODEL_NOT_FOUND' } });

      const operationA = await servicesA.operations.create(
        tenantA.runtimeDataSource,
        modelA.id,
        actorA,
        { name: 'Race price', price: '1000.00', sort_order: 0 },
      );
      const scheduleTimes = await Promise.all([
        futureTimestamp(tenantA.runtimeDataSource, '1 day'),
        futureTimestamp(tenantA.runtimeDataSource, '2 days'),
      ]);
      const raceResults = await Promise.allSettled(scheduleTimes.map((effectiveFrom, index) =>
        servicesA.prices.changePrice(tenantA.runtimeDataSource, {
          operationId: operationA.id,
          actorUserId: actorA,
          price: index === 0 ? '1100.00' : '1200.00',
          effectiveFrom,
          expectedVersion: '1',
        }),
      ));
      expect(raceResults.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(raceResults.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      const rejectedRace = raceResults.find(({ status }) => status === 'rejected');
      expect(rejectedRace?.status === 'rejected' ? rejectedRace.reason : undefined)
        .toMatchObject({ response: { code: 'VERSION_CONFLICT' } });

      const inactiveOperation = await servicesA.operations.create(
        tenantA.runtimeDataSource,
        modelA.id,
        actorA,
        { name: 'Inactive operation', price: '500.00', sort_order: 1, status: 'INACTIVE' },
      );
      await expect(servicesA.prices.changePrice(tenantA.runtimeDataSource, {
        operationId: inactiveOperation.id,
        actorUserId: actorA,
        price: '550.00',
        expectedVersion: '1',
      })).rejects.toMatchObject({ response: { code: 'OPERATION_INACTIVE' } });

      const activeOperation = await servicesA.operations.create(
        tenantA.runtimeDataSource,
        modelA.id,
        actorA,
        { name: 'Child remains active', price: '700.00', sort_order: 2 },
      );
      await servicesA.models.update(tenantA.runtimeDataSource, actorA, modelA.id, {
        status: 'INACTIVE',
        expected_version: '1',
      });
      await expect(servicesA.operations.create(
        tenantA.runtimeDataSource,
        modelA.id,
        actorA,
        { name: 'Forbidden new child', price: '1.00', sort_order: 3 },
      )).rejects.toMatchObject({ response: { code: 'MODEL_INACTIVE' } });
      await expect(servicesA.operations.update(
        tenantA.runtimeDataSource,
        actorA,
        inactiveOperation.id,
        { status: 'ACTIVE', expected_version: '1' },
      )).rejects.toMatchObject({ response: { code: 'MODEL_INACTIVE' } });
      await expect(servicesA.operations.getById(tenantA.runtimeDataSource, activeOperation.id))
        .resolves.toMatchObject({ status: 'ACTIVE' });
    });

    it('keeps audit rows append-only and rolls the feature migration down and up again', async () => {
      const tenant = tenants[0];
      if (!tenant) {
        throw new Error('Tenant fixture was not initialized');
      }
      const roleRows: Array<{ id: string }> = await tenant.runtimeDataSource.query(
        `INSERT INTO "roles" ("name") VALUES ($1) RETURNING "id"`,
        [`Audit test role ${randomUUID()}`],
      );
      const roleId = roleRows[0]?.id;
      if (!roleId) {
        throw new Error('Role insert did not return an ID');
      }
      const userRows: Array<{ id: string }> = await tenant.runtimeDataSource.query(
        `INSERT INTO "users" ("role_id", "email", "full_name", "password_hash")
         VALUES ($1, $2, 'Audit Test', 'test-hash') RETURNING "id"`,
        [roleId, `${randomUUID()}@example.test`],
      );
      const userId = userRows[0]?.id;
      if (!userId) {
        throw new Error('User insert did not return an ID');
      }
      const auditRows: Array<{ id: string }> = await tenant.runtimeDataSource.query(
        `INSERT INTO "audit_log"
          ("actor_user_id", "entity_type", "entity_id", "entity_key", "action", "before_json", "after_json")
         VALUES ($1, 'model', $2::uuid, $2::uuid::text, 'model.create', NULL, '{"name":"Audit"}'::jsonb)
         RETURNING "id"`,
        [userId, randomUUID()],
      );
      const auditId = auditRows[0]?.id;
      if (!auditId) {
        throw new Error('Audit insert did not return an ID');
      }
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `UPDATE "audit_log" SET "after_json" = '{}'::jsonb WHERE "id" = $1`,
          [auditId],
        ),
        'trg_audit_log_append_only',
      );
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(`DELETE FROM "audit_log" WHERE "id" = $1`, [auditId]),
        'trg_audit_log_append_only',
      );

      await tenant.migrationDataSource.undoLastMigration({ transaction: 'all' });
      await tenant.migrationDataSource.undoLastMigration({ transaction: 'all' });
      await tenant.migrationDataSource.undoLastMigration({ transaction: 'all' });
      const featureTables: Array<{ table_name: string }> = await tenant.migrationDataSource.query(
        `SELECT "table_name" FROM "information_schema"."tables"
         WHERE "table_schema" = 'public' AND "table_name" = ANY($1::varchar[])`,
        [['models', 'model_operations', 'model_operation_prices', 'audit_log']],
      );
      expect(featureTables).toHaveLength(0);
      const authTables: Array<{ table_name: string }> = await tenant.migrationDataSource.query(
        `SELECT "table_name" FROM "information_schema"."tables"
         WHERE "table_schema" = 'public' AND "table_name" = ANY($1::varchar[])`,
        [['auth_sessions', 'login_rate_limits']],
      );
      expect(authTables).toHaveLength(2);

      const applied = await tenant.migrationDataSource.runMigrations({ transaction: 'all' });
      expect(applied.map(({ name }) => name)).toEqual([
        MIGRATION_NAME,
        WORKERS_BADGES_MIGRATION_NAME,
        PATTA_MIGRATION_NAME,
      ]);
      await new PattaSequenceInitializer().initialize(tenant.migrationDataSource, 1n);
      const runtimeSecret = tenantDatabaseManager.createSecret(tenant.companyId);
      await tenantDatabaseManager.grantRuntimePrivileges(
        tenant.companyId,
        tenant.databaseName,
        runtimeSecret,
      );
    });
  },
);
