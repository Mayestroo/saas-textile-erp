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
import { ModelsService } from '../models/models.service.js';
import { OperationPriceService } from '../operations/operation-price.service.js';
import { OperationsService } from '../operations/operations.service.js';
import { loadPattaConfiguration } from './patta.config.js';
import type { PattaConfiguration } from './patta.config.js';
import { PattaNumberBlocksService } from './patta-number-blocks.service.js';
import { PattaOfflineRegistrationValidator } from './patta-offline-registration.validator.js';
import { PattaService } from './patta.service.js';
import { PattaTemplatesService } from './patta-templates.service.js';

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

    function featureServices(configuration: PattaConfiguration = TEST_PATTA_CONFIGURATION) {
      const audit = new AuditService();
      const prices = new OperationPriceService(audit);
      const blocks = new PattaNumberBlocksService(audit, configuration);
      return {
        audit,
        prices,
        models: new ModelsService(audit),
        operations: new OperationsService(audit, prices),
        templates: new PattaTemplatesService(audit),
        blocks,
        pattas: new PattaService(audit, prices, configuration),
        offline: new PattaOfflineRegistrationValidator(blocks),
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
      expect(migrations.at(-1)?.name).toBe(PATTA_MIGRATION_NAME);
      const sequenceRows: Array<{ next_number: string }> = await tenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number" FROM "patta_number_sequence" WHERE "id" = 1`,
      );
      expect(sequenceRows).toEqual([{ next_number: '1' }]);
      await new PattaSequenceInitializer().initialize(tenant.migrationDataSource, 900n);
      const unchangedRows: Array<{ next_number: string }> = await tenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number" FROM "patta_number_sequence" WHERE "id" = 1`,
      );
      expect(unchangedRows).toEqual([{ next_number: '1' }]);

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
      await emptyTenant.migrationDataSource.undoLastMigration({ transaction: 'all' });
      const absentAfterDown: Array<{ table_name: string }> = await emptyTenant.migrationDataSource.query(
        `SELECT "table_name" FROM "information_schema"."tables"
         WHERE "table_schema" = 'public' AND "table_name" = 'patta_number_sequence'`,
      );
      expect(absentAfterDown).toHaveLength(0);
      const reapplied = await emptyTenant.migrationDataSource.runMigrations({ transaction: 'all' });
      expect(reapplied.map(({ name }) => name)).toEqual([PATTA_MIGRATION_NAME]);
      await initializer.initialize(emptyTenant.migrationDataSource, 77n);
      await tenantDatabaseManager.grantRuntimePrivileges(
        emptyTenant.companyId,
        emptyTenant.databaseName,
        tenantDatabaseManager.createSecret(emptyTenant.companyId),
      );
      const reinitialized: Array<{ next_number: string }> = await emptyTenant.runtimeDataSource.query(
        `SELECT "next_number"::text AS "next_number" FROM "patta_number_sequence" WHERE "id" = 1`,
      );
      expect(reinitialized).toEqual([{ next_number: '77' }]);
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

    it('creates templates and Patta snapshots from historical prices without changing old records', async () => {
      const tenant = tenants[0];
      if (!tenant) throw new Error('Tenant A fixture was not initialized');
      const actorId = await createActor(tenant.runtimeDataSource);
      const feature = featureServices();
      const model = await feature.models.create(tenant.runtimeDataSource, actorId, {
        name: `Patta Atlas ${randomUUID()}`,
      });
      const operation = await feature.operations.create(
        tenant.runtimeDataSource,
        model.id,
        actorId,
        { name: '  Yeng\t tikish ', price: '1000.00', sort_order: 4 },
      );
      const template = await feature.templates.create(tenant.runtimeDataSource, actorId, {
        name: `Atlas template ${randomUUID()}`,
        model_id: model.id,
        konveyer: '2-konveyer',
        razmer: '42',
        rang: 'Ko‘k',
      });
      expect(template).toMatchObject({ model_id: model.id, version: '1', status: 'ACTIVE' });
      await expect(feature.templates.getById(tenant.runtimeDataSource, template.id))
        .resolves.toMatchObject({ id: template.id, name: template.name });
      await expect(feature.templates.list(tenant.runtimeDataSource, { status: 'ACTIVE' }))
        .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: template.id })]));
      await expect(feature.templates.create(tenant.runtimeDataSource, actorId, {
        name: `  ${template.name}\t`,
        model_id: model.id,
        konveyer: '1',
      })).rejects.toMatchObject({ response: { code: 'PATTA_TEMPLATE_NAME_CONFLICT' } });

      const device = await new DeviceAccessService(masterDataSource).assertActiveDevice(tenant.companyId, deviceA);
      const first = await feature.pattas.generate(tenant.runtimeDataSource, actorId, device.id, {
        partiya_number: ' 25/09-3 ',
        model_id: model.id,
        template_id: template.id,
        count: 2,
      });
      const firstPatta = first[0];
      if (!firstPatta) throw new Error('Patta generation returned no record');
      expect(first).toHaveLength(2);
      expect(first[1]?.created_at).toBe(firstPatta.created_at);
      expect(first[1]?.patta_number).toBe((BigInt(firstPatta.patta_number) + 1n).toString());
      expect(firstPatta).toMatchObject({
        partiya_number: '25/09-3',
        model_name_snapshot: model.name,
        konveyer_snapshot: '2-konveyer',
        razmer: '42',
        rang: 'Ko‘k',
        ish_soni: 1,
        operations: [{
          operation_id: operation.id,
          operation_name_snapshot: 'Yeng tikish',
          unit_price_snapshot: '1000.00',
          sort_order: 4,
        }],
      });
      const onlineBlockRows: Array<{ created_from_block_id: string | null; created_device_id: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT "created_from_block_id", "created_device_id" FROM "patta_hisob" WHERE "id" = $1`,
          [firstPatta.id],
        );
      expect(onlineBlockRows).toEqual([{ created_from_block_id: null, created_device_id: deviceA }]);
      const createAudit: Array<{ entity_key: string; after_json: Record<string, unknown> }> =
        await tenant.runtimeDataSource.query(
          `SELECT "entity_key", "after_json" FROM "audit_log"
           WHERE "entity_type" = 'patta' AND "action" = 'patta.create' AND "entity_key" = $1`,
          [firstPatta.id],
        );
      expect(createAudit[0]).toMatchObject({
        entity_key: firstPatta.id,
        after_json: {
          partiya_number: '25/09-3',
          patta_number: firstPatta.patta_number,
          model_id: model.id,
          model_name_snapshot: model.name,
          device_id: deviceA,
          block_id: null,
          source: 'ONLINE',
        },
      });

      await feature.models.update(tenant.runtimeDataSource, actorId, model.id, {
        name: 'Renamed Atlas model',
        expected_version: '1',
      });
      await feature.operations.update(tenant.runtimeDataSource, actorId, operation.id, {
        name: 'Yangi yeng tikish',
        expected_version: '1',
      });
      const second = await feature.pattas.generate(tenant.runtimeDataSource, actorId, device.id, {
        partiya_number: '25/09-3',
        model_id: model.id,
        template_id: template.id,
        rang: null,
        count: 1,
      });
      expect(second[0]).toMatchObject({
        model_name_snapshot: 'Renamed Atlas model',
        rang: null,
        operations: [{ operation_name_snapshot: 'Yangi yeng tikish', unit_price_snapshot: '1000.00' }],
      });

      const futurePriceAt = await futureTimestamp(tenant.runtimeDataSource, '2 seconds');
      await feature.prices.changePrice(tenant.runtimeDataSource, {
        operationId: operation.id,
        actorUserId: actorId,
        price: '1200.00',
        effectiveFrom: futurePriceAt,
        expectedVersion: '2',
      });
      const beforeFuture = await feature.pattas.generate(tenant.runtimeDataSource, actorId, device.id, {
        partiya_number: '25/09-3',
        model_id: model.id,
        template_id: template.id,
        count: 1,
      });
      expect(beforeFuture[0]?.operations[0]?.unit_price_snapshot).toBe('1000.00');
      await tenant.runtimeDataSource.query("SELECT pg_sleep(2.2)");
      const afterFuture = await feature.pattas.generate(tenant.runtimeDataSource, actorId, device.id, {
        partiya_number: '25/09-3',
        model_id: model.id,
        template_id: template.id,
        count: 1,
      });
      expect(afterFuture[0]?.operations[0]?.unit_price_snapshot).toBe('1200.00');

      const firstPage = await feature.pattas.list(tenant.runtimeDataSource, {
        partiya_number: '25/09-3',
        page: 1,
        limit: 2,
      });
      expect(firstPage).toMatchObject({ total: '5', page: 1, limit: 2 });
      expect(firstPage.items).toHaveLength(2);
      const secondPage = await feature.pattas.list(tenant.runtimeDataSource, {
        partiya_number: '25/09-3',
        page: 2,
        limit: 2,
      });
      expect(secondPage.items).toHaveLength(2);

      const historical = await feature.pattas.lookup(
        tenant.runtimeDataSource,
        ' 25/09-3 ',
        firstPatta.patta_number,
      );
      expect(historical).toMatchObject({
        model: { id: model.id, name: model.name },
        model_name_snapshot: model.name,
        operations: [{ operation_name_snapshot: 'Yeng tikish', unit_price_snapshot: '1000.00' }],
      });
      const historyCount: Array<{ count: string }> = await tenant.runtimeDataSource.query(
        `SELECT count(*)::text AS "count" FROM "patta_operation_snapshots" WHERE "patta_hisob_id" = $1`,
        [firstPatta.id],
      );
      expect(historyCount[0]?.count).toBe('1');

      const zeroOperationModel = await feature.models.create(tenant.runtimeDataSource, actorId, {
        name: `Zero operation ${randomUUID()}`,
      });
      await expect(feature.pattas.generate(tenant.runtimeDataSource, actorId, device.id, {
        partiya_number: 'NO-OPS',
        model_id: zeroOperationModel.id,
        konveyer: '1',
        count: 1,
      })).rejects.toMatchObject({ response: { code: 'PATTA_MODEL_HAS_NO_OPERATIONS' } });

      const inactiveModel = await feature.models.create(tenant.runtimeDataSource, actorId, {
        name: `Inactive Patta model ${randomUUID()}`,
      });
      await feature.operations.create(tenant.runtimeDataSource, inactiveModel.id, actorId, {
        name: 'Inactive model operation', price: '10.00', sort_order: 0,
      });
      await feature.models.update(tenant.runtimeDataSource, actorId, inactiveModel.id, {
        status: 'INACTIVE', expected_version: '1',
      });
      await expect(feature.pattas.generate(tenant.runtimeDataSource, actorId, device.id, {
        partiya_number: 'INACTIVE-MODEL',
        model_id: inactiveModel.id,
        konveyer: '1',
        count: 1,
      })).rejects.toMatchObject({ response: { code: 'MODEL_INACTIVE' } });

      await feature.templates.update(tenant.runtimeDataSource, actorId, template.id, {
        status: 'INACTIVE',
        expected_version: '1',
      });
      await expect(feature.templates.list(tenant.runtimeDataSource))
        .resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: template.id })]));
      await expect(feature.templates.list(tenant.runtimeDataSource, { status: 'INACTIVE' }))
        .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: template.id })]));
      await expect(feature.pattas.generate(tenant.runtimeDataSource, actorId, device.id, {
        partiya_number: 'INACTIVE-TEMPLATE',
        model_id: model.id,
        template_id: template.id,
        count: 1,
      })).rejects.toMatchObject({ response: { code: 'PATTA_TEMPLATE_INACTIVE' } });
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
        feature.pattas.generate(tenant.runtimeDataSource, actorId, validatedDevice.id, {
          partiya_number: 'RACE-RENAME', model_id: model.id, konveyer: '1', count: 1,
        }),
        feature.operations.update(tenant.runtimeDataSource, actorId, operation.id, {
          name: 'Concurrent new name', expected_version: '1',
        }),
      ]);
      const renamedRacePatta = renameRace[0];
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
        feature.pattas.generate(tenant.runtimeDataSource, actorId, validatedDevice.id, {
          partiya_number: 'RACE-DEACTIVATE', model_id: model.id, konveyer: '1', count: 1,
        }),
        feature.operations.update(tenant.runtimeDataSource, actorId, newOperation.id, {
          status: 'INACTIVE', expected_version: '1',
        }),
      ]);
      const deactivationPatta = deactivateRace[0];
      if (!deactivationPatta) throw new Error('Concurrent deactivation Patta was not created');
      const deactivationSnapshotRows: Array<{ operation_id: string }> = await tenant.runtimeDataSource.query(
        `SELECT "operation_id" FROM "patta_operation_snapshots"
         WHERE "patta_hisob_id" = $1 ORDER BY "operation_id"`,
        [deactivationPatta.id],
      );
      expect(deactivationPatta.ish_soni).toBe(deactivationSnapshotRows.length);
      expect(deactivationSnapshotRows.map(({ operation_id }) => operation_id)).toEqual(
        expect.arrayContaining([operation.id]),
      );
      expect(deactivationSnapshotRows.some(({ operation_id }) => operation_id === newOperation.id))
        .toBe(deactivationPatta.ish_soni === 2);

      const [priceRace] = await Promise.all([
        feature.pattas.generate(tenant.runtimeDataSource, actorId, validatedDevice.id, {
          partiya_number: 'RACE-PRICE', model_id: model.id, konveyer: '1', count: 1,
        }),
        feature.prices.changePrice(tenant.runtimeDataSource, {
          operationId: operation.id,
          actorUserId: actorId,
          price: '950.00',
          expectedVersion: '2',
        }),
      ]);
      const priceRacePatta = priceRace[0];
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
      const operationA = await featureA.operations.create(tenant.runtimeDataSource, modelA.id, actorA, {
        name: 'Same operation', price: '500.00', sort_order: 0,
      });
      const operationB = await featureB.operations.create(otherTenant.runtimeDataSource, modelB.id, actorB, {
        name: 'Same operation', price: '700.00', sort_order: 0,
      });
      const validDeviceA = await new DeviceAccessService(masterDataSource).assertActiveDevice(tenant.companyId, localDeviceA);
      const validDeviceB = await new DeviceAccessService(masterDataSource).assertActiveDevice(otherTenant.companyId, localDeviceB);
      const generatedA = await featureA.pattas.generate(tenant.runtimeDataSource, actorA, validDeviceA.id, {
        partiya_number: 'A-125', model_id: modelA.id, konveyer: '1', count: 1,
      });
      const generatedB = await featureB.pattas.generate(otherTenant.runtimeDataSource, actorB, validDeviceB.id, {
        partiya_number: 'A-125', model_id: modelB.id, konveyer: '1', count: 1,
      });
      expect(generatedA[0]?.patta_number).toBe(generatedB[0]?.patta_number);
      await featureA.offline.assertBusinessKeyAvailable(
        tenant.runtimeDataSource,
        ' A-125 ',
        BigInt(generatedA[0]?.patta_number ?? '1') + 1n,
      );
      await expect(featureA.offline.assertBusinessKeyAvailable(
        tenant.runtimeDataSource,
        'A-125',
        BigInt(generatedA[0]?.patta_number ?? '1'),
      )).rejects.toMatchObject({ response: { code: 'PATTA_ALREADY_EXISTS' } });
      await expect(featureA.pattas.lookup(
        tenant.runtimeDataSource,
        'A-125',
        generatedB[0]?.patta_number ?? '1',
      )).resolves.toMatchObject({ model: { id: modelA.id }, operations: [{ operation_id: operationA.id }] });
      await expect(featureB.pattas.lookup(
        otherTenant.runtimeDataSource,
        'A-125',
        generatedA[0]?.patta_number ?? '1',
      )).resolves.toMatchObject({ model: { id: modelB.id }, operations: [{ operation_id: operationB.id }] });

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

      const pattaId = generatedA[0]?.id;
      if (!pattaId) throw new Error('Generated Patta ID is missing');
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
        'ck_patta_foundation_empty_before_revert',
      );
      const stillApplied: Array<{ name: string }> = await tenant.migrationDataSource.query(
        `SELECT "name" FROM "tenant_typeorm_migrations" WHERE "name" = $1`,
        [PATTA_MIGRATION_NAME],
      );
      expect(stillApplied).toHaveLength(1);
    }, 60_000);

    it('rolls back a failed Patta batch and its sequence reservation when audit fails', async () => {
      const tenant = tenants[1];
      if (!tenant) throw new Error('Tenant B fixture was not initialized');
      const actorId = await createActor(tenant.runtimeDataSource);
      const feature = featureServices();
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
      const beforeSnapshotCount: Array<{ count: string }> = await tenant.runtimeDataSource.query(
        'SELECT count(*)::text AS "count" FROM "patta_operation_snapshots"',
      );
      await tenant.migrationDataSource.query(`
        CREATE FUNCTION "reject_test_patta_audit"()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW."action" = 'patta.create' THEN
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
        await expect(feature.pattas.generate(tenant.runtimeDataSource, actorId, deviceB, {
          partiya_number: 'ROLLBACK-PATTA', model_id: model.id, konveyer: '1', count: 2,
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
      const noPatta: Array<{ count: string }> = await tenant.runtimeDataSource.query(
        `SELECT count(*)::text AS "count" FROM "patta_hisob" WHERE "partiya_number" = 'ROLLBACK-PATTA'`,
      );
      expect(noPatta[0]?.count).toBe('0');
      const noSnapshots: Array<{ count: string }> = await tenant.runtimeDataSource.query(
        `SELECT count(*)::text AS "count" FROM "patta_operation_snapshots"`,
      );
      expect(noSnapshots).toEqual(beforeSnapshotCount);
      const noPattaAudit: Array<{ count: string }> = await tenant.runtimeDataSource.query(
        `SELECT count(*)::text AS "count" FROM "audit_log"
         WHERE "entity_type" = 'patta' AND "action" = 'patta.create'
           AND "after_json"->>'partiya_number' = 'ROLLBACK-PATTA'`,
      );
      expect(noPattaAudit[0]?.count).toBe('0');
    }, 30_000);
  },
);
