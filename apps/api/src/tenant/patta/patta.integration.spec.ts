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
import { TenantMigrationRunner } from '../../database/tenant/tenant-migration-runner.js';
import { PattaSequenceInitializer } from '../../database/tenant/patta-sequence.initializer.js';
import { TenantTestDatabaseCleanup } from '../../database/tenant/tenant-test-database-cleanup.js';
import { DeviceAccessService } from '../../master/devices/device-access.service.js';
import { AuditService } from '../audit/audit.service.js';
import { BadgeResolutionService } from '../badges/badge-resolution.service.js';
import { SyncChangeRecorder } from '../sync/sync-change-recorder.js';
import { ModelsService } from '../models/models.service.js';
import { OperationPriceService } from '../operations/operation-price.service.js';
import { OperationsService } from '../operations/operations.service.js';
import { loadPattaConfiguration } from './patta.config.js';
import type { PattaConfiguration } from './patta.config.js';
import { PattaNumberBlocksService } from './patta-number-blocks.service.js';
import { PattaPartiyaNumberBlocksService } from './patta-partiya-number-blocks.service.js';
import { PattaOfflineRegistrationValidator } from './patta-offline-registration.validator.js';
import { PattaPrintBatchesService } from './patta-print-batches.service.js';
import { PattaService } from './patta.service.js';
import { PattaTemplatesService } from './patta-templates.service.js';
import { PattaSheetsService } from '../patta-sheets/patta-sheets.service.js';

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
  throw new Error(`Patta integration configuration is incomplete: ${missing.join(', ')}`);
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
const TEST_PATTA_CONFIGURATION = loadPattaConfiguration({});
const PATTA_MIGRATION_NAME = 'AddPattaFoundation20260926000500';
const SYNC_MIGRATION_NAME = 'AddOfflineSyncInfrastructure20260926000600';
const QUANTITY_MIGRATION_NAME = 'CorrectPattaQuantitySemantics20260928000700';
const PRINT_BATCH_MIGRATION_NAME = 'AddPattaPrintBatches20260928000800';
const SYNC_V2_MIGRATION_NAME = 'AddSyncProtocolV2Sessions20260928000900';
const PRINT_CORRECTIONS_MIGRATION_NAME = 'AddPattaPrintBatchCorrections20260928001000';
const SHEET_MIGRATION_NAME = 'AddPattaSheets20260928001100';

interface TenantFixture {
  companyId: string;
  databaseName: string;
  credentials: TenantDatabaseCredentials;
  migrationDataSource: DataSource;
  runtimeDataSource: DataSource;
}

interface DriverError {
  constraint?: string;
}

interface DatabaseError extends Error {
  driverError?: DriverError;
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

integrationDescribe(
  configuredVariables.length === 0
    ? 'Patta PostgreSQL integration (BLOCKED: TEST_MASTER_DB_* is not configured)'
    : 'Patta PostgreSQL integration',
  () => {
    if (!masterOptions || !provisionerCredentials) {
      it.skip('requires a dedicated _test Master database and TEST_MASTER_DB_* credentials', () => {});
      return;
    }

    let masterDataSource: DataSource;
    let tenantDatabaseManager: TenantDatabaseManager;
    let migrationRunner: TenantMigrationRunner;
    let cleanup: TenantTestDatabaseCleanup;
    const tenants: TenantFixture[] = [];
    const companyIds: string[] = [];
    let deviceA: string;
    let deviceB: string;

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
      migrationRunner = new TenantMigrationRunner(
        new PattaSequenceInitializer(),
        TEST_PATTA_CONFIGURATION,
      );
      cleanup = new TenantTestDatabaseCleanup(
        process.env.TEST_MASTER_DB_NAME ?? '',
        provisionerCredentials,
      );
      const companyA = await createMasterCompany();
      const companyB = await createMasterCompany();
      deviceA = await createMasterDevice(companyA, 'ACTIVE');
      deviceB = await createMasterDevice(companyB, 'ACTIVE');
      await createTenant(companyA);
      await createTenant(companyB);
    }, 60_000);

    afterAll(async () => {
      await Promise.all(tenants.flatMap(({ migrationDataSource, runtimeDataSource }) => [
        migrationDataSource.isInitialized ? migrationDataSource.destroy() : Promise.resolve(),
        runtimeDataSource.isInitialized ? runtimeDataSource.destroy() : Promise.resolve(),
      ]));
      await tenantDatabaseManager?.close();
      await cleanup?.cleanup();
      if (masterDataSource?.isInitialized) {
        if (companyIds.length > 0) {
          await masterDataSource.query(
            'DELETE FROM "devices" WHERE "company_id" = ANY($1::uuid[])',
            [companyIds],
          );
          await masterDataSource.query(
            'DELETE FROM "companies" WHERE "id" = ANY($1::uuid[])',
            [companyIds],
          );
        }
        await masterDataSource.destroy();
      }
    }, 60_000);

    async function createMasterCompany(): Promise<string> {
      const companyId = randomUUID();
      companyIds.push(companyId);
      await masterDataSource.query(
        `INSERT INTO "companies" ("id", "name", "slug", "status", "db_name")
         VALUES ($1, $2, $3, 'ACTIVE', $4)`,
        [companyId, `Patta test ${companyId}`, `patta-${companyId}`, `tenant_test_${companyId.replaceAll('-', '')}`],
      );
      return companyId;
    }

    async function createMasterDevice(
      companyId: string,
      status: 'ACTIVE' | 'BLOCKED' | 'REPLACED',
    ): Promise<string> {
      const deviceId = randomUUID();
      const seenAt = new Date();
      await masterDataSource.query(
        `INSERT INTO "devices" (
           "id", "company_id", "installation_id", "hardware_fingerprint_hash",
           "device_name", "status", "first_seen_at", "last_seen_at"
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [deviceId, companyId, randomUUID(), `fingerprint-${deviceId}`, 'Patta test workstation', status, seenAt],
      );
      return deviceId;
    }

    async function createTenant(
      companyId: string,
      options: { useMigrationRunner?: boolean; sequenceStart?: bigint } = {},
    ): Promise<TenantFixture> {
      const databaseName = cleanup.trackCompany(companyId);
      const secret = tenantDatabaseManager.createSecret(companyId);
      await tenantDatabaseManager.ensureDatabase(companyId, databaseName, secret);
      const migrationCredentials = tenantDatabaseManager.migrationCredentials(databaseName);
      if (options.useMigrationRunner !== false) {
        await migrationRunner.run(migrationCredentials);
      } else {
        const migrationDataSource = new DataSource(
          createTenantMigrationDataSourceOptions(migrationCredentials),
        );
        await migrationDataSource.initialize();
        await migrationDataSource.runMigrations({ transaction: 'all' });
        if (options.sequenceStart !== undefined) {
          await new PattaSequenceInitializer().initialize(migrationDataSource, options.sequenceStart);
        }
        await migrationDataSource.destroy();
      }
      await tenantDatabaseManager.grantRuntimePrivileges(companyId, databaseName, secret);
      const credentials = tenantDatabaseManager.runtimeCredentials(companyId, databaseName, secret);
      const migrationDataSource = new DataSource(
        createTenantMigrationDataSourceOptions(migrationCredentials),
      );
      await migrationDataSource.initialize();
      const runtimeDataSource = new DataSource(createTenantRuntimeDataSourceOptions(credentials));
      await runtimeDataSource.initialize();
      const fixture = { companyId, databaseName, credentials, migrationDataSource, runtimeDataSource };
      tenants.push(fixture);
      return fixture;
    }

    async function createActor(dataSource: DataSource): Promise<string> {
      const roleRows: Array<{ id: string }> = await dataSource.query(
        `INSERT INTO "roles" ("name") VALUES ($1) RETURNING "id"`,
        [`Patta integration role ${randomUUID()}`],
      );
      const roleId = roleRows[0]?.id;
      if (!roleId) throw new Error('Patta integration actor role insert did not return an ID');
      const userRows: Array<{ id: string }> = await dataSource.query(
        `INSERT INTO "users" ("role_id", "email", "full_name", "password_hash")
         VALUES ($1, $2, 'Patta Integration Actor', 'test-hash') RETURNING "id"`,
        [roleId, `${randomUUID()}@example.test`],
      );
      const actorId = userRows[0]?.id;
      if (!actorId) throw new Error('Patta integration actor insert did not return an ID');
      return actorId;
    }

    async function grantTenantPermission(dataSource: DataSource, actorId: string, permissionCode: string): Promise<void> {
      const roleRows: Array<{ role_id: string }> = await dataSource.query(
        `SELECT "role_id"::text AS "role_id" FROM "users" WHERE "id" = $1`, [actorId],
      );
      const roleId = roleRows[0]?.role_id;
      if (!roleId) throw new Error('Patta integration actor role was not returned');
      await dataSource.query(
        `INSERT INTO "permissions" ("code", "description") VALUES ($1, $1)
         ON CONFLICT ("code") DO NOTHING`,
        [permissionCode],
      );
      await dataSource.query(
        `INSERT INTO "role_permissions" ("role_id", "permission_id")
         SELECT $1, permission."id" FROM "permissions" permission WHERE permission."code" = $2
         ON CONFLICT ("role_id", "permission_id") DO NOTHING`,
        [roleId, permissionCode],
      );
    }

    function featureServices(configuration: PattaConfiguration = TEST_PATTA_CONFIGURATION) {
      const audit = new AuditService();
      const syncChangeRecorder = new SyncChangeRecorder();
      const prices = new OperationPriceService(audit, syncChangeRecorder);
      const blocks = new PattaNumberBlocksService(audit, configuration, syncChangeRecorder);
      const partiyaBlocks = new PattaPartiyaNumberBlocksService(audit, configuration, syncChangeRecorder);
      const offlineValidator = new PattaOfflineRegistrationValidator(blocks);
      const sheets = new PattaSheetsService(audit, new BadgeResolutionService(), prices, syncChangeRecorder);
      return {
        audit,
        prices,
        models: new ModelsService(audit, syncChangeRecorder),
        operations: new OperationsService(audit, prices, syncChangeRecorder),
        templates: new PattaTemplatesService(audit, syncChangeRecorder),
        blocks,
        partiyaBlocks,
        sheets,
        printBatches: new PattaPrintBatchesService(
          audit, prices, configuration, syncChangeRecorder, blocks, partiyaBlocks, offlineValidator, sheets,
        ),
        offline: offlineValidator,
        pattas: new PattaService(
          audit,
          prices,
          syncChangeRecorder,
          offlineValidator,
        ),
      };
    }

    async function futureTimestamp(dataSource: DataSource, interval: string): Promise<string> {
      const rows: Array<{ value: string }> = await dataSource.query(
        `SELECT to_char(
           (transaction_timestamp() + $1::interval) AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) AS "value"`,
        [interval],
      );
      const value = rows[0]?.value;
      if (!value) throw new Error('PostgreSQL did not return the Patta test timestamp');
      return value;
    }

    it('applies additive schema, initializes default/custom starts once, grants runtime access, and safely down/up migrates', async () => {
      const tenant = tenants[0];
      if (!tenant) throw new Error('Tenant A fixture was not initialized');
      const migrations: Array<{ name: string }> = await tenant.migrationDataSource.query(
        'SELECT "name" FROM "tenant_typeorm_migrations" ORDER BY "timestamp"',
      );
      expect(migrations.map(({ name }) => name)).toContain(QUANTITY_MIGRATION_NAME);
      expect(migrations.map(({ name }) => name)).toContain(PATTA_MIGRATION_NAME);
      expect(migrations.map(({ name }) => name)).toContain(PRINT_CORRECTIONS_MIGRATION_NAME);
      const sequenceRows: Array<{ next_number: string }> = await tenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number" FROM "patta_number_sequence" WHERE "id" = 1`,
      );
      expect(sequenceRows).toEqual([{ next_number: '1' }]);
      const partiyaSequenceRows: Array<{ next_number: string }> = await tenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number" FROM "patta_partiya_number_sequence" WHERE "id" = 1`,
      );
      expect(partiyaSequenceRows).toEqual([{ next_number: '1' }]);
      await new PattaSequenceInitializer().initialize(tenant.migrationDataSource, 900n, 17n);
      const unchangedRows: Array<{ next_number: string }> = await tenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number" FROM "patta_number_sequence" WHERE "id" = 1`,
      );
      expect(unchangedRows).toEqual([{ next_number: '1' }]);
      const unchangedPartiyaRows: Array<{ next_number: string }> = await tenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number" FROM "patta_partiya_number_sequence" WHERE "id" = 1`,
      );
      expect(unchangedPartiyaRows).toEqual([{ next_number: '1' }]);

      const customCompany = await createMasterCompany();
      const customStart = 9_007_199_254_740_993n;
      const customTenant = await createTenant(customCompany, {
        useMigrationRunner: false,
        sequenceStart: customStart,
      });
      const customSequence: Array<{ next_number: string }> = await customTenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number" FROM "patta_number_sequence" WHERE "id" = 1`,
      );
      expect(customSequence).toEqual([{ next_number: customStart.toString() }]);
      await new PattaSequenceInitializer().initialize(customTenant.migrationDataSource, 42n);
      const customSequenceAfterConfigChange: Array<{ next_number: string }> =
        await customTenant.runtimeDataSource.query(
          `SELECT "next_number"::text AS "next_number" FROM "patta_number_sequence" WHERE "id" = 1`,
        );
      expect(customSequenceAfterConfigChange).toEqual([{ next_number: customStart.toString() }]);
      const customDevice = await createMasterDevice(customCompany, 'ACTIVE');
      const customActor = await createActor(customTenant.runtimeDataSource);
      const customBlock = await featureServices({
        ...TEST_PATTA_CONFIGURATION,
        blockSize: 2n,
      }).blocks.allocate(
        customTenant.runtimeDataSource,
        customActor,
        (await new DeviceAccessService(masterDataSource).assertActiveDevice(customCompany, customDevice)).id,
      );
      expect(customBlock).toMatchObject({
        range_start: customStart.toString(),
        range_end: (customStart + 1n).toString(),
      });
      const allocationChanges: Array<{ payload_json: { data: { range_start: string; range_end: string } } }> =
        await customTenant.runtimeDataSource.query(
          `SELECT "payload_json" FROM "server_change_log"
           WHERE "entity_type" = 'patta_number_blocks' AND "entity_id" = $1`,
          [customBlock.id],
        );
      expect(allocationChanges).toEqual([
        {
          payload_json: expect.objectContaining({
            data: expect.objectContaining({
              range_start: customStart.toString(),
              range_end: (customStart + 1n).toString(),
            }),
          }),
        },
      ]);

      const concurrentCompany = await createMasterCompany();
      const concurrentTenant = await createTenant(concurrentCompany, { useMigrationRunner: false });
      const initializer = new PattaSequenceInitializer();
      await Promise.all([
        initializer.initialize(concurrentTenant.migrationDataSource, 700n),
        initializer.initialize(concurrentTenant.migrationDataSource, 900n),
      ]);
      const concurrentSequence: Array<{ next_number: string; version: string }> =
        await concurrentTenant.runtimeDataSource.query(
          `SELECT "next_number"::text AS "next_number", "version"::text AS "version"
           FROM "patta_number_sequence" WHERE "id" = 1`,
        );
      expect(concurrentSequence).toHaveLength(1);
      expect(['700', '900']).toContain(concurrentSequence[0]?.next_number);
      expect(concurrentSequence[0]?.version).toBe('1');

      const upgradeCompany = await createMasterCompany();
      const upgradeTenant = await createTenant(upgradeCompany, { useMigrationRunner: false });
      const beforeUpgradeInitialization: Array<{ count: string }> = await upgradeTenant.runtimeDataSource.query(
        `SELECT count(*)::text AS "count" FROM "patta_number_sequence"`,
      );
      expect(beforeUpgradeInitialization[0]?.count).toBe('0');
      await migrationRunner.run(tenantDatabaseManager.migrationCredentials(upgradeTenant.databaseName));
      const afterUpgradeInitialization: Array<{ next_number: string }> =
        await upgradeTenant.runtimeDataSource.query(
          `SELECT "next_number"::text AS "next_number" FROM "patta_number_sequence" WHERE "id" = 1`,
        );
      expect(afterUpgradeInitialization).toEqual([{ next_number: '1' }]);

      const runtimeInsert: Array<{ id: string }> = await tenant.runtimeDataSource.query(
        `INSERT INTO "patta_templates" ("name", "model_id", "konveyer")
         SELECT $1, model."id", '1-konveyer' FROM "models" AS model
         WHERE false RETURNING "id"`,
        ['Runtime grant probe'],
      );
      expect(runtimeInsert).toHaveLength(0);

      const emptyCompany = await createMasterCompany();
      const emptyTenant = await createTenant(emptyCompany);
      let emptyTenantMigrations: Array<{ name: string }> = await emptyTenant.migrationDataSource.query(
        'SELECT "name" FROM "tenant_typeorm_migrations" ORDER BY "timestamp"',
      );
      while (emptyTenantMigrations.at(-1)?.name !== PATTA_MIGRATION_NAME) {
        if (!emptyTenantMigrations.at(-1)?.name) throw new Error('Patta foundation migration is missing');
        await emptyTenant.migrationDataSource.undoLastMigration({ transaction: 'all' });
        emptyTenantMigrations = await emptyTenant.migrationDataSource.query(
          'SELECT "name" FROM "tenant_typeorm_migrations" ORDER BY "timestamp"',
        );
      }
      const absentAfterDown: Array<{ table_name: string }> = await emptyTenant.migrationDataSource.query(
        `SELECT "table_name" FROM "information_schema"."tables"
         WHERE "table_schema" = 'public' AND "table_name" = ANY($1::text[])`,
        [['patta_partiya_number_sequence', 'patta_print_batches']],
      );
      expect(absentAfterDown).toHaveLength(0);
      const reapplied = await emptyTenant.migrationDataSource.runMigrations({ transaction: 'all' });
      expect(reapplied.map(({ name }) => name)).toEqual([
        SYNC_MIGRATION_NAME,
        QUANTITY_MIGRATION_NAME,
        PRINT_BATCH_MIGRATION_NAME,
        SYNC_V2_MIGRATION_NAME,
        PRINT_CORRECTIONS_MIGRATION_NAME,
        SHEET_MIGRATION_NAME,
      ]);
      await initializer.initialize(emptyTenant.migrationDataSource, 77n, 88n);
      await tenantDatabaseManager.grantRuntimePrivileges(
        emptyTenant.companyId,
        emptyTenant.databaseName,
        tenantDatabaseManager.createSecret(emptyTenant.companyId),
      );
      const reinitialized: Array<{ next_number: string }> = await emptyTenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number" FROM "patta_number_sequence" WHERE "id" = 1`,
      );
      expect(reinitialized).toEqual([{ next_number: '1' }]);
      const reinitializedPartiya: Array<{ next_number: string }> = await emptyTenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number" FROM "patta_partiya_number_sequence" WHERE "id" = 1`,
      );
      expect(reinitializedPartiya).toEqual([{ next_number: '88' }]);
    }, 60_000);

    it('moves legacy snapshot-count values out of actual ish_soni without data loss', async () => {
      const companyId = await createMasterCompany();
      const tenant = await createTenant(companyId);
      const actorId = await createActor(tenant.runtimeDataSource);
      const model = await featureServices().models.create(tenant.runtimeDataSource, actorId, {
        name: `Legacy quantity model ${randomUUID()}`,
      });
      const operations: Array<{ id: string; name: string }> = [];
      for (let index = 0; index < 13; index += 1) {
        operations.push(await featureServices().operations.create(
          tenant.runtimeDataSource,
          model.id,
          actorId,
          { name: `Legacy operation ${index}`, price: '10.00', sort_order: index },
        ));
      }

      let migrationRows: Array<{ name: string }> = await tenant.migrationDataSource.query(
        'SELECT "name" FROM "tenant_typeorm_migrations" ORDER BY "timestamp"',
      );
      while (migrationRows.at(-1)?.name !== SYNC_MIGRATION_NAME) {
        if (!migrationRows.at(-1)?.name) throw new Error('Offline sync migration is missing');
        await tenant.migrationDataSource.undoLastMigration({ transaction: 'all' });
        migrationRows = await tenant.migrationDataSource.query(
          'SELECT "name" FROM "tenant_typeorm_migrations" ORDER BY "timestamp"',
        );
      }

      const pattaId = randomUUID();
      const deviceId = await createMasterDevice(companyId, 'ACTIVE');
      await tenant.migrationDataSource.transaction(async (manager) => {
        for (const [index, operation] of operations.entries()) {
          await manager.query(
            `INSERT INTO "patta_operation_snapshots"
               ("id", "patta_hisob_id", "operation_id", "operation_name_snapshot", "unit_price_snapshot", "sort_order")
             VALUES ($1, $2, $3, $4, 10.00, $5)`,
            [randomUUID(), pattaId, operation.id, operation.name, index],
          );
        }
        await manager.query(
          `INSERT INTO "patta_hisob"
             ("id", "partiya_number", "patta_number", "model_id", "model_name_snapshot",
              "konveyer_snapshot", "rang", "razmer", "ish_soni", "created_device_id")
           VALUES ($1, 'LEGACY-QTY', 9125, $2, $3, '1-konveyer', 'Qora', 'S', 13, $4)`,
          [pattaId, model.id, model.name, deviceId],
        );
      });

      await migrationRunner.run(tenantDatabaseManager.migrationCredentials(tenant.databaseName));

      const migrated: Array<{ ish_soni: number | null; legacy_operation_count: number }> =
        await tenant.runtimeDataSource.query(
          `SELECT "ish_soni", "legacy_operation_count"
           FROM "patta_hisob" WHERE "id" = $1`,
          [pattaId],
        );
      const snapshotCount: Array<{ count: string }> = await tenant.runtimeDataSource.query(
        `SELECT count(*)::text AS "count" FROM "patta_operation_snapshots" WHERE "patta_hisob_id" = $1`,
        [pattaId],
      );
      expect(migrated).toEqual([{ ish_soni: null, legacy_operation_count: 13 }]);
      expect(snapshotCount).toEqual([{ count: '13' }]);

      migrationRows = await tenant.migrationDataSource.query(
        'SELECT "name" FROM "tenant_typeorm_migrations" ORDER BY "timestamp"',
      );
      while (migrationRows.at(-1)?.name !== QUANTITY_MIGRATION_NAME) {
        if (!migrationRows.at(-1)?.name) throw new Error('Quantity semantics migration is missing');
        await tenant.migrationDataSource.undoLastMigration({ transaction: 'all' });
        migrationRows = await tenant.migrationDataSource.query(
          'SELECT "name" FROM "tenant_typeorm_migrations" ORDER BY "timestamp"',
        );
      }
      await expect(tenant.migrationDataSource.undoLastMigration({ transaction: 'all' }))
        .rejects.toThrow(/cannot revert Patta quantity semantics while historical Pattas exist/);
    }, 60_000);

    it('creates multi-size batches with tenant-global numbering, immutable operation prices, and atomic rollback', async () => {
      const companyId = await createMasterCompany();
      const tenant = await createTenant(companyId);
      const actorId = await createActor(tenant.runtimeDataSource);
      const deviceId = await createMasterDevice(companyId, 'ACTIVE');
      const services = featureServices();
      const createModelWithOperations = async (name: string) => {
        const model = await services.models.create(tenant.runtimeDataSource, actorId, { name });
        await services.operations.create(tenant.runtimeDataSource, model.id, actorId, {
          name: 'Tikish', price: '100.00', sort_order: 0,
        });
        await services.operations.create(tenant.runtimeDataSource, model.id, actorId, {
          name: 'Qadoqlash', price: '25.00', sort_order: 1,
        });
        return model;
      };
      const inputFor = (modelId: string, size: string) => ({
        model_id: modelId,
        ish_soni: 125,
        rang: 'Qora',
        size_distribution: [{ razmer: size, patta_count: 1, sort_order: 0 }],
        device_id: deviceId,
      });
      const modelA = await createModelWithOperations(`Print batch A ${randomUUID()}`);
      const modelB = await createModelWithOperations(`Print batch B ${randomUUID()}`);

      const first = await services.printBatches.create(tenant.runtimeDataSource, actorId, deviceId, {
        model_id: modelA.id,
        ish_soni: 125,
        rang: 'Qora',
        size_distribution: [
          { razmer: 'XS', patta_count: 1, sort_order: 0 },
          { razmer: 'S', patta_count: 2, sort_order: 1 },
        ],
        device_id: deviceId,
      });
      const second = await services.printBatches.create(tenant.runtimeDataSource, actorId, deviceId, {
        model_id: modelB.id,
        ish_soni: 125,
        rang: 'Qora',
        size_distribution: [{ razmer: 'M', patta_count: 3, sort_order: 0 }],
        device_id: deviceId,
      });
      expect(first.partiya_number).toBe('1');
      expect(first.pattas.map(({ patta_number }) => patta_number)).toEqual(['1', '2', '3']);
      expect(second.partiya_number).toBe('2');
      expect(second.pattas.map(({ patta_number }) => patta_number)).toEqual(['4', '5', '6']);
      expect(first.pattas.every(({ ish_soni, operations }) => ish_soni === 125 && operations.length === 2)).toBe(true);

      const initialPrintEventId = randomUUID();
      const successfulPrint = await services.printBatches.recordPrintEvent(
        tenant.runtimeDataSource,
        actorId,
        deviceId,
        first.id,
        {
          event_id: initialPrintEventId,
          revision: 1,
          kind: 'INITIAL',
          outcome: 'SUCCEEDED',
          device_id: deviceId,
        },
      );
      expect(successfulPrint.printed_at).not.toBeNull();
      await expect(services.printBatches.recordPrintEvent(
        tenant.runtimeDataSource,
        actorId,
        deviceId,
        first.id,
        {
          event_id: initialPrintEventId,
          revision: 1,
          kind: 'INITIAL',
          outcome: 'SUCCEEDED',
          device_id: deviceId,
        },
      )).resolves.toEqual(successfulPrint);
      await services.printBatches.recordPrintEvent(
        tenant.runtimeDataSource,
        actorId,
        deviceId,
        first.id,
        {
          event_id: randomUUID(),
          revision: 1,
          kind: 'REPRINT',
          outcome: 'FAILED',
          device_id: deviceId,
        },
      );
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `UPDATE "patta_print_events" SET "outcome" = 'FAILED' WHERE "id" = $1`,
          [initialPrintEventId],
        ),
        'trg_patta_print_events_append_only',
      );
      const firstBatchNumbers: Array<{ partiya_number: string; patta_number: string }> = await tenant.runtimeDataSource.query(
        `SELECT "partiya_number", "patta_number"::text AS "patta_number"
         FROM "patta_hisob" WHERE "print_batch_id" = $1 ORDER BY "patta_number"`,
        [first.id],
      );
      expect(firstBatchNumbers).toEqual([
        { partiya_number: '1', patta_number: '1' },
        { partiya_number: '1', patta_number: '2' },
        { partiya_number: '1', patta_number: '3' },
      ]);

      const pattaValues: Array<{ partiya_number: string; patta_number: string; ish_soni: number; status: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT "partiya_number", "patta_number"::text AS "patta_number", "ish_soni", "status"
           FROM "patta_hisob" WHERE "print_batch_id" = ANY($1::uuid[]) ORDER BY "patta_number"`,
          [[first.id, second.id]],
        );
      expect(pattaValues).toEqual([
        { partiya_number: '1', patta_number: '1', ish_soni: 125, status: 'ACTIVE' },
        { partiya_number: '1', patta_number: '2', ish_soni: 125, status: 'ACTIVE' },
        { partiya_number: '1', patta_number: '3', ish_soni: 125, status: 'ACTIVE' },
        { partiya_number: '2', patta_number: '4', ish_soni: 125, status: 'ACTIVE' },
        { partiya_number: '2', patta_number: '5', ish_soni: 125, status: 'ACTIVE' },
        { partiya_number: '2', patta_number: '6', ish_soni: 125, status: 'ACTIVE' },
      ]);
      const operationCounts: Array<{ total: string }> = await tenant.runtimeDataSource.query(
        `SELECT count(*)::text AS "total" FROM "patta_operation_snapshots"
         WHERE "patta_hisob_id" = ANY($1::uuid[])`,
        [[...first.pattas.map(({ id }) => id), ...second.pattas.map(({ id }) => id)]],
      );
      expect(operationCounts).toEqual([{ total: '12' }]);

      const concurrent = await Promise.all([
        services.printBatches.create(tenant.runtimeDataSource, actorId, deviceId, inputFor(modelA.id, 'L')),
        services.printBatches.create(tenant.runtimeDataSource, actorId, deviceId, inputFor(modelB.id, 'XL')),
      ]);
      expect(concurrent.map(({ partiya_number }) => partiya_number).sort()).toEqual(['3', '4']);
      expect(concurrent.flatMap(({ pattas }) => pattas.map(({ patta_number }) => patta_number)).sort())
        .toEqual(['7', '8']);

      const beforeFailure: Array<{ partiya_number: string; patta_number: string }> = await tenant.runtimeDataSource.query(
        `SELECT (SELECT "next_number"::text FROM "patta_partiya_number_sequence" WHERE "id" = 1) AS "partiya_number",
                (SELECT "next_number"::text FROM "patta_number_sequence" WHERE "id" = 1) AS "patta_number"`,
      );
      const failingService = new PattaPrintBatchesService(
        { append: async () => { throw new Error('Injected audit failure'); } } as unknown as AuditService,
        services.prices,
        TEST_PATTA_CONFIGURATION,
        new SyncChangeRecorder(),
        services.blocks,
        services.partiyaBlocks,
        services.offline,
      );
      await expect(failingService.create(
        tenant.runtimeDataSource, actorId, deviceId, inputFor(modelA.id, 'XXL'),
      )).rejects.toThrow('Injected audit failure');
      const afterFailure: Array<{ partiya_number: string; patta_number: string }> = await tenant.runtimeDataSource.query(
        `SELECT (SELECT "next_number"::text FROM "patta_partiya_number_sequence" WHERE "id" = 1) AS "partiya_number",
                (SELECT "next_number"::text FROM "patta_number_sequence" WHERE "id" = 1) AS "patta_number"`,
      );
      expect(afterFailure).toEqual(beforeFailure);
    }, 60_000);

    it('enforces Partiya block ownership, monotonic usage, non-overlap and singleton sequence constraints', async () => {
      const companyId = await createMasterCompany();
      const tenant = await createTenant(companyId);
      const actorId = await createActor(tenant.runtimeDataSource);
      const deviceId = await createMasterDevice(companyId, 'ACTIVE');
      const secondDeviceId = await createMasterDevice(companyId, 'ACTIVE');
      const services = featureServices({ ...TEST_PATTA_CONFIGURATION, blockSize: 2n });
      const allocations = await Promise.all([
        services.partiyaBlocks.allocate(tenant.runtimeDataSource, actorId, deviceId),
        services.partiyaBlocks.allocate(tenant.runtimeDataSource, actorId, secondDeviceId),
      ]);
      const [block, secondBlock] = allocations;
      if (!block || !secondBlock) throw new Error('Concurrent Partiya block allocations returned no rows');
      expect(allocations.map(({ range_start, range_end }) => [range_start, range_end]).sort()).toEqual([
        ['1', '2'],
        ['3', '4'],
      ]);
      expect(block.status).toBe('ACTIVE');

      await expect(services.partiyaBlocks.reportUsage(tenant.runtimeDataSource, deviceId, block.id, 1n))
        .resolves.toMatchObject({ reported_used_count: '1', status: 'ACTIVE' });
      await expect(services.partiyaBlocks.reportUsage(tenant.runtimeDataSource, deviceId, block.id, 0n))
        .rejects.toMatchObject({ response: { code: 'PARTIYA_BLOCK_USAGE_INVALID' } });
      await expect(services.partiyaBlocks.reportUsage(tenant.runtimeDataSource, deviceB, block.id, 1n))
        .rejects.toMatchObject({ response: { code: 'PARTIYA_NUMBER_BLOCK_DEVICE_MISMATCH' } });

      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `INSERT INTO "patta_partiya_number_blocks" ("device_id", "range_start", "range_end", "created_by")
           VALUES ($1, 2, 3, $2)`,
          [deviceId, actorId],
        ),
        'ex_patta_partiya_number_blocks_no_overlap',
      );
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `INSERT INTO "patta_partiya_number_sequence" ("id", "next_number") VALUES (2, 10)`,
        ),
        'ck_patta_partiya_number_sequence_singleton',
      );

      const beforeRollback: Array<{ next_number: string; version: string }> = await tenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number", "version"::text AS "version"
         FROM "patta_partiya_number_sequence" WHERE "id" = 1`,
      );
      const rollbackDevice = await createMasterDevice(companyId, 'ACTIVE');
      const failingBlockService = new PattaPartiyaNumberBlocksService(
        { append: async () => { throw new Error('Injected Partiya audit failure'); } } as unknown as AuditService,
        { ...TEST_PATTA_CONFIGURATION, blockSize: 2n },
        new SyncChangeRecorder(),
      );
      await expect(failingBlockService.allocate(tenant.runtimeDataSource, actorId, rollbackDevice))
        .rejects.toThrow('Injected Partiya audit failure');
      const afterRollback: Array<{ next_number: string; version: string }> = await tenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number", "version"::text AS "version"
         FROM "patta_partiya_number_sequence" WHERE "id" = 1`,
      );
      expect(afterRollback).toEqual(beforeRollback);
      const afterRollbackBlockCount: Array<{ count: string }> = await tenant.runtimeDataSource.query(
        `SELECT count(*)::text AS "count" FROM "patta_partiya_number_blocks" WHERE "device_id" = $1`,
        [rollbackDevice],
      );
      expect(afterRollbackBlockCount).toEqual([{ count: '0' }]);
      const afterRollbackBlock = await services.partiyaBlocks.allocate(
        tenant.runtimeDataSource, actorId, rollbackDevice,
      );
      expect(afterRollbackBlock.range_start).toBe('5');

      await expect(services.partiyaBlocks.reportUsage(tenant.runtimeDataSource, deviceId, block.id, 2n))
        .resolves.toMatchObject({ reported_used_count: '2', status: 'EXHAUSTED' });
      await expect(services.partiyaBlocks.reportUsage(tenant.runtimeDataSource, deviceId, block.id, 3n))
        .rejects.toMatchObject({ response: { code: 'PARTIYA_NUMBER_BLOCK_TERMINAL' } });
      const afterExhaustion = await services.partiyaBlocks.allocate(
        tenant.runtimeDataSource, actorId, deviceId,
      );
      expect(BigInt(afterExhaustion.range_start)).toBeGreaterThan(BigInt(block.range_end));
    }, 60_000);

    it('preserves old operation-count values as legacy metadata and leaves actual Patta quantity unknown', async () => {
      const companyId = await createMasterCompany();
      const tenant = await createTenant(companyId);
      const actorId = await createActor(tenant.runtimeDataSource);
      const services = featureServices();
      const model = await services.models.create(tenant.runtimeDataSource, actorId, {
        name: `Legacy quantity model ${randomUUID()}`,
      });
      const operations: Array<{ id: string; name: string }> = [];
      for (let index = 0; index < 13; index += 1) {
        const operation = await services.operations.create(
          tenant.runtimeDataSource,
          model.id,
          actorId,
          { name: `Legacy operation ${index}`, price: '10.00', sort_order: index },
        );
        operations.push({ id: operation.id, name: operation.name });
      }

      let migrationRows: Array<{ name: string }> = await tenant.migrationDataSource.query(
        'SELECT "name" FROM "tenant_typeorm_migrations" ORDER BY "timestamp"',
      );
      while (migrationRows.at(-1)?.name !== SYNC_MIGRATION_NAME) {
        if (!migrationRows.at(-1)?.name) throw new Error('Offline sync migration is missing');
        await tenant.migrationDataSource.undoLastMigration({ transaction: 'all' });
        migrationRows = await tenant.migrationDataSource.query(
          'SELECT "name" FROM "tenant_typeorm_migrations" ORDER BY "timestamp"',
        );
      }
      const quantityMigrationRow = migrationRows.find(({ name }) => name === QUANTITY_MIGRATION_NAME);
      expect(quantityMigrationRow).toBeUndefined();

      const pattaId = randomUUID();
      const deviceId = await createMasterDevice(companyId, 'ACTIVE');
      await tenant.migrationDataSource.transaction(async (manager) => {
        for (const [index, operation] of operations.entries()) {
          await manager.query(
            `INSERT INTO "patta_operation_snapshots"
               ("id", "patta_hisob_id", "operation_id", "operation_name_snapshot", "unit_price_snapshot", "sort_order")
             VALUES ($1, $2, $3, $4, 10.00, $5)`,
            [randomUUID(), pattaId, operation.id, operation.name, index],
          );
        }
        await manager.query(
          `INSERT INTO "patta_hisob"
             ("id", "partiya_number", "patta_number", "model_id", "model_name_snapshot",
              "konveyer_snapshot", "rang", "razmer", "ish_soni", "created_device_id")
           VALUES ($1, 'LEGACY-QTY', 9125, $2, $3, '1-konveyer', 'Qora', 'S', 13, $4)`,
          [pattaId, model.id, model.name, deviceId],
        );
      });

      await migrationRunner.run(tenantDatabaseManager.migrationCredentials(tenant.databaseName));
      const migrated: Array<{ ish_soni: number | null; legacy_operation_count: number }> =
        await tenant.runtimeDataSource.query(
          `SELECT "ish_soni", "legacy_operation_count" FROM "patta_hisob" WHERE "id" = $1`,
          [pattaId],
        );
      const snapshotCount: Array<{ count: string }> = await tenant.runtimeDataSource.query(
        `SELECT count(*)::text AS "count" FROM "patta_operation_snapshots" WHERE "patta_hisob_id" = $1`,
        [pattaId],
      );
      expect(migrated).toEqual([{ ish_soni: null, legacy_operation_count: 13 }]);
      expect(snapshotCount).toEqual([{ count: '13' }]);
    }, 60_000);

    it('validates Master device ownership/status and atomically allocates non-overlapping BIGINT ranges', async () => {
      const tenant = tenants[0];
      if (!tenant) throw new Error('Tenant A fixture was not initialized');
      const activeA = await new DeviceAccessService(masterDataSource).assertActiveDevice(tenant.companyId, deviceA);
      expect(activeA.id).toBe(deviceA);
      await expect(new DeviceAccessService(masterDataSource).assertActiveDevice(tenant.companyId, deviceB))
        .rejects.toMatchObject({ response: { code: 'DEVICE_TENANT_MISMATCH' } });
      await expect(new DeviceAccessService(masterDataSource).assertActiveDevice(tenant.companyId, randomUUID()))
        .rejects.toMatchObject({ response: { code: 'DEVICE_NOT_FOUND' } });
      const blockedDevice = await createMasterDevice(tenant.companyId, 'BLOCKED');
      const replacedDevice = await createMasterDevice(tenant.companyId, 'REPLACED');
      const deviceAccess = new DeviceAccessService(masterDataSource);
      await expect(deviceAccess.assertActiveDevice(tenant.companyId, blockedDevice))
        .rejects.toMatchObject({ response: { code: 'DEVICE_NOT_ACTIVE' } });
      await expect(deviceAccess.assertActiveDevice(tenant.companyId, replacedDevice))
        .rejects.toMatchObject({ response: { code: 'DEVICE_NOT_ACTIVE' } });

      const actorId = await createActor(tenant.runtimeDataSource);
      const configuration: PattaConfiguration = {
        ...TEST_PATTA_CONFIGURATION,
        blockSize: 5n,
        maxActiveBlocksPerDevice: 2,
      };
      const blocks = featureServices(configuration).blocks;
      const validSecondDevice = await createMasterDevice(tenant.companyId, 'ACTIVE');
      const devices = [deviceA, validSecondDevice];
      const allocations = await Promise.all(devices.map(async (deviceId) => {
        const validated = await deviceAccess.assertActiveDevice(tenant.companyId, deviceId);
        return blocks.allocate(tenant.runtimeDataSource, actorId, validated.id);
      }));
      expect(allocations.map(({ range_start, range_end }) => [range_start, range_end]).sort()).toEqual([
        ['1', '5'],
        ['6', '10'],
      ]);

      const rollbackDevice = await createMasterDevice(tenant.companyId, 'ACTIVE');
      const beforeFailedBlockAllocation: Array<{ next_number: string; version: string }> = await tenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number", "version"::text AS "version"
         FROM "patta_number_sequence" WHERE "id" = 1`,
      );
      const failingBlockService = new PattaNumberBlocksService(
        { append: async () => { throw new Error('Injected Patta block audit failure'); } } as unknown as AuditService,
        configuration,
        new SyncChangeRecorder(),
      );
      await expect(failingBlockService.allocate(tenant.runtimeDataSource, actorId, rollbackDevice))
        .rejects.toThrow('Injected Patta block audit failure');
      const afterFailedBlockAllocation: Array<{ next_number: string; version: string }> = await tenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number", "version"::text AS "version"
         FROM "patta_number_sequence" WHERE "id" = 1`,
      );
      expect(afterFailedBlockAllocation).toEqual(beforeFailedBlockAllocation);
      const recoveredBlock = await blocks.allocate(tenant.runtimeDataSource, actorId, rollbackDevice);
      expect(recoveredBlock.range_start).toBe('11');

      const moreDevices = await Promise.all(Array.from({ length: 8 }, () =>
        createMasterDevice(tenant.companyId, 'ACTIVE')));
      const concurrent = await Promise.all(moreDevices.map(async (deviceId) => {
        const validated = await deviceAccess.assertActiveDevice(tenant.companyId, deviceId);
        return blocks.allocate(tenant.runtimeDataSource, actorId, validated.id);
      }));
      const allRanges = [...allocations, ...concurrent]
        .map(({ range_start, range_end }) => ({ start: BigInt(range_start), end: BigInt(range_end) }))
        .sort((left, right) => left.start < right.start ? -1 : left.start > right.start ? 1 : 0);
      for (let index = 1; index < allRanges.length; index += 1) {
        const previous = allRanges[index - 1];
        const current = allRanges[index];
        if (!previous || !current) throw new Error('Concurrent block range result was incomplete');
        expect(current.start).toBeGreaterThan(previous.end);
      }

      const cappedDevice = await createMasterDevice(tenant.companyId, 'ACTIVE');
      await blocks.allocate(tenant.runtimeDataSource, actorId, cappedDevice);
      await blocks.allocate(tenant.runtimeDataSource, actorId, cappedDevice);
      await expect(blocks.allocate(tenant.runtimeDataSource, actorId, cappedDevice))
        .rejects.toMatchObject({ response: { code: 'PATTA_MAX_ACTIVE_BLOCKS_REACHED' } });

      const overlappingRange = allocations[0];
      if (!overlappingRange) throw new Error('Expected allocated range');
      await expectConstraintViolation(
        tenant.migrationDataSource.query(
          `INSERT INTO "patta_number_blocks"
             ("device_id", "range_start", "range_end", "status")
           VALUES ($1, $2::bigint, $3::bigint, 'CANCELLED')`,
          [deviceA, overlappingRange.range_start, overlappingRange.range_end],
        ),
        'ex_patta_number_blocks_no_overlap',
      );

      const usageDevice = await createMasterDevice(tenant.companyId, 'ACTIVE');
      const usageBlock = await blocks.allocate(
        tenant.runtimeDataSource,
        actorId,
        (await deviceAccess.assertActiveDevice(tenant.companyId, usageDevice)).id,
      );
      await expect(blocks.reportUsage(
        tenant.runtimeDataSource,
        actorId,
        deviceB,
        usageBlock.id,
        1n,
      )).rejects.toMatchObject({ response: { code: 'PATTA_NUMBER_BLOCK_DEVICE_MISMATCH' } });
      await expect(blocks.reportUsage(
        tenant.runtimeDataSource,
        actorId,
        usageDevice,
        usageBlock.id,
        4n,
      )).resolves.toMatchObject({ reported_used_count: '4', status: 'ACTIVE' });
      await expect(blocks.reportUsage(
        tenant.runtimeDataSource,
        actorId,
        usageDevice,
        usageBlock.id,
        3n,
      )).rejects.toMatchObject({ response: { code: 'PATTA_BLOCK_USAGE_DECREASED' } });
      await expect(blocks.reportUsage(
        tenant.runtimeDataSource,
        actorId,
        usageDevice,
        usageBlock.id,
        6n,
      )).rejects.toMatchObject({ response: { code: 'PATTA_BLOCK_USAGE_EXCEEDS_CAPACITY' } });
      await expect(blocks.reportUsage(
        tenant.runtimeDataSource,
        actorId,
        usageDevice,
        usageBlock.id,
        5n,
      )).resolves.toMatchObject({ reported_used_count: '5', status: 'EXHAUSTED' });
      const usageChanges: Array<{
        data: { reported_used_count: string; status: string };
      }> = await tenant.runtimeDataSource.query(
        `SELECT "payload_json" -> 'data' AS "data" FROM "server_change_log"
         WHERE "entity_type" = 'patta_number_blocks' AND "entity_id" = $1
         ORDER BY "sequence_id"`,
        [usageBlock.id],
      );
      expect(usageChanges.map(({ data }) => [data.reported_used_count, data.status])).toEqual([
        ['0', 'ACTIVE'],
        ['4', 'ACTIVE'],
        ['5', 'EXHAUSTED'],
      ]);
      await expect(blocks.cancel(tenant.runtimeDataSource, actorId, usageDevice, usageBlock.id))
        .rejects.toMatchObject({ response: { code: 'PATTA_NUMBER_BLOCK_TERMINAL' } });
      await blocks.assertAllocatedNumber(
        tenant.runtimeDataSource,
        usageDevice,
        usageBlock.id,
        BigInt(usageBlock.range_start),
      );

      const cancelDevice = await createMasterDevice(tenant.companyId, 'ACTIVE');
      const cancelBlock = await blocks.allocate(
        tenant.runtimeDataSource,
        actorId,
        (await deviceAccess.assertActiveDevice(tenant.companyId, cancelDevice)).id,
      );
      const cancelled = await blocks.cancel(tenant.runtimeDataSource, actorId, cancelDevice, cancelBlock.id);
      expect(cancelled.status).toBe('CANCELLED');
      const cancellationChanges: Array<{
        data: { reported_used_count: string; status: string };
      }> = await tenant.runtimeDataSource.query(
        `SELECT "payload_json" -> 'data' AS "data" FROM "server_change_log"
         WHERE "entity_type" = 'patta_number_blocks' AND "entity_id" = $1
         ORDER BY "sequence_id"`,
        [cancelBlock.id],
      );
      expect(cancellationChanges.map(({ data }) => [data.reported_used_count, data.status])).toEqual([
        ['0', 'ACTIVE'],
        ['0', 'CANCELLED'],
      ]);
      await expect(blocks.reportUsage(
        tenant.runtimeDataSource,
        actorId,
        cancelDevice,
        cancelBlock.id,
        1n,
      )).rejects.toMatchObject({ response: { code: 'PATTA_NUMBER_BLOCK_TERMINAL' } });
      await blocks.assertAllocatedNumber(
        tenant.runtimeDataSource,
        cancelDevice,
        cancelBlock.id,
        BigInt(cancelBlock.range_start),
      );
      const afterCancel = await blocks.allocate(tenant.runtimeDataSource, actorId, cancelDevice);
      expect(BigInt(afterCancel.range_start)).toBeGreaterThan(BigInt(cancelBlock.range_end));
    }, 60_000);

    it('persists v2 batches with 13 operation snapshots and product quantity 125, and blocks v1 Patta APIs', async () => {
      const tenant = tenants[0];
      if (!tenant) throw new Error('Tenant A fixture was not initialized');
      const actorId = await createActor(tenant.runtimeDataSource);
      const feature = featureServices();
      const device = await new DeviceAccessService(masterDataSource).assertActiveDevice(tenant.companyId, deviceA);
      const model = await feature.models.create(tenant.runtimeDataSource, actorId, {
        name: `Quantity 125 model ${randomUUID()}`,
      });
      for (let index = 0; index < 13; index += 1) {
        await feature.operations.create(tenant.runtimeDataSource, model.id, actorId, {
          name: `Operation ${index}`,
          price: `${index + 1}.00`,
          sort_order: index,
        });
      }
      const batch = await feature.printBatches.create(tenant.runtimeDataSource, actorId, device.id, {
        model_id: model.id,
        ish_soni: 125,
        rang: 'Qora',
        device_id: device.id,
        size_distribution: [
          { razmer: 'XS', patta_count: 1, sort_order: 0 },
          { razmer: 'S', patta_count: 1, sort_order: 1 },
        ],
      });
      expect(batch.size_distribution.map(({ razmer }) => razmer)).toEqual(['XS', 'S']);
      expect(batch.pattas).toHaveLength(2);
      expect(batch.pattas.every((patta) => patta.ish_soni === 125 && patta.operations.length === 13)).toBe(true);

      const persistedCount: Array<{ ish_soni: number; operation_count: string }> = await tenant.runtimeDataSource.query(
        `SELECT patta."ish_soni",
                (SELECT count(*)::text FROM "patta_operation_snapshots" snapshot
                 WHERE snapshot."patta_hisob_id" = patta."id") AS "operation_count"
         FROM "patta_hisob" patta WHERE patta."print_batch_id" = $1 ORDER BY patta."patta_number"`,
        [batch.id],
      );
      expect(persistedCount).toEqual([
        { ish_soni: 125, operation_count: '13' },
        { ish_soni: 125, operation_count: '13' },
      ]);
      const lookup = await feature.printBatches.lookup(tenant.runtimeDataSource, {
        partiya_number: batch.partiya_number,
        patta_number: batch.pattas[0]?.patta_number ?? '1',
      });
      expect(lookup).toMatchObject({ ish_soni: 125, legacy_operation_count: null, operation_count: 13 });

      await expect(feature.pattas.generate(tenant.runtimeDataSource, actorId, device.id, {
        partiya_number: 'OLD-CLIENT',
        model_id: model.id,
        count: 1,
      })).rejects.toMatchObject({ response: { code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED' } });
      await expect(feature.pattas.lookup(tenant.runtimeDataSource, batch.partiya_number, batch.pattas[0]?.patta_number ?? '1'))
        .rejects.toMatchObject({ response: { code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED' } });
      await expect(feature.pattas.list(tenant.runtimeDataSource, { page: 1, limit: 25 }))
        .rejects.toMatchObject({ response: { code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED' } });
    }, 30_000);

    it('corrects batches with deterministic Patta retention, VOID history, append-only audit and no number reuse', async () => {
      const tenant = tenants[0];
      if (!tenant) throw new Error('Tenant A fixture was not initialized');
      const actorId = await createActor(tenant.runtimeDataSource);
      await grantTenantPermission(tenant.runtimeDataSource, actorId, 'patta.chiqarish.correct');
      const feature = featureServices();
      const device = await new DeviceAccessService(masterDataSource).assertActiveDevice(tenant.companyId, deviceA);
      const model = await feature.models.create(tenant.runtimeDataSource, actorId, {
        name: `Correction model ${randomUUID()}`,
      });
      await feature.operations.create(tenant.runtimeDataSource, model.id, actorId, {
        name: 'Tikish', price: '25.00', sort_order: 0,
      });
      const original = await feature.printBatches.create(tenant.runtimeDataSource, actorId, device.id, {
        model_id: model.id,
        ish_soni: 125,
        rang: 'Qora',
        device_id: device.id,
        size_distribution: [
          { razmer: 'S', patta_count: 1, sort_order: 0 },
          { razmer: 'M', patta_count: 1, sort_order: 1 },
        ],
      });
      const sequenceAfterInitialBatch: Array<{ next_number: string }> = await tenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number" FROM "patta_number_sequence" WHERE "id" = 1`,
      );
      const firstCorrectionNumber = sequenceAfterInitialBatch[0]?.next_number;
      if (!firstCorrectionNumber) throw new Error('Patta sequence did not return the next correction number');
      const sizeUp = await feature.printBatches.correctBatch(tenant.runtimeDataSource, actorId, device.id, original.id, {
        expected_version: '1', correction_reason: 'Yana bir M razmer kerak', ish_soni: 125,
        rang: 'Qora', device_id: device.id,
        size_distribution: [
          { razmer: 'S', patta_count: 1, sort_order: 0 },
          { razmer: 'M', patta_count: 2, sort_order: 1 },
        ],
      });
      expect(sizeUp.pattas.map(({ id, patta_number, razmer, status }) => [id, patta_number, razmer, status])).toEqual([
        [original.pattas[0]?.id, original.pattas[0]?.patta_number, 'S', 'ACTIVE'],
        [original.pattas[1]?.id, original.pattas[1]?.patta_number, 'M', 'ACTIVE'],
        [sizeUp.pattas[2]?.id, firstCorrectionNumber, 'M', 'ACTIVE'],
      ]);
      expect(sizeUp.pattas[0]?.id).toBe(original.pattas[0]?.id);

      const sizeDown = await feature.printBatches.correctBatch(tenant.runtimeDataSource, actorId, device.id, original.id, {
        expected_version: '2', correction_reason: 'Ortiqcha M olib tashlandi', ish_soni: 125,
        rang: 'Qora', device_id: device.id,
        size_distribution: [
          { razmer: 'S', patta_count: 1, sort_order: 0 },
          { razmer: 'M', patta_count: 1, sort_order: 1 },
        ],
      });
      expect(sizeDown.pattas.find(({ patta_number }) => patta_number === firstCorrectionNumber)?.status).toBe('VOID');

      const sizeRestored = await feature.printBatches.correctBatch(tenant.runtimeDataSource, actorId, device.id, original.id, {
        expected_version: '3', correction_reason: 'M taqsimoti qayta tasdiqlandi', ish_soni: 125,
        rang: 'Qora', device_id: device.id,
        size_distribution: [
          { razmer: 'S', patta_count: 1, sort_order: 0 },
          { razmer: 'M', patta_count: 2, sort_order: 1 },
        ],
      });
      expect(sizeRestored.pattas.map(({ patta_number, status }) => [patta_number, status])).toEqual([
        [original.pattas[0]?.patta_number, 'ACTIVE'],
        [original.pattas[1]?.patta_number, 'ACTIVE'],
        [firstCorrectionNumber, 'VOID'],
        [(BigInt(firstCorrectionNumber) + 1n).toString(), 'ACTIVE'],
      ]);
      expect(sizeRestored).toMatchObject({ version: '4', revision: 4 });
      const sequence: Array<{ next_number: string }> = await tenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number" FROM "patta_number_sequence" WHERE "id" = 1`,
      );
      expect(sequence).toEqual([{ next_number: (BigInt(firstCorrectionNumber) + 2n).toString() }]);
      const correctionLedger: Array<{ reason: string; from_revision: number; to_revision: number }> =
        await tenant.runtimeDataSource.query(
          `SELECT "reason", "from_revision", "to_revision" FROM "patta_print_batch_corrections"
           WHERE "batch_id" = $1 ORDER BY "to_revision"`,
          [original.id],
        );
      expect(correctionLedger.map(({ reason, from_revision, to_revision }) => [reason, from_revision, to_revision])).toEqual([
        ['Yana bir M razmer kerak', 1, 2],
        ['Ortiqcha M olib tashlandi', 2, 3],
        ['M taqsimoti qayta tasdiqlandi', 3, 4],
      ]);
      const latestBatchChange: Array<{ projection: { pattas: Array<{ version: string }> } }> =
        await tenant.runtimeDataSource.query(
          `SELECT "payload_json" -> 'data' AS "projection" FROM "server_change_log"
           WHERE "entity_type" = 'patta_print_batches' AND "entity_id" = $1
           ORDER BY "sequence_id" DESC LIMIT 1`,
          [original.id],
        );
      expect(latestBatchChange[0]?.projection.pattas.map(({ version }) => version)).toEqual(['4', '4', '2', '1']);

      const failingAudit = { append: async () => { throw new Error('injected correction audit failure'); } };
      const failingCorrectionService = new PattaPrintBatchesService(
        failingAudit as unknown as AuditService,
        feature.prices,
        TEST_PATTA_CONFIGURATION,
        new SyncChangeRecorder(),
        feature.blocks,
        feature.partiyaBlocks,
        feature.offline,
      );
      await expect(failingCorrectionService.correctBatch(tenant.runtimeDataSource, actorId, device.id, original.id, {
        expected_version: '4', correction_reason: 'Rollback sinovi', ish_soni: 125,
        rang: 'Qora', device_id: device.id,
        size_distribution: [
          { razmer: 'S', patta_count: 1, sort_order: 0 },
          { razmer: 'M', patta_count: 2, sort_order: 1 },
        ],
      })).rejects.toThrow('injected correction audit failure');
      const postRollbackBatch: Array<{ version: string; revision: number }> = await tenant.runtimeDataSource.query(
        `SELECT "version"::text AS "version", "revision" FROM "patta_print_batches" WHERE "id" = $1`,
        [original.id],
      );
      const postRollbackSequence: Array<{ next_number: string }> = await tenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number" FROM "patta_number_sequence" WHERE "id" = 1`,
      );
      expect(postRollbackBatch).toEqual([{ version: '4', revision: 4 }]);
      expect(postRollbackSequence).toEqual([{ next_number: (BigInt(firstCorrectionNumber) + 2n).toString() }]);
      const correctionCount: Array<{ count: string }> = await tenant.runtimeDataSource.query(
        `SELECT count(*)::text AS "count" FROM "patta_print_batch_corrections" WHERE "batch_id" = $1`,
        [original.id],
      );
      expect(correctionCount).toEqual([{ count: '3' }]);
    }, 30_000);

    it('applies an offline correction with the device block, client UUIDs and immutable operation price snapshots', async () => {
      const tenant = tenants[0];
      if (!tenant) throw new Error('Tenant A fixture was not initialized');
      const actorId = await createActor(tenant.runtimeDataSource);
      await grantTenantPermission(tenant.runtimeDataSource, actorId, 'patta.chiqarish.correct');
      const feature = featureServices();
      const device = await new DeviceAccessService(masterDataSource).assertActiveDevice(tenant.companyId, deviceA);
      const model = await feature.models.create(tenant.runtimeDataSource, actorId, {
        name: `Offline correction model ${randomUUID()}`,
      });
      const operation = await feature.operations.create(tenant.runtimeDataSource, model.id, actorId, {
        name: 'Tikish', price: '37.00', sort_order: 0,
      });
      const batch = await feature.printBatches.create(tenant.runtimeDataSource, actorId, device.id, {
        model_id: model.id, ish_soni: 125, rang: 'Qora', device_id: device.id,
        size_distribution: [{ razmer: 'S', patta_count: 1, sort_order: 0 }],
      });
      const oldPatta = batch.pattas[0];
      if (!oldPatta) throw new Error('Online Patta batch did not include its Patta');
      const oldSize = batch.size_distribution[0];
      if (!oldSize) throw new Error('Online Patta batch did not include its size row');
      const block = await feature.blocks.allocate(tenant.runtimeDataSource, actorId, device.id);
      const occurredAt = await futureTimestamp(tenant.runtimeDataSource, '0 seconds');
      const eventId = randomUUID();
      const newPattaId = randomUUID();
      const newSnapshotId = randomUUID();
      const corrected = await tenant.runtimeDataSource.transaction((manager) =>
        feature.printBatches.registerOfflineBatchCorrection(manager, actorId, device.id, {
          event_id: eventId,
          entity_type: 'patta_print_batch',
          entity_id: batch.id,
          operation: 'UPDATE',
          base_version: '1',
          client_created_at: occurredAt,
          occurred_at: occurredAt,
          reference_cursor: '0',
          payload: {
            model_id: batch.model_id,
            model_name_snapshot: batch.model_name_snapshot,
            partiya_block_id: batch.partiya_block_id,
            partiya_number: batch.partiya_number,
            ish_soni: 125,
            rang: 'Qora',
            correction_reason: 'Pachka soni qayta aniqlandi',
            size_distribution: [{
              id: oldSize.id,
              razmer: 'S', patta_count: 2, sort_order: 0,
            }],
            pattas: [
              {
                id: oldPatta.id,
                patta_number: oldPatta.patta_number,
                block_id: oldPatta.created_from_block_id,
                razmer: 'S',
                operation_snapshots: oldPatta.operations.map((snapshot) => ({
                  id: snapshot.id,
                  operation_id: snapshot.operation_id,
                  operation_name_snapshot: snapshot.operation_name_snapshot,
                  unit_price_snapshot: snapshot.unit_price_snapshot,
                  sort_order: snapshot.sort_order,
                })),
              },
              {
                id: newPattaId,
                patta_number: block.range_start,
                block_id: block.id,
                razmer: 'S',
                operation_snapshots: [{
                  id: newSnapshotId,
                  operation_id: operation.id,
                  operation_name_snapshot: operation.name,
                  unit_price_snapshot: '37.00',
                  sort_order: 0,
                }],
              },
            ],
            depends_on_event_ids: [],
          },
        }),
      );

      expect(corrected.batch).toMatchObject({ version: '2', revision: 2 });
      expect(corrected.batch.pattas.map(({ id, patta_number }) => [id, patta_number])).toEqual([
        [oldPatta.id, oldPatta.patta_number], [newPattaId, block.range_start],
      ]);
      expect(corrected.batch.pattas[1]?.operations).toMatchObject([{
        id: newSnapshotId, operation_id: operation.id, unit_price_snapshot: '37.00',
      }]);
      const attribution: Array<{ created_from_block_id: string; created_device_id: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT "created_from_block_id"::text AS "created_from_block_id",
                  "created_device_id"::text AS "created_device_id"
           FROM "patta_hisob" WHERE "id" = $1`,
          [newPattaId],
        );
      expect(attribution).toEqual([{ created_from_block_id: block.id, created_device_id: device.id }]);
      const correctionLedger: Array<{ event_id: string | null; reason: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT "event_id"::text AS "event_id", "reason" FROM "patta_print_batch_corrections"
           WHERE "batch_id" = $1 AND "to_revision" = 2`,
          [batch.id],
        );
      expect(correctionLedger).toEqual([{ event_id: eventId, reason: 'Pachka soni qayta aniqlandi' }]);
    }, 30_000);

    it('enforces Patta Sheet parent, snapshot, row, quantity, and Korzinka purge constraints', async () => {
      const tenant = tenants[0];
      if (!tenant) throw new Error('Tenant A fixture was not initialized');
      const actorId = await createActor(tenant.runtimeDataSource);
      const feature = featureServices();
      const model = await feature.models.create(tenant.runtimeDataSource, actorId, {
        name: `Sheet constraints model ${randomUUID()}`,
      });
      const operationA = await feature.operations.create(tenant.runtimeDataSource, model.id, actorId, {
        name: 'Tikish', price: '10.00', sort_order: 0,
      });
      const operationB = await feature.operations.create(tenant.runtimeDataSource, model.id, actorId, {
        name: 'Qadoqlash', price: '5.00', sort_order: 1,
      });
      const device = await new DeviceAccessService(masterDataSource).assertActiveDevice(tenant.companyId, deviceA);
      const batch = await feature.printBatches.create(tenant.runtimeDataSource, actorId, device.id, {
        model_id: model.id, ish_soni: 125, rang: 'Qora', device_id: device.id,
        size_distribution: [{ razmer: 'S', patta_count: 1, sort_order: 0 }],
      });
      const patta = batch.pattas[0];
      const pattaSnapshotA = patta?.operations.find(({ operation_id }) => operation_id === operationA.id);
      const pattaSnapshotB = patta?.operations.find(({ operation_id }) => operation_id === operationB.id);
      if (!patta || !pattaSnapshotA || !pattaSnapshotB) throw new Error('Patta operation history was not returned');
      const workerRows: Array<{ id: string }> = await tenant.runtimeDataSource.query(
        `INSERT INTO "workers" ("full_name") VALUES ('Sheet Worker') RETURNING "id"::text AS "id"`,
      );
      const workerId = workerRows[0]?.id;
      if (!workerId) throw new Error('Sheet test worker was not created');
      const enteredAt = await futureTimestamp(tenant.runtimeDataSource, '12 hours');
      const companyTimezones: Array<{ timezone: string }> = await masterDataSource.query(
        `SELECT "timezone" FROM "companies" WHERE "id" = $1`, [tenant.companyId],
      );
      const timezone = companyTimezones[0]?.timezone;
      if (!timezone) throw new Error('Tenant company timezone was not returned');
      const businessDates: Array<{ business_date: string }> = await tenant.runtimeDataSource.query(
        `SELECT (($1::timestamptz AT TIME ZONE $2::text)::date)::text AS "business_date"`,
        [enteredAt, timezone],
      );
      const businessDate = businessDates[0]?.business_date;
      if (!businessDate) throw new Error('Tenant local business date was not derived');
      await tenant.runtimeDataSource.query(
        `INSERT INTO "worker_badge_history" ("badge_number", "worker_id", "valid_from", "created_by")
         VALUES ('0007', $1::bigint, $2::timestamptz - interval '1 hour', $3)`,
        [workerId, enteredAt, actorId],
      );
      const snapshotAId = randomUUID();
      const snapshotBId = randomUUID();
      const rowId = randomUUID();
      const sheet = await feature.sheets.create(tenant.runtimeDataSource, {
        actorUserId: actorId, validatedDeviceId: device.id, timezone,
      }, {
        id: randomUUID(), patta_hisob_id: patta.id, entered_at: enteredAt,
        business_date: businessDate, conveyor_snapshot: null, device_id: device.id,
        operation_snapshots: [
          {
            id: snapshotAId, model_operation_id: operationA.id, source_type: 'PATTA',
            source_patta_operation_snapshot_id: pattaSnapshotA.id,
            operation_name_snapshot: pattaSnapshotA.operation_name_snapshot,
            unit_price_snapshot: pattaSnapshotA.unit_price_snapshot, sort_order: pattaSnapshotA.sort_order,
          },
          {
            id: snapshotBId, model_operation_id: operationB.id, source_type: 'PATTA',
            source_patta_operation_snapshot_id: pattaSnapshotB.id,
            operation_name_snapshot: pattaSnapshotB.operation_name_snapshot,
            unit_price_snapshot: pattaSnapshotB.unit_price_snapshot, sort_order: pattaSnapshotB.sort_order,
          },
        ],
        rows: [{
          id: rowId, patta_sheet_operation_snapshot_id: snapshotAId,
          worker_id: workerId, quantity_snapshot: 125, nuqson: false,
          entered_badge_number: '0007',
        }],
        depends_on_event_ids: [],
      });
      const sheetId = sheet.id;

      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `INSERT INTO "patta_sheets" ("id", "patta_hisob_id", "entered_at", "business_date", "created_by")
           VALUES ($1, $2, $3::timestamptz, $4::date, $5)`,
          [randomUUID(), patta.id, enteredAt, businessDate, actorId],
        ),
        'uq_patta_sheets_patta',
      );
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `UPDATE "patta_sheets" SET "entered_at" = "entered_at" + interval '1 day', "version" = "version" + 1
           WHERE "id" = $1`, [sheetId],
        ),
        'trg_patta_sheets_immutable_identity',
      );
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `UPDATE "patta_sheet_operation_snapshots" SET "operation_name_snapshot" = 'Changed' WHERE "id" = $1`,
          [snapshotAId],
        ),
        'trg_patta_sheet_operation_snapshots_immutable',
      );
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `INSERT INTO "patta_sheet_rows"
            ("id", "patta_sheet_id", "patta_sheet_operation_snapshot_id", "worker_id", "quantity_snapshot", "nuqson")
           VALUES ($1, $2, $3, $4::bigint, 124, false)`,
          [randomUUID(), sheetId, snapshotBId, workerId],
        ),
        'ck_patta_sheet_row_quantity_matches_patta',
      );
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          `DELETE FROM "patta_sheet_rows" WHERE "id" = $1`, [rowId],
        ),
        'trg_patta_sheet_children_purge_only',
      );

      await tenant.runtimeDataSource.query(
        `UPDATE "patta_sheets" SET "deleted_at" = transaction_timestamp(), "deleted_by" = $2,
          "version" = "version" + 1, "updated_at" = transaction_timestamp() WHERE "id" = $1`,
        [sheetId, actorId],
      );
      await tenant.runtimeDataSource.query('DELETE FROM "patta_sheet_rows" WHERE "id" = $1', [rowId]);
      await tenant.runtimeDataSource.query('DELETE FROM "patta_sheet_operation_snapshots" WHERE "patta_sheet_id" = $1', [sheetId]);
      await tenant.runtimeDataSource.query('DELETE FROM "patta_sheets" WHERE "id" = $1', [sheetId]);
      const pattaStillExists: Array<{ id: string }> = await tenant.runtimeDataSource.query(
        `SELECT "id" FROM "patta_hisob" WHERE "id" = $1`, [patta.id],
      );
      expect(pattaStillExists).toEqual([{ id: patta.id }]);
      await expect(tenant.runtimeDataSource.query(
        `INSERT INTO "patta_sheets" ("id", "patta_hisob_id", "entered_at", "business_date", "created_by")
         VALUES ($1, $2, $3::timestamptz, $4::date, $5) RETURNING "id"`,
        [randomUUID(), patta.id, enteredAt, businessDate, actorId],
      )).resolves.toHaveLength(1);
    }, 30_000);

    it('registers offline Patta IDs and historical snapshots only against matching references', async () => {
      const tenant = tenants[0];
      if (!tenant) throw new Error('Tenant A fixture was not initialized');
      const actorId = await createActor(tenant.runtimeDataSource);
      const feature = featureServices();
      const model = await feature.models.create(tenant.runtimeDataSource, actorId, {
        name: `Offline model ${randomUUID()}`,
      });
      const operation = await feature.operations.create(
        tenant.runtimeDataSource,
        model.id,
        actorId,
        { name: 'Offline stitch', price: '10.00', sort_order: 0 },
      );
      const activeDevice = await createMasterDevice(tenant.companyId, 'ACTIVE');
      const device = await new DeviceAccessService(masterDataSource)
        .assertActiveDevice(tenant.companyId, activeDevice);
      const block = await feature.blocks.allocate(tenant.runtimeDataSource, actorId, device.id);
      const cursorRows: Array<{ cursor: string }> = await tenant.runtimeDataSource.query(
        `SELECT COALESCE(MAX("sequence_id"), 0)::text AS "cursor" FROM "server_change_log"`,
      );
      const referenceCursor = cursorRows[0]?.cursor;
      if (!referenceCursor) throw new Error('Server reference cursor was not returned');
      const occurredAt = await futureTimestamp(tenant.runtimeDataSource, '0 seconds');
      const pattaId = randomUUID();
      const snapshotId = randomUUID();
      const eventId = randomUUID();
      const makeEvent = (unitPrice: string, overrides: Record<string, unknown> = {}) => ({
        event_id: eventId,
        entity_type: 'patta',
        entity_id: pattaId,
        operation: 'CREATE',
        base_version: '0',
        client_created_at: occurredAt,
        occurred_at: occurredAt,
        reference_cursor: referenceCursor,
        payload: {
          ish_soni: 125,
          partiya_number: 'OFFLINE-1',
          patta_number: block.range_start,
          model_id: model.id,
          model_name_snapshot: model.name,
          template_id: null,
          konveyer_snapshot: '1-konveyer',
          razmer: null,
          rang: null,
          block_id: block.id,
          reference_versions: {
            model: model.version,
            template: null,
            operations: { [operation.id]: operation.version },
          },
          operations: [{
            id: snapshotId,
            operation_id: operation.id,
            operation_name_snapshot: operation.name,
            unit_price_snapshot: unitPrice,
            sort_order: operation.sort_order,
          }],
          ...overrides,
        },
      });

      await expect(tenant.runtimeDataSource.transaction((manager) =>
        feature.pattas.registerOffline(manager, actorId, device.id, makeEvent('99.00')),
      )).rejects.toMatchObject({
        response: { code: 'PATTA_SNAPSHOT_MISMATCH' },
      });

      const registration = await tenant.runtimeDataSource.transaction((manager) =>
        feature.pattas.registerOffline(manager, actorId, device.id, makeEvent('10.00')),
      );
      expect(registration).toMatchObject({
        version: '1',
        record: {
          id: pattaId,
          partiya_number: 'OFFLINE-1',
          patta_number: block.range_start,
          operations: [{ operation_id: operation.id, unit_price_snapshot: '10.00' }],
        },
      });

      const offlineAttribution: Array<{
        created_device_id: string;
        created_from_block_id: string;
        client_created_at: string;
        occurred_at: string;
      }> = await tenant.runtimeDataSource.query(
        `SELECT "created_device_id"::text AS "created_device_id",
                "created_from_block_id"::text AS "created_from_block_id",
                to_char("client_created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "client_created_at",
                to_char("occurred_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurred_at"
         FROM "patta_hisob" WHERE "id" = $1`,
        [pattaId],
      );
      expect(offlineAttribution).toEqual([{
        created_device_id: device.id,
        created_from_block_id: block.id,
        client_created_at: occurredAt,
        occurred_at: occurredAt,
      }]);

      const snapshotRows: Array<{ id: string; price: string }> = await tenant.runtimeDataSource.query(
        `SELECT "id"::text AS "id", "unit_price_snapshot"::text AS "price"
         FROM "patta_operation_snapshots" WHERE "patta_hisob_id" = $1`,
        [pattaId],
      );
      expect(snapshotRows).toEqual([{ id: snapshotId, price: '10.00' }]);
      const syncRows: Array<{ sequence_id: string; entity_type: string; entity_id: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT "sequence_id"::text AS "sequence_id", "entity_type", "entity_id"
           FROM "server_change_log"
           WHERE "entity_id" = ANY($1::varchar[])
           ORDER BY "sequence_id"`,
          [[pattaId, snapshotId]],
        );
      expect(syncRows).toEqual([
        { sequence_id: registration.changeSequence, entity_type: 'patta_hisob', entity_id: pattaId },
        { sequence_id: expect.any(String), entity_type: 'patta_operation_snapshots', entity_id: snapshotId },
      ]);

      await expect(tenant.runtimeDataSource.transaction((manager) =>
        feature.pattas.registerOffline(manager, actorId, device.id, {
          ...makeEvent('10.00'),
          event_id: randomUUID(),
        }),
      )).rejects.toMatchObject({
        response: { code: 'PATTA_ALREADY_EXISTS' },
      });

      const template = await feature.templates.create(tenant.runtimeDataSource, actorId, {
        name: `Offline template ${randomUUID()}`,
        model_id: model.id,
        konveyer: '2-konveyer',
        razmer: '42',
        rang: 'Ko‘k',
      });
      const templateCursorRows: Array<{ cursor: string }> = await tenant.runtimeDataSource.query(
        `SELECT COALESCE(MAX("sequence_id"), 0)::text AS "cursor" FROM "server_change_log"`,
      );
      const templateCursor = templateCursorRows[0]?.cursor;
      if (!templateCursor) throw new Error('Template reference cursor was not returned');
      const templatePattaId = randomUUID();
      const templateSnapshotId = randomUUID();
      const templateEvent = {
        ...makeEvent('10.00', {
          partiya_number: 'OFFLINE-TEMPLATE',
          patta_number: (BigInt(block.range_start) + 1n).toString(),
          template_id: template.id,
          konveyer_snapshot: template.konveyer,
          razmer: template.razmer,
          rang: null,
          template_overrides: { rang: null },
          reference_versions: {
            model: model.version,
            template: template.version,
            operations: { [operation.id]: operation.version },
          },
          operations: [{
            id: templateSnapshotId,
            operation_id: operation.id,
            operation_name_snapshot: operation.name,
            unit_price_snapshot: '10.00',
            sort_order: operation.sort_order,
          }],
        }),
        event_id: randomUUID(),
        entity_id: templatePattaId,
        reference_cursor: templateCursor,
      };
      const templateRegistration = await tenant.runtimeDataSource.transaction((manager) =>
        feature.pattas.registerOffline(manager, actorId, device.id, templateEvent),
      );
      expect(templateRegistration.record).toMatchObject({
        id: templatePattaId,
        template_id: template.id,
        konveyer_snapshot: template.konveyer,
        razmer: template.razmer,
        rang: null,
      });

      await expect(tenant.runtimeDataSource.transaction((manager) =>
        feature.pattas.registerOffline(manager, actorId, device.id, {
          ...templateEvent,
          event_id: randomUUID(),
          entity_id: randomUUID(),
          reference_cursor: templateCursor,
          payload: {
            ...templateEvent.payload,
            partiya_number: 'OFFLINE-TEMPLATE-MISMATCH',
            patta_number: (BigInt(block.range_start) + 2n).toString(),
            konveyer_snapshot: 'wrong-conveyor',
            rang: template.rang,
            template_overrides: {},
            operations: [{
              id: randomUUID(),
              operation_id: operation.id,
              operation_name_snapshot: operation.name,
              unit_price_snapshot: '10.00',
              sort_order: operation.sort_order,
            }],
          },
        }),
      )).rejects.toMatchObject({ response: { code: 'PATTA_SNAPSHOT_MISMATCH' } });

      await feature.prices.changePrice(tenant.runtimeDataSource, {
        operationId: operation.id,
        actorUserId: actorId,
        price: '12.00',
        effectiveFrom: await futureTimestamp(tenant.runtimeDataSource, '2 seconds'),
        expectedVersion: '1',
      });
      await expect(tenant.runtimeDataSource.transaction((manager) =>
        feature.pattas.registerOffline(manager, actorId, device.id, {
          ...makeEvent('12.00'),
          event_id: randomUUID(),
          entity_id: randomUUID(),
          payload: {
            ...(makeEvent('12.00').payload as Record<string, unknown>),
            partiya_number: 'OFFLINE-2',
            patta_number: (BigInt(block.range_start) + 1n).toString(),
            operations: [{
              id: randomUUID(),
              operation_id: operation.id,
              operation_name_snapshot: operation.name,
              unit_price_snapshot: '12.00',
              sort_order: operation.sort_order,
            }],
          },
        }),
      )).rejects.toMatchObject({
        response: { code: 'REFERENCE_DATA_STALE' },
      });
    }, 30_000);

    it('serializes Patta snapshots against concurrent operation rename/create/deactivation/price changes', async () => {
      const tenant = tenants[0];
      if (!tenant) throw new Error('Tenant A fixture was not initialized');
      const actorId = await createActor(tenant.runtimeDataSource);
      const feature = featureServices();
      const model = await feature.models.create(tenant.runtimeDataSource, actorId, {
        name: `Concurrent model ${randomUUID()}`,
      });
      const operation = await feature.operations.create(tenant.runtimeDataSource, model.id, actorId, {
        name: 'Concurrent old name', price: '800.00', sort_order: 0,
      });
      const validatedDevice = await new DeviceAccessService(masterDataSource)
        .assertActiveDevice(tenant.companyId, deviceA);

      const [renameRace] = await Promise.all([
        feature.printBatches.create(tenant.runtimeDataSource, actorId, validatedDevice.id, {
          model_id: model.id, ish_soni: 125, rang: 'Qora', device_id: validatedDevice.id,
          size_distribution: [{ razmer: 'S', patta_count: 1, sort_order: 0 }],
        }),
        feature.operations.update(tenant.runtimeDataSource, actorId, operation.id, {
          name: 'Concurrent new name', expected_version: '1',
        }),
      ]);
      const renamedRacePatta = renameRace.pattas[0];
      if (!renamedRacePatta) throw new Error('Concurrent rename Patta was not created');
      expect(['Concurrent old name', 'Concurrent new name'])
        .toContain(renamedRacePatta.operations[0]?.operation_name_snapshot);

      const newOperation = await feature.operations.create(
        tenant.runtimeDataSource,
        model.id,
        actorId,
        { name: 'Concurrent added operation', price: '300.00', sort_order: 1 },
      );
      const [deactivateRace] = await Promise.all([
        feature.printBatches.create(tenant.runtimeDataSource, actorId, validatedDevice.id, {
          model_id: model.id, ish_soni: 125, rang: 'Qora', device_id: validatedDevice.id,
          size_distribution: [{ razmer: 'M', patta_count: 1, sort_order: 0 }],
        }),
        feature.operations.update(tenant.runtimeDataSource, actorId, newOperation.id, {
          status: 'INACTIVE', expected_version: '1',
        }),
      ]);
      const deactivationPatta = deactivateRace.pattas[0];
      if (!deactivationPatta) throw new Error('Concurrent deactivation Patta was not created');
      const deactivationSnapshotRows: Array<{ operation_id: string }> = await tenant.runtimeDataSource.query(
        `SELECT "operation_id" FROM "patta_operation_snapshots"
         WHERE "patta_hisob_id" = $1 ORDER BY "operation_id"`,
        [deactivationPatta.id],
      );
      expect(deactivationPatta.ish_soni).toBe(125);
      expect([1, 2]).toContain(deactivationSnapshotRows.length);
      expect(deactivationSnapshotRows.map(({ operation_id }) => operation_id)).toEqual(
        expect.arrayContaining([operation.id]),
      );
      expect(deactivationSnapshotRows.some(({ operation_id }) => operation_id === newOperation.id))
        .toBe(deactivationSnapshotRows.length === 2);

      const [priceRace] = await Promise.all([
        feature.printBatches.create(tenant.runtimeDataSource, actorId, validatedDevice.id, {
          model_id: model.id, ish_soni: 125, rang: 'Qora', device_id: validatedDevice.id,
          size_distribution: [{ razmer: 'L', patta_count: 1, sort_order: 0 }],
        }),
        feature.prices.changePrice(tenant.runtimeDataSource, {
          operationId: operation.id,
          actorUserId: actorId,
          price: '950.00',
          expectedVersion: '2',
        }),
      ]);
      const priceRacePatta = priceRace.pattas[0];
      if (!priceRacePatta) throw new Error('Concurrent price Patta was not created');
      const storedPrice = priceRacePatta.operations.find(({ operation_id }) => operation_id === operation.id)
        ?.unit_price_snapshot;
      const effectiveAtCreation = await feature.prices.resolvePrice(
        operation.id,
        priceRacePatta.created_at,
        tenant.runtimeDataSource,
      );
      expect(storedPrice).toBe(effectiveAtCreation);
    }, 30_000);

    it('enforces Patta pair uniqueness, snapshot immutability, rollback safety, and independent tenant keys', async () => {
      const tenant = await createTenant(await createMasterCompany());
      const otherTenant = await createTenant(await createMasterCompany());
      const actorA = await createActor(tenant.runtimeDataSource);
      const actorB = await createActor(otherTenant.runtimeDataSource);
      const localDeviceA = await createMasterDevice(tenant.companyId, 'ACTIVE');
      const localDeviceB = await createMasterDevice(otherTenant.companyId, 'ACTIVE');
      const featureA = featureServices();
      const featureB = featureServices();
      const modelA = await featureA.models.create(tenant.runtimeDataSource, actorA, {
        name: `Same tenant-isolated model`,
      });
      const modelB = await featureB.models.create(otherTenant.runtimeDataSource, actorB, {
        name: `Same tenant-isolated model`,
      });
      await featureA.operations.create(tenant.runtimeDataSource, modelA.id, actorA, {
        name: 'Same operation', price: '500.00', sort_order: 0,
      });
      await featureB.operations.create(otherTenant.runtimeDataSource, modelB.id, actorB, {
        name: 'Same operation', price: '700.00', sort_order: 0,
      });
      const validDeviceA = await new DeviceAccessService(masterDataSource).assertActiveDevice(tenant.companyId, localDeviceA);
      const validDeviceB = await new DeviceAccessService(masterDataSource).assertActiveDevice(otherTenant.companyId, localDeviceB);
      const generatedA = await featureA.printBatches.create(tenant.runtimeDataSource, actorA, validDeviceA.id, {
        model_id: modelA.id, ish_soni: 125, rang: 'Qora', device_id: validDeviceA.id,
        size_distribution: [{ razmer: 'S', patta_count: 1, sort_order: 0 }],
      });
      const generatedB = await featureB.printBatches.create(otherTenant.runtimeDataSource, actorB, validDeviceB.id, {
        model_id: modelB.id, ish_soni: 125, rang: 'Qora', device_id: validDeviceB.id,
        size_distribution: [{ razmer: 'S', patta_count: 1, sort_order: 0 }],
      });
      const generatedPattaA = generatedA.pattas[0];
      const generatedPattaB = generatedB.pattas[0];
      if (!generatedPattaA || !generatedPattaB) throw new Error('Tenant-isolated print batch did not return its Patta');
      expect(generatedPattaA.patta_number).toBe(generatedPattaB.patta_number);
      await featureA.offline.assertBusinessKeyAvailable(
        tenant.runtimeDataSource,
        generatedA.partiya_number,
        BigInt(generatedPattaA.patta_number) + 1n,
      );
      await expect(featureA.offline.assertBusinessKeyAvailable(
        tenant.runtimeDataSource,
        generatedA.partiya_number,
        BigInt(generatedPattaA.patta_number),
      )).rejects.toMatchObject({ response: { code: 'PATTA_ALREADY_EXISTS' } });
      await expect(featureA.pattas.lookup(
        tenant.runtimeDataSource,
        generatedA.partiya_number,
        generatedPattaA.patta_number,
      )).rejects.toMatchObject({ response: { code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED' } });
      await expect(featureB.pattas.lookup(
        otherTenant.runtimeDataSource,
        generatedB.partiya_number,
        generatedPattaB.patta_number,
      )).rejects.toMatchObject({ response: { code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED' } });

      const duplicateNumber = '9000000000000001';
      await tenant.runtimeDataSource.query(
        `INSERT INTO "patta_hisob"
           ("partiya_number", "patta_number", "model_id", "model_name_snapshot", "konveyer_snapshot",
            "ish_soni", "created_device_id", "created_by")
         VALUES ('UNIQUE-A', $1::bigint, $2, 'Same model', '1', 1, $3, $4)`,
        [duplicateNumber, modelA.id, localDeviceA, actorA],
      );
      await tenant.runtimeDataSource.query(
        `INSERT INTO "patta_hisob"
           ("partiya_number", "patta_number", "model_id", "model_name_snapshot", "konveyer_snapshot",
            "ish_soni", "created_device_id", "created_by")
         VALUES ('UNIQUE-B', $1::bigint, $2, 'Same model', '1', 1, $3, $4)`,
        [duplicateNumber, modelA.id, localDeviceA, actorA],
      );
      const pairRace = await Promise.allSettled([1, 2].map(() => tenant.runtimeDataSource.query(
        `INSERT INTO "patta_hisob"
           ("partiya_number", "patta_number", "model_id", "model_name_snapshot", "konveyer_snapshot",
            "ish_soni", "created_device_id", "created_by")
         VALUES ('RACE-PAIR', $1::bigint, $2, 'Same model', '1', 1, $3, $4)`,
        [duplicateNumber, modelA.id, localDeviceA, actorA],
      )));
      expect(pairRace.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      const rejectedPairRace = pairRace.find(({ status }) => status === 'rejected');
      expect(rejectedPairRace?.status === 'rejected' ? rejectedPairRace.reason : undefined)
        .toMatchObject({ driverError: { constraint: 'uq_patta_hisob_partiya_patta' } });

      const pattaId = generatedPattaA.id;
      const historyTemplate = await featureA.templates.create(tenant.runtimeDataSource, actorA, {
        name: `Protected template ${randomUUID()}`,
        model_id: modelA.id,
        konveyer: '1',
      });
      await expectConstraintViolation(
        tenant.runtimeDataSource.query('DELETE FROM "patta_templates" WHERE "id" = $1', [historyTemplate.id]),
        'trg_patta_templates_no_delete',
      );
      await expectConstraintViolation(
        tenant.runtimeDataSource.query('DELETE FROM "patta_hisob" WHERE "id" = $1', [pattaId]),
        'trg_patta_hisob_immutable',
      );
      await expectConstraintViolation(
        tenant.runtimeDataSource.query(
          'UPDATE "patta_operation_snapshots" SET "unit_price_snapshot" = 1 WHERE "patta_hisob_id" = $1',
          [pattaId],
        ),
        'trg_patta_operation_snapshots_immutable',
      );
        await expectConstraintViolation(
          tenant.migrationDataSource.undoLastMigration({ transaction: 'all' }),
          'ck_patta_sheets_empty_before_revert',
        );
      const stillApplied: Array<{ name: string }> = await tenant.migrationDataSource.query(
        `SELECT "name" FROM "tenant_typeorm_migrations" WHERE "name" = $1`,
        [SYNC_MIGRATION_NAME],
      );
      expect(stillApplied).toHaveLength(1);
    }, 60_000);

    it('protects Patta template history when reverting the Patta migration itself', async () => {
      const rollbackCompany = await createMasterCompany();
      const rollbackTenant = await createTenant(rollbackCompany);
      const modelRows: Array<{ id: string }> = await rollbackTenant.migrationDataSource.query(
        `INSERT INTO "models" ("name") VALUES ($1) RETURNING "id"`,
        [`Rollback template model ${randomUUID()}`],
      );
      const modelId = modelRows[0]?.id;
      if (!modelId) throw new Error('Rollback fixture model was not inserted');
      await rollbackTenant.migrationDataSource.query(
        `INSERT INTO "patta_templates" ("name", "model_id", "konveyer")
         VALUES ($1, $2, '1-konveyer')`,
        [`Rollback template ${randomUUID()}`, modelId],
      );

      let rollbackMigrations: Array<{ name: string }> = await rollbackTenant.migrationDataSource.query(
        'SELECT "name" FROM "tenant_typeorm_migrations" ORDER BY "timestamp"',
      );
      while (rollbackMigrations.at(-1)?.name !== PATTA_MIGRATION_NAME) {
        if (!rollbackMigrations.at(-1)?.name) throw new Error('Patta foundation migration is missing');
        await rollbackTenant.migrationDataSource.undoLastMigration({ transaction: 'all' });
        rollbackMigrations = await rollbackTenant.migrationDataSource.query(
          'SELECT "name" FROM "tenant_typeorm_migrations" ORDER BY "timestamp"',
        );
      }
      await expectConstraintViolation(
        rollbackTenant.migrationDataSource.undoLastMigration({ transaction: 'all' }),
        'ck_patta_foundation_empty_before_revert',
      );
      const retainedTemplates: Array<{ count: string }> = await rollbackTenant.migrationDataSource.query(
        'SELECT count(*)::text AS "count" FROM "patta_templates"',
      );
      expect(retainedTemplates[0]?.count).toBe('1');
    }, 60_000);

    it('rolls back a failed Patta batch and its sequence reservation when audit fails', async () => {
      const tenant = tenants[1];
      if (!tenant) throw new Error('Tenant B fixture was not initialized');
      const actorId = await createActor(tenant.runtimeDataSource);
      const feature = featureServices();
      const deviceId = await createMasterDevice(tenant.companyId, 'ACTIVE');
      const model = await feature.models.create(tenant.runtimeDataSource, actorId, {
        name: `Rollback model ${randomUUID()}`,
      });
      await feature.operations.create(tenant.runtimeDataSource, model.id, actorId, {
        name: 'Rollback stitch', price: '10.00', sort_order: 0,
      });
      const beforeSequence: Array<{ next_number: string; version: string }> = await tenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number", "version"::text AS "version"
         FROM "patta_number_sequence" WHERE "id" = 1`,
      );
      const beforePartiyaSequence: Array<{ next_number: string; version: string }> = await tenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number", "version"::text AS "version"
         FROM "patta_partiya_number_sequence" WHERE "id" = 1`,
      );
      const beforeSnapshotCount: Array<{ count: string }> = await tenant.runtimeDataSource.query(
        'SELECT count(*)::text AS "count" FROM "patta_operation_snapshots"',
      );
      await tenant.migrationDataSource.query(`
        CREATE FUNCTION "reject_test_patta_audit"()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW."action" = 'patta_print_batch.create' THEN
            RAISE EXCEPTION 'test Patta audit failure' USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END $$
      `);
      await tenant.migrationDataSource.query(`
        CREATE TRIGGER "trg_test_patta_audit_failure"
        BEFORE INSERT ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "reject_test_patta_audit"()
      `);
      try {
        await expect(feature.printBatches.create(tenant.runtimeDataSource, actorId, deviceId, {
          model_id: model.id,
          ish_soni: 125,
          rang: 'Qora',
          device_id: deviceId,
          size_distribution: [{ razmer: 'S', patta_count: 2, sort_order: 0 }],
        })).rejects.toThrow(/test Patta audit failure/);
      } finally {
        await tenant.migrationDataSource.query('DROP TRIGGER "trg_test_patta_audit_failure" ON "audit_log"');
        await tenant.migrationDataSource.query('DROP FUNCTION "reject_test_patta_audit"()');
      }
      const afterSequence: Array<{ next_number: string; version: string }> = await tenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number", "version"::text AS "version"
         FROM "patta_number_sequence" WHERE "id" = 1`,
      );
      expect(afterSequence).toEqual(beforeSequence);
      const afterPartiyaSequence: Array<{ next_number: string; version: string }> = await tenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number", "version"::text AS "version"
         FROM "patta_partiya_number_sequence" WHERE "id" = 1`,
      );
      expect(afterPartiyaSequence).toEqual(beforePartiyaSequence);
      const noPatta: Array<{ count: string }> = await tenant.runtimeDataSource.query(
        `SELECT count(*)::text AS "count" FROM "patta_hisob"
         WHERE "model_id" = $1 AND "partiya_number" = '1'`,
        [model.id],
      );
      expect(noPatta[0]?.count).toBe('0');
      const noSnapshots: Array<{ count: string }> = await tenant.runtimeDataSource.query(
        `SELECT count(*)::text AS "count" FROM "patta_operation_snapshots"`,
      );
      expect(noSnapshots).toEqual(beforeSnapshotCount);
      const noPattaAudit: Array<{ count: string }> = await tenant.runtimeDataSource.query(
        `SELECT count(*)::text AS "count" FROM "audit_log"
         WHERE "entity_type" = 'patta_print_batch' AND "action" = 'patta_print_batch.create'
           AND "after_json"->>'model_id' = $1`,
        [model.id],
      );
      expect(noPattaAudit[0]?.count).toBe('0');
    }, 30_000);
  },
);
