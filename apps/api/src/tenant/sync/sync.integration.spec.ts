import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { AesGcmTenantConnectionSecretCipher } from '../../master/provisioning/aes-gcm-tenant-connection-secret-cipher.js';
import { StructuredApiExceptionFilter } from '../../common/errors/structured-api-exception.filter.js';
import { JwtTokenService } from '../../common/auth/jwt-token.service.js';
import { loadAuthConfiguration } from '../../common/auth/auth-configuration.js';
import type {
  OfflinePattaCreateEvent,
  SyncProjection,
  SyncPushResult,
} from '@textile/sync-protocol';
import { AuditService } from '../audit/audit.service.js';
import { loadPattaConfiguration } from '../patta/patta.config.js';
import { PattaNumberBlocksService } from '../patta/patta-number-blocks.service.js';
import { PattaOfflineRegistrationValidator } from '../patta/patta-offline-registration.validator.js';
import { PattaService } from '../patta/patta.service.js';
import { OperationPriceService } from '../operations/operation-price.service.js';
import { createTestMasterDataSourceOptions } from '../../database/master/master-database.config.js';
import {
  createTenantMigrationDataSourceOptions,
  createTenantRuntimeDataSourceOptions,
  createTestTenantProvisionerCredentials,
} from '../../database/tenant/tenant-database.config.js';
import { TenantDatabaseManager } from '../../database/tenant/tenant-database-manager.js';
import { TenantTestDatabaseCleanup } from '../../database/tenant/tenant-test-database-cleanup.js';
import { SyncChangeRecorder } from './sync-change-recorder.js';
import { createSyncProjection } from './sync-projections.js';
import { loadSyncConfiguration } from './sync.config.js';
import { SyncBootstrapService } from './sync-bootstrap.service.js';
import { SyncEventProcessor } from './sync-event-processor.js';
import type {
  SyncApplyContext,
  SyncEntityHandler,
} from './sync-entity-handler.js';
import { SyncHandlerRegistry } from './sync-handler.registry.js';
import { PattaSyncHandler } from './patta-sync-handler.js';
import { SyncService } from './sync.service.js';
import {
  seedTenantPermissions,
  TENANT_ADMIN_ROLE_NAME,
} from '../rbac/tenant-permission.seed.js';

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
if (
  configuredVariables.length > 0 &&
  configuredVariables.length !== TEST_DATABASE_VARIABLES.length
) {
  const missing = TEST_DATABASE_VARIABLES.filter(
    (key) => !process.env[key]?.trim(),
  );
  throw new Error(
    `Sync PostgreSQL test configuration is incomplete: ${missing.join(', ')}`,
  );
}

const integrationDescribe =
  configuredVariables.length === TEST_DATABASE_VARIABLES.length
    ? describe
    : describe.skip;
const masterOptions =
  configuredVariables.length === TEST_DATABASE_VARIABLES.length
    ? createTestMasterDataSourceOptions(process.env)
    : undefined;
const provisionerCredentials =
  configuredVariables.length === TEST_DATABASE_VARIABLES.length
    ? createTestTenantProvisionerCredentials(process.env)
    : undefined;

function waitForSuccessfulExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Desktop acceptance child exited: code=${code}, signal=${signal}`,
          ),
        );
      }
    });
  });
}

interface TenantFixture {
  companyId: string;
  databaseName: string;
  secret: ReturnType<TenantDatabaseManager['createSecret']>;
  migrationDataSource: DataSource;
  runtimeDataSource: DataSource;
}

interface OfflineEventFixture {
  event: OfflinePattaCreateEvent;
  context: SyncApplyContext;
  deviceId: string;
  actorUserId: string;
}

interface TableNameRow {
  table_name: string;
}

interface ColumnRow {
  column_name: string;
  data_type: string;
}

interface RuntimePrivilegeRow {
  table_name: string;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
}

interface ObjectNameRow {
  object_name: string;
}

integrationDescribe(
  configuredVariables.length === 0
    ? 'Sync PostgreSQL integration (BLOCKED: TEST_MASTER_DB_* is not configured)'
    : 'Sync PostgreSQL integration',
  () => {
    if (!masterOptions || !provisionerCredentials) {
      it.skip('requires dedicated _test Master database credentials', () => {});
      return;
    }

    let masterDataSource: DataSource;
    let tenantDatabaseManager: TenantDatabaseManager;
    let cleanup: TenantTestDatabaseCleanup;
    let tenant: TenantFixture;
    let createdCompanyId: string | undefined;
    let nextTestBlockStart = 20_000_000n;

    async function createOfflineEventFixture(
      overrides: {
        partiyaNumber?: string;
        pattaNumber?: string;
        deviceId?: string;
      } = {},
    ): Promise<OfflineEventFixture> {
      const runtime = tenant.runtimeDataSource;
      const roleRows: Array<{ id: string }> = await runtime.query(
        'SELECT "id"::text AS "id" FROM "roles" WHERE "name" = $1',
        [TENANT_ADMIN_ROLE_NAME],
      );
      const roleId = roleRows[0]?.id;
      if (!roleId)
        throw new Error('Offline sync tenant admin role fixture is missing');
      const actorUserId = randomUUID();
      await runtime.query(
        `INSERT INTO "users" ("id", "role_id", "email", "full_name", "password_hash")
         VALUES ($1::uuid, $2::uuid, $3, 'Sync Integration Actor', 'test-only-hash')`,
        [actorUserId, roleId, `sync-${actorUserId}@example.test`],
      );

      const deviceId = overrides.deviceId ?? randomUUID();
      const modelId = randomUUID();
      const modelName = `Sync model ${randomUUID()}`;
      const operationId = randomUUID();
      await runtime.query(
        `INSERT INTO "models" ("id", "name", "status")
         VALUES ($1::uuid, $2, 'ACTIVE')`,
        [modelId, modelName],
      );
      await runtime.query(
        `INSERT INTO "model_operations"
           ("id", "model_id", "name", "price", "sort_order", "status")
         VALUES ($1::uuid, $2::uuid, 'Sync stitch', 12.50, 0, 'ACTIVE')`,
        [operationId, modelId],
      );
      await runtime.query(
        `INSERT INTO "model_operation_prices" ("operation_id", "price", "valid_from")
         VALUES ($1::uuid, 12.50, transaction_timestamp() - interval '1 day')`,
        [operationId],
      );
      const rangeStart = nextTestBlockStart;
      nextTestBlockStart += 1_000n;
      const blockId = randomUUID();
      await runtime.query(
        `INSERT INTO "patta_number_blocks" ("id", "device_id", "range_start", "range_end")
         VALUES ($1::uuid, $2::uuid, $3::bigint, $4::bigint)`,
        [
          blockId,
          deviceId,
          rangeStart.toString(),
          (rangeStart + 999n).toString(),
        ],
      );

      const cursorRows: Array<{ cursor: string }> = await runtime.query(
        `SELECT COALESCE(MAX("sequence_id"), 0)::text AS "cursor" FROM "server_change_log"`,
      );
      const cursor = cursorRows[0]?.cursor;
      if (cursor === undefined)
        throw new Error('Sync test change cursor was not returned');
      const snapshotId = randomUUID();
      const event: OfflinePattaCreateEvent = {
        event_id: randomUUID(),
        entity_type: 'patta',
        entity_id: randomUUID(),
        operation: 'CREATE',
        base_version: '0',
        client_created_at: new Date().toISOString(),
        occurred_at: new Date().toISOString(),
        reference_cursor: cursor,
        payload: {
          partiya_number: overrides.partiyaNumber ?? `SYNC-${randomUUID()}`,
          patta_number: overrides.pattaNumber ?? rangeStart.toString(),
          model_id: modelId,
          model_name_snapshot: modelName,
          template_id: null,
          konveyer_snapshot: 'Sync line',
          razmer: null,
          rang: null,
          block_id: blockId,
          reference_versions: {
            model: '1',
            template: null,
            operations: { [operationId]: '1' },
          },
          operations: [
            {
              id: snapshotId,
              operation_id: operationId,
              operation_name_snapshot: 'Sync stitch',
              unit_price_snapshot: '12.50',
              sort_order: 0,
            },
          ],
        },
      };
      return {
        event,
        deviceId,
        actorUserId,
        context: {
          actorUserId,
          companyId: tenant.companyId,
          validatedDeviceId: deviceId,
        },
      };
    }

    function createProcessor(
      handlerFactory?: (handler: PattaSyncHandler) => SyncEntityHandler,
    ): {
      processor: SyncEventProcessor;
      handler: PattaSyncHandler;
      syncService: SyncService;
    } {
      const auditService = new AuditService();
      const recorder = new SyncChangeRecorder();
      const pattaConfiguration = loadPattaConfiguration({});
      const operationPriceService = new OperationPriceService(
        auditService,
        recorder,
      );
      const blockService = new PattaNumberBlocksService(
        auditService,
        pattaConfiguration,
        recorder,
      );
      const validator = new PattaOfflineRegistrationValidator(blockService);
      const pattaService = new PattaService(
        auditService,
        operationPriceService,
        pattaConfiguration,
        recorder,
        validator,
      );
      const pattaHandler = new PattaSyncHandler(pattaService);
      const registry = new SyncHandlerRegistry([
        handlerFactory ? handlerFactory(pattaHandler) : pattaHandler,
      ]);
      const configuration = loadSyncConfiguration({});
      const processor = new SyncEventProcessor(registry, configuration);
      return {
        processor,
        handler: pattaHandler,
        syncService: new SyncService(processor, configuration),
      };
    }

    async function createGeneratedTenantFixture(): Promise<TenantFixture> {
      const companyId = randomUUID();
      const databaseName = cleanup.trackCompany(companyId);
      const secret = tenantDatabaseManager.createSecret(companyId);
      await tenantDatabaseManager.ensureDatabase(
        companyId,
        databaseName,
        secret,
      );
      const migrationDataSource = new DataSource(
        createTenantMigrationDataSourceOptions(
          tenantDatabaseManager.migrationCredentials(databaseName),
        ),
      );
      await migrationDataSource.initialize();
      await migrationDataSource.runMigrations({ transaction: 'all' });
      await tenantDatabaseManager.grantRuntimePrivileges(
        companyId,
        databaseName,
        secret,
      );
      const runtimeDataSource = new DataSource(
        createTenantRuntimeDataSourceOptions(
          tenantDatabaseManager.runtimeCredentials(
            companyId,
            databaseName,
            secret,
          ),
        ),
      );
      await runtimeDataSource.initialize();
      return {
        companyId,
        databaseName,
        secret,
        migrationDataSource,
        runtimeDataSource,
      };
    }

    function variantEvent(
      event: OfflinePattaCreateEvent,
      overrides: {
        eventId?: string;
        entityId?: string;
        partiyaNumber?: string;
        pattaNumber?: string;
      } = {},
    ): OfflinePattaCreateEvent {
      return {
        ...event,
        event_id: overrides.eventId ?? randomUUID(),
        entity_id: overrides.entityId ?? randomUUID(),
        payload: {
          ...event.payload,
          partiya_number:
            overrides.partiyaNumber ?? event.payload.partiya_number,
          patta_number: overrides.pattaNumber ?? event.payload.patta_number,
          operations: event.payload.operations.map((operation) => ({
            ...operation,
            id: randomUUID(),
          })),
        },
      };
    }

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

      const companyId = randomUUID();
      createdCompanyId = companyId;
      const databaseName = cleanup.trackCompany(companyId);
      await masterDataSource.query(
        `INSERT INTO "companies" ("id", "name", "slug", "status", "db_name")
         VALUES ($1, $2, $3, 'ACTIVE', $4)`,
        [
          companyId,
          `Sync test ${companyId}`,
          `sync-${companyId}`,
          databaseName,
        ],
      );

      const secret = tenantDatabaseManager.createSecret(companyId);
      await tenantDatabaseManager.ensureDatabase(
        companyId,
        databaseName,
        secret,
      );
      const migrationCredentials =
        tenantDatabaseManager.migrationCredentials(databaseName);
      const migrationDataSource = new DataSource(
        createTenantMigrationDataSourceOptions(migrationCredentials),
      );
      await migrationDataSource.initialize();
      await migrationDataSource.runMigrations({ transaction: 'all' });

      await tenantDatabaseManager.grantRuntimePrivileges(
        companyId,
        databaseName,
        secret,
      );
      const runtimeCredentials = tenantDatabaseManager.runtimeCredentials(
        companyId,
        databaseName,
        secret,
      );
      const runtimeDataSource = new DataSource(
        createTenantRuntimeDataSourceOptions(runtimeCredentials),
      );
      await runtimeDataSource.initialize();
      tenant = {
        companyId,
        databaseName,
        secret,
        migrationDataSource,
        runtimeDataSource,
      };
      await seedTenantPermissions(runtimeDataSource);
    }, 60_000);

    afterAll(async () => {
      if (tenant?.runtimeDataSource.isInitialized) {
        await tenant.runtimeDataSource.destroy();
      }
      if (tenant?.migrationDataSource.isInitialized) {
        await tenant.migrationDataSource.destroy();
      }
      await tenantDatabaseManager?.close();
      await cleanup?.cleanup();
      if (masterDataSource?.isInitialized) {
        if (createdCompanyId) {
          await masterDataSource.query(
            'DELETE FROM "companies" WHERE "id" = $1',
            [createdCompanyId],
          );
        }
        await masterDataSource.destroy();
      }
    }, 60_000);

    it('applies the additive sync schema and grants runtime sync access', async () => {
      const expectedTables = [
        'processed_sync_events',
        'server_change_log',
        'bootstrap_sessions',
        'bootstrap_items',
      ];
      const tableRows: TableNameRow[] = await tenant.migrationDataSource.query(
        `SELECT "table_name" FROM information_schema.tables
         WHERE "table_schema" = 'public' AND "table_name" = ANY($1::varchar[])
         ORDER BY "table_name"`,
        [expectedTables],
      );
      expect(tableRows.map(({ table_name }) => table_name)).toEqual(
        [...expectedTables].sort(),
      );

      const columns: ColumnRow[] = await tenant.migrationDataSource.query(
        `SELECT "column_name", "data_type" FROM information_schema.columns
         WHERE "table_schema" = 'public' AND "table_name" = 'processed_sync_events'`,
      );
      expect(columns).toEqual(
        expect.arrayContaining([
          { column_name: 'event_id', data_type: 'uuid' },
          { column_name: 'request_fingerprint', data_type: 'character' },
          { column_name: 'result_json', data_type: 'jsonb' },
          {
            column_name: 'processed_at',
            data_type: 'timestamp with time zone',
          },
        ]),
      );

      const indexes: ObjectNameRow[] = await tenant.migrationDataSource.query(
        `SELECT indexname AS object_name FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = ANY($1::varchar[])
         ORDER BY indexname`,
        [expectedTables],
      );
      expect(indexes.map(({ object_name }) => object_name)).toEqual(
        expect.arrayContaining([
          'ix_processed_sync_events_device_processed',
          'ix_server_change_log_entity',
          'uq_bootstrap_sessions_active_device',
          'ix_bootstrap_sessions_expiry',
        ]),
      );

      const constraints: ObjectNameRow[] =
        await tenant.migrationDataSource.query(
          `SELECT constraint_row.conname AS object_name
         FROM pg_constraint AS constraint_row
         INNER JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
         INNER JOIN pg_namespace AS schema_row ON schema_row.oid = table_row.relnamespace
         WHERE schema_row.nspname = 'public'
           AND table_row.relname = ANY($1::varchar[])
         ORDER BY constraint_row.conname`,
          [expectedTables],
        );
      expect(constraints.map(({ object_name }) => object_name)).toEqual(
        expect.arrayContaining([
          'pk_processed_sync_events',
          'ck_processed_sync_events_status',
          'pk_server_change_log',
          'ck_server_change_log_operation',
          'pk_bootstrap_sessions',
          'ck_bootstrap_sessions_watermark',
          'pk_bootstrap_items',
          'ck_bootstrap_items_order_key',
        ]),
      );

      const pattaColumns: ColumnRow[] = await tenant.migrationDataSource.query(
        `SELECT "column_name", "data_type" FROM information_schema.columns
         WHERE "table_schema" = 'public' AND "table_name" = 'patta_hisob'
           AND "column_name" IN ('client_created_at', 'occurred_at')
         ORDER BY "column_name"`,
      );
      expect(pattaColumns).toEqual([
        {
          column_name: 'client_created_at',
          data_type: 'timestamp with time zone',
        },
        { column_name: 'occurred_at', data_type: 'timestamp with time zone' },
      ]);

      const privileges: RuntimePrivilegeRow[] =
        await tenant.runtimeDataSource.query(
          `SELECT table_name,
                has_table_privilege(current_user, format('%I.%I', table_schema, table_name), 'SELECT') AS can_select,
                has_table_privilege(current_user, format('%I.%I', table_schema, table_name), 'INSERT') AS can_insert,
                has_table_privilege(current_user, format('%I.%I', table_schema, table_name), 'UPDATE') AS can_update,
                has_table_privilege(current_user, format('%I.%I', table_schema, table_name), 'DELETE') AS can_delete
         FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1::varchar[])
         ORDER BY table_name`,
          [expectedTables],
        );
      expect(privileges).toHaveLength(expectedTables.length);
      for (const privilege of privileges) {
        expect(privilege).toMatchObject({
          can_select: true,
          can_insert: true,
          can_update: true,
          can_delete: true,
        });
      }
    });

    it('reverts sync staging without touching source rows, then reapplies the migration', async () => {
      const sessionId = randomUUID();
      await tenant.migrationDataSource.query(
        `INSERT INTO "bootstrap_sessions" ("id", "device_id", "watermark", "expires_at")
         VALUES ($1, $2, 0, transaction_timestamp() + interval '30 minutes')`,
        [sessionId, randomUUID()],
      );
      await tenant.migrationDataSource.query(
        `INSERT INTO "bootstrap_items"
           ("session_id", "order_key", "entity_type", "entity_id", "projection_version", "payload_json")
         VALUES ($1, 1, 'workers', '1', 1, '{"id":"1"}'::jsonb)`,
        [sessionId],
      );
      await tenant.migrationDataSource.query(
        `INSERT INTO "workers" ("full_name") VALUES ('Bootstrap rollback sentinel')`,
      );

      await tenant.migrationDataSource.undoLastMigration({
        transaction: 'all',
      });
      const removedTables: TableNameRow[] =
        await tenant.migrationDataSource.query(
          `SELECT "table_name" FROM information_schema.tables
         WHERE "table_schema" = 'public'
           AND "table_name" IN ('processed_sync_events', 'server_change_log',
                                'bootstrap_sessions', 'bootstrap_items')`,
        );
      expect(removedTables).toEqual([]);

      const oldPattaColumns: ColumnRow[] =
        await tenant.migrationDataSource.query(
          `SELECT "column_name", "data_type" FROM information_schema.columns
         WHERE "table_schema" = 'public' AND "table_name" = 'patta_hisob'
           AND "column_name" IN ('client_created_at', 'occurred_at')`,
        );
      expect(oldPattaColumns).toEqual([]);
      const preservedWorkers: Array<{ count: string }> =
        await tenant.migrationDataSource.query(
          `SELECT count(*)::text AS "count" FROM "workers"
           WHERE "full_name" = 'Bootstrap rollback sentinel'`,
        );
      expect(preservedWorkers[0]?.count).toBe('1');

      const workerRows: Array<{ id: string }> =
        await tenant.migrationDataSource.query(
          `SELECT "id"::text AS "id" FROM "workers"
         WHERE "full_name" = 'Bootstrap rollback sentinel'`,
        );
      const workerId = workerRows[0]?.id;
      if (!workerId)
        throw new Error('Pre-sync migration worker fixture was not created');
      const modelId = randomUUID();
      await tenant.migrationDataSource.query(
        `INSERT INTO "models" ("id", "name") VALUES ($1::uuid, 'Pre-sync model')`,
        [modelId],
      );
      const operationId = randomUUID();
      await tenant.migrationDataSource.query(
        `INSERT INTO "model_operations" ("id", "model_id", "name", "price", "sort_order")
         VALUES ($1::uuid, $2::uuid, 'Pre-sync operation', 7.25, 0)`,
        [operationId, modelId],
      );
      await tenant.migrationDataSource.query(
        `INSERT INTO "model_operation_prices" ("operation_id", "price", "valid_from")
         VALUES ($1::uuid, 7.25, transaction_timestamp() - interval '1 day')`,
        [operationId],
      );
      await tenant.migrationDataSource.query(
        `INSERT INTO "worker_badge_history" ("badge_number", "worker_id", "valid_from")
         VALUES ('PRE-SYNC-1', $1::bigint, transaction_timestamp() - interval '1 day')`,
        [workerId],
      );
      const templateId = randomUUID();
      await tenant.migrationDataSource.query(
        `INSERT INTO "patta_templates" ("id", "name", "model_id", "konveyer")
         VALUES ($1::uuid, 'Pre-sync template', $2::uuid, 'Pre-sync line')`,
        [templateId, modelId],
      );
      const blockId = randomUUID();
      const deviceId = randomUUID();
      await tenant.migrationDataSource.query(
        `INSERT INTO "patta_number_blocks" ("id", "device_id", "range_start", "range_end")
         VALUES ($1::uuid, $2::uuid, 4000, 4999)`,
        [blockId, deviceId],
      );
      const pattaId = randomUUID();
      await tenant.migrationDataSource.query(
        `INSERT INTO "patta_hisob"
           ("id", "partiya_number", "patta_number", "model_id", "model_name_snapshot",
            "template_id", "konveyer_snapshot", "ish_soni", "created_device_id", "created_from_block_id")
         VALUES ($1::uuid, 'PRE-SYNC-PARTIYA', 4000, $2::uuid, 'Pre-sync model',
                  $3::uuid, 'Pre-sync line', 1, $4::uuid, NULL)`,
        [pattaId, modelId, templateId, deviceId],
      );
      await tenant.migrationDataSource.query(
        `INSERT INTO "patta_operation_snapshots"
           ("patta_hisob_id", "operation_id", "operation_name_snapshot", "unit_price_snapshot", "sort_order")
         VALUES ($1::uuid, $2::uuid, 'Pre-sync operation', 7.25, 0)`,
        [pattaId, operationId],
      );

      await tenant.migrationDataSource.runMigrations({ transaction: 'all' });
      const reappliedTables: TableNameRow[] =
        await tenant.migrationDataSource.query(
          `SELECT "table_name" FROM information_schema.tables
         WHERE "table_schema" = 'public' AND "table_name" = ANY($1::varchar[])
         ORDER BY "table_name"`,
          [
            [
              'processed_sync_events',
              'server_change_log',
              'bootstrap_sessions',
              'bootstrap_items',
            ],
          ],
        );
      expect(reappliedTables.map(({ table_name }) => table_name)).toEqual([
        'bootstrap_items',
        'bootstrap_sessions',
        'processed_sync_events',
        'server_change_log',
      ]);
      await tenantDatabaseManager.grantRuntimePrivileges(
        tenant.companyId,
        tenant.databaseName,
        tenant.secret,
      );
      const changesAfterMigration: Array<{ count: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT count(*)::text AS "count" FROM "server_change_log"`,
        );
      expect(changesAfterMigration[0]?.count).toBe('0');
      const bootstrapService = new SyncBootstrapService(
        loadSyncConfiguration({}),
      );
      const baselineDeviceId = randomUUID();
      const baseline = await bootstrapService.create(
        tenant.runtimeDataSource,
        baselineDeviceId,
      );
      const baselinePage = await bootstrapService.page(
        tenant.runtimeDataSource,
        baselineDeviceId,
        baseline.id,
        null,
        250,
      );
      expect(
        new Set(
          baselinePage.items.map(({ projection }) => projection.entity_type),
        ),
      ).toEqual(
        new Set([
          'workers',
          'worker_badge_history',
          'models',
          'model_operations',
          'model_operation_prices',
          'patta_templates',
          'patta_hisob',
          'patta_operation_snapshots',
          'patta_number_blocks',
        ]),
      );
      expect(
        baselinePage.items.find(
          ({ projection }) => projection.entity_type === 'models',
        )?.projection.entity_id,
      ).toBe(modelId);
      await bootstrapService.complete(
        tenant.runtimeDataSource,
        baselineDeviceId,
        baseline.id,
      );
    });

    it('enforces sync schema checks and a single active bootstrap session per device', async () => {
      await expect(
        tenant.runtimeDataSource.query(
          `INSERT INTO "processed_sync_events"
           ("event_id", "entity_type", "operation", "request_fingerprint", "result_status")
         VALUES ($1, 'patta', 'CREATE', repeat('z', 64), 'PROCESSING')`,
          [randomUUID()],
        ),
      ).rejects.toMatchObject({
        driverError: { constraint: 'ck_processed_sync_events_fingerprint' },
      });

      await expect(
        tenant.runtimeDataSource.query(
          `INSERT INTO "server_change_log"
           ("entity_type", "entity_id", "operation", "projection_version")
         VALUES ('patta', '1', 'INVALID', 1)`,
        ),
      ).rejects.toMatchObject({
        driverError: { constraint: 'ck_server_change_log_operation' },
      });

      await expect(
        tenant.runtimeDataSource.query(
          `INSERT INTO "server_change_log"
           ("entity_type", "entity_id", "operation", "projection_version", "payload_json")
         VALUES ('patta', '1', 'UPSERT', 1, NULL)`,
        ),
      ).rejects.toMatchObject({
        driverError: { constraint: 'ck_server_change_log_upsert_payload' },
      });

      const deviceId = randomUUID();
      const firstSessionId = randomUUID();
      await tenant.runtimeDataSource.query(
        `INSERT INTO "bootstrap_sessions" ("id", "device_id", "watermark", "expires_at")
         VALUES ($1, $2, 0, transaction_timestamp() + interval '30 minutes')`,
        [firstSessionId, deviceId],
      );
      await expect(
        tenant.runtimeDataSource.query(
          `INSERT INTO "bootstrap_sessions" ("id", "device_id", "watermark", "expires_at")
         VALUES ($1, $2, 0, transaction_timestamp() + interval '30 minutes')`,
          [randomUUID(), deviceId],
        ),
      ).rejects.toMatchObject({
        driverError: { constraint: 'uq_bootstrap_sessions_active_device' },
      });

      await tenant.runtimeDataSource.query(
        `UPDATE "bootstrap_sessions" SET "status" = 'EXPIRED' WHERE "id" = $1`,
        [firstSessionId],
      );
      await tenant.runtimeDataSource.query(
        `INSERT INTO "bootstrap_items"
           ("session_id", "order_key", "entity_type", "entity_id", "projection_version", "payload_json")
         VALUES ($1, 1, 'workers', '1', 1, '{"id":"1"}'::jsonb)`,
        [firstSessionId],
      );
      await expect(
        tenant.runtimeDataSource.query(
          `UPDATE "bootstrap_items" SET "payload_json" = '{"id":"changed"}'::jsonb
           WHERE "session_id" = $1`,
          [firstSessionId],
        ),
      ).rejects.toMatchObject({
        driverError: { constraint: 'trg_bootstrap_items_immutable' },
      });
      await expect(
        tenant.runtimeDataSource.query(
          `INSERT INTO "bootstrap_items"
           ("session_id", "order_key", "entity_type", "entity_id", "projection_version", "payload_json")
         VALUES ($1, 0, 'workers', '2', 1, '{"id":"2"}'::jsonb)`,
          [firstSessionId],
        ),
      ).rejects.toMatchObject({
        driverError: { constraint: 'ck_bootstrap_items_order_key' },
      });
      await tenant.runtimeDataSource.query(
        'DELETE FROM "bootstrap_sessions" WHERE "id" = $1',
        [firstSessionId],
      );

      const offlinePattaConstraint: ObjectNameRow[] =
        await tenant.migrationDataSource.query(
          `SELECT constraint_row.conname AS object_name
         FROM pg_constraint AS constraint_row
         WHERE constraint_row.conrelid = 'patta_hisob'::regclass
           AND constraint_row.conname = 'ck_patta_hisob_offline_timestamps'`,
        );
      expect(
        offlinePattaConstraint.map(({ object_name }) => object_name),
      ).toEqual(['ck_patta_hisob_offline_timestamps']);
    });

    it('requires processed-event reservations to finish and keeps event/change identities immutable', async () => {
      const unfinishedEventId = randomUUID();
      await expect(
        tenant.migrationDataSource.transaction(async (manager) => {
          await manager.query(
            `INSERT INTO "processed_sync_events"
             ("event_id", "entity_type", "operation", "request_fingerprint", "result_status")
           VALUES ($1, 'patta', 'CREATE', repeat('a', 64), 'PROCESSING')`,
            [unfinishedEventId],
          );
        }),
      ).rejects.toMatchObject({
        driverError: { constraint: 'ck_processed_sync_events_terminal' },
      });

      const eventId = randomUUID();
      await tenant.runtimeDataSource.transaction(async (manager) => {
        await manager.query(
          `INSERT INTO "processed_sync_events"
             ("event_id", "device_id", "user_id", "entity_type", "entity_id", "operation",
              "request_fingerprint", "result_status")
           VALUES ($1, $2, $3, 'patta', $4, 'CREATE', repeat('a', 64), 'PROCESSING')`,
          [eventId, randomUUID(), randomUUID(), randomUUID()],
        );
        await manager.query(
          `UPDATE "processed_sync_events"
           SET "result_status" = 'SYNCED', "result_json" = '{"status":"SYNCED"}'::jsonb
           WHERE "event_id" = $1`,
          [eventId],
        );
      });

      await expect(
        tenant.runtimeDataSource.query(
          `UPDATE "processed_sync_events" SET "result_json" = '{"status":"CONFLICT"}'::jsonb
         WHERE "event_id" = $1`,
          [eventId],
        ),
      ).rejects.toMatchObject({
        driverError: { constraint: 'trg_processed_sync_events_immutable' },
      });

      const changeRows: Array<{ sequence_id: string }> =
        await tenant.runtimeDataSource.query(
          `INSERT INTO "server_change_log"
           ("entity_type", "entity_id", "operation", "entity_version", "projection_version", "payload_json")
         VALUES ('patta', $1::varchar, 'UPSERT', '1', 1, jsonb_build_object('id', $1::varchar))
         RETURNING "sequence_id"::text AS "sequence_id"`,
          [randomUUID()],
        );
      expect(changeRows[0]?.sequence_id).toMatch(/^[1-9][0-9]*$/);
      await expect(
        tenant.runtimeDataSource.query(
          'DELETE FROM "server_change_log" WHERE "sequence_id" = $1::bigint',
          [changeRows[0]?.sequence_id],
        ),
      ).rejects.toMatchObject({
        driverError: { constraint: 'trg_server_change_log_append_only' },
      });
    });

    it('allows terminal bootstrap staging cleanup to cascade only into bootstrap items', async () => {
      const sessionId = randomUUID();
      await tenant.runtimeDataSource.query(
        `INSERT INTO "bootstrap_sessions" ("id", "device_id", "watermark", "expires_at")
         VALUES ($1, $2, 0, transaction_timestamp() + interval '30 minutes')`,
        [sessionId, randomUUID()],
      );
      await tenant.runtimeDataSource.query(
        `INSERT INTO "bootstrap_items"
           ("session_id", "order_key", "entity_type", "entity_id", "projection_version", "payload_json")
         VALUES ($1, 1, 'workers', '1', 1, '{"id":"1"}'::jsonb)`,
        [sessionId],
      );
      await tenant.runtimeDataSource.query(
        `UPDATE "bootstrap_sessions" SET "status" = 'EXPIRED' WHERE "id" = $1`,
        [sessionId],
      );
      await tenant.runtimeDataSource.query(
        'DELETE FROM "bootstrap_sessions" WHERE "id" = $1',
        [sessionId],
      );

      const stagingRows: Array<{ count: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT count(*)::text AS "count" FROM "bootstrap_items" WHERE "session_id" = $1`,
          [sessionId],
        );
      expect(stagingRows[0]?.count).toBe('0');
    });

    it('returns one persisted result and change sequence for ten serial duplicate deliveries', async () => {
      const fixture = await createOfflineEventFixture();
      const { processor } = createProcessor();
      const results: SyncPushResult[] = [];
      for (let index = 0; index < 10; index += 1) {
        results.push(
          await processor.process(
            tenant.runtimeDataSource,
            fixture.context,
            fixture.event,
          ),
        );
      }

      expect(results.map(({ status }) => status)).toEqual(
        Array(10).fill('SYNCED'),
      );
      expect(results.slice(1)).toEqual(Array(9).fill(results[0]));
      const pattaRows: Array<{ count: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT count(*)::text AS "count" FROM "patta_hisob" WHERE "id" = $1::uuid`,
          [fixture.event.entity_id],
        );
      const eventRows: Array<{ count: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT count(*)::text AS "count"
         FROM "processed_sync_events" WHERE "event_id" = $1::uuid`,
          [fixture.event.event_id],
        );
      const changeRows: Array<{ count: string; sequence_id: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT count(*)::text AS "count", min("sequence_id")::text AS "sequence_id"
         FROM "server_change_log" WHERE "entity_type" = 'patta_hisob' AND "entity_id" = $1::text`,
          [fixture.event.entity_id],
        );
      expect(pattaRows[0]?.count).toBe('1');
      expect(eventRows[0]?.count).toBe('1');
      expect(changeRows[0]?.count).toBe('1');
      expect(results[0]).toMatchObject({
        change_sequence: changeRows[0]?.sequence_id,
      });
    });

    it('serializes two concurrent deliveries of one event ID into one Patta and one result', async () => {
      const fixture = await createOfflineEventFixture();
      const { processor } = createProcessor();
      const results = await Promise.all([
        processor.process(
          tenant.runtimeDataSource,
          fixture.context,
          fixture.event,
        ),
        processor.process(
          tenant.runtimeDataSource,
          fixture.context,
          fixture.event,
        ),
      ]);
      expect(results.map(({ status }) => status)).toEqual(['SYNCED', 'SYNCED']);
      expect(results[0]).toEqual(results[1]);
      const counts: Array<{ pattas: string; events: string; changes: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT
             (SELECT count(*)::text FROM "patta_hisob" WHERE "id" = $1::uuid) AS "pattas",
             (SELECT count(*)::text FROM "processed_sync_events" WHERE "event_id" = $2::uuid) AS "events",
              (SELECT count(*)::text FROM "server_change_log" WHERE "entity_type" = 'patta_hisob' AND "entity_id" = $1::text) AS "changes"`,
          [fixture.event.entity_id, fixture.event.event_id],
        );
      expect(counts[0]).toEqual({ pattas: '1', events: '1', changes: '1' });
    });

    it('rejects event ID fingerprint reuse and replays stored conflict without reapplying the handler', async () => {
      const fixture = await createOfflineEventFixture();
      const { processor, handler } = createProcessor();
      const applySpy = vi.spyOn(handler, 'apply');
      const accepted = await processor.process(
        tenant.runtimeDataSource,
        fixture.context,
        fixture.event,
      );
      expect(accepted.status).toBe('SYNCED');
      const mismatched = {
        ...fixture.event,
        payload: {
          ...fixture.event.payload,
          patta_number: (
            BigInt(fixture.event.payload.patta_number) + 1n
          ).toString(),
        },
      };
      const mismatchResult = await processor.process(
        tenant.runtimeDataSource,
        fixture.context,
        mismatched,
      );
      expect(mismatchResult).toMatchObject({
        status: 'CONFLICT',
        conflict: { code: 'EVENT_ID_REUSE_MISMATCH' },
      });
      expect(applySpy).toHaveBeenCalledTimes(1);

      const duplicateBusinessKey = variantEvent(fixture.event, {
        partiyaNumber: fixture.event.payload.partiya_number,
        pattaNumber: fixture.event.payload.patta_number,
      });
      const firstConflict = await processor.process(
        tenant.runtimeDataSource,
        fixture.context,
        duplicateBusinessKey,
      );
      expect(firstConflict).toMatchObject({
        status: 'CONFLICT',
        conflict: { code: 'PATTA_ALREADY_EXISTS' },
      });
      const replayedConflicts = await Promise.all(
        Array.from({ length: 10 }, () =>
          processor.process(
            tenant.runtimeDataSource,
            fixture.context,
            duplicateBusinessKey,
          ),
        ),
      );
      expect(replayedConflicts).toEqual(Array(10).fill(firstConflict));
      expect(applySpy).toHaveBeenCalledTimes(2);
    });

    it('rolls back a PROCESSING reservation after an infrastructure failure so retry can apply', async () => {
      const fixture = await createOfflineEventFixture();
      let failOnce = true;
      const { processor } = createProcessor((handler) => ({
        supports: (entityType, operation) =>
          handler.supports(entityType, operation),
        apply: async (manager, context, event) => {
          if (failOnce) {
            failOnce = false;
            throw new Error('injected sync infrastructure failure');
          }
          return handler.apply(manager, context, event);
        },
      }));

      await expect(
        processor.process(
          tenant.runtimeDataSource,
          fixture.context,
          fixture.event,
        ),
      ).rejects.toThrow('injected sync infrastructure failure');
      const afterFailure: Array<{ events: string; pattas: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT
             (SELECT count(*)::text FROM "processed_sync_events" WHERE "event_id" = $1::uuid) AS "events",
             (SELECT count(*)::text FROM "patta_hisob" WHERE "id" = $2::uuid) AS "pattas"`,
          [fixture.event.event_id, fixture.event.entity_id],
        );
      expect(afterFailure[0]).toEqual({ events: '0', pattas: '0' });

      const retry = await processor.process(
        tenant.runtimeDataSource,
        fixture.context,
        fixture.event,
      );
      expect(retry.status).toBe('SYNCED');
      const afterRetry: Array<{ events: string; pattas: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT
             (SELECT count(*)::text FROM "processed_sync_events" WHERE "event_id" = $1::uuid) AS "events",
             (SELECT count(*)::text FROM "patta_hisob" WHERE "id" = $2::uuid) AS "pattas"`,
          [fixture.event.event_id, fixture.event.entity_id],
        );
      expect(afterRetry[0]).toEqual({ events: '1', pattas: '1' });
    });

    it('returns independent valid/conflict/valid outcomes and pulls change pages without gaps', async () => {
      const fixture = await createOfflineEventFixture();
      const { syncService } = createProcessor();
      const conflictEvent = variantEvent(fixture.event, {
        partiyaNumber: fixture.event.payload.partiya_number,
        pattaNumber: fixture.event.payload.patta_number,
      });
      const lastEvent = variantEvent(fixture.event, {
        partiyaNumber: `${fixture.event.payload.partiya_number}-SECOND`,
        pattaNumber: (
          BigInt(fixture.event.payload.patta_number) + 1n
        ).toString(),
      });

      const pushed = await syncService.push(
        {
          dataSource: tenant.runtimeDataSource,
          actorUserId: fixture.actorUserId,
          companyId: tenant.companyId,
        },
        fixture.deviceId,
        [fixture.event, conflictEvent, lastEvent],
      );
      expect(pushed.results.map(({ status }) => status)).toEqual([
        'SYNCED',
        'CONFLICT',
        'SYNCED',
      ]);

      const expectedRows: Array<{ sequence_id: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT "sequence_id"::text AS "sequence_id" FROM "server_change_log"
         WHERE "sequence_id" > $1::bigint ORDER BY "sequence_id"`,
          [fixture.event.reference_cursor],
        );
      const pulledSequences: string[] = [];
      let cursor = fixture.event.reference_cursor;
      let hasMore = true;
      while (hasMore) {
        const page = await syncService.pull(
          tenant.runtimeDataSource,
          cursor,
          2,
        );
        pulledSequences.push(
          ...page.changes.map(({ sequence_id }) => sequence_id),
        );
        cursor = page.next_cursor;
        hasMore = page.has_more;
      }
      expect(pulledSequences).toEqual(
        expectedRows.map(({ sequence_id }) => sequence_id),
      );
      expect(new Set(pulledSequences).size).toBe(pulledSequences.length);
    });

    it('materializes all nine versioned reference projections and serves stable keyset pages', async () => {
      const modelRows: Array<{ id: string }> =
        await tenant.runtimeDataSource.query(
          `INSERT INTO "models" ("name") VALUES ('Bootstrap Atlas') RETURNING "id"::text AS "id"`,
        );
      const modelId = modelRows[0]?.id;
      if (!modelId) throw new Error('Bootstrap model fixture was not created');
      const operationRows: Array<{ id: string }> =
        await tenant.runtimeDataSource.query(
          `INSERT INTO "model_operations" ("model_id", "name", "price", "sort_order")
         VALUES ($1::uuid, 'Bootstrap stitch', 10.00, 0) RETURNING "id"::text AS "id"`,
          [modelId],
        );
      const operationId = operationRows[0]?.id;
      if (!operationId)
        throw new Error('Bootstrap operation fixture was not created');
      await tenant.runtimeDataSource.query(
        `INSERT INTO "model_operation_prices" ("operation_id", "price", "valid_from")
         VALUES ($1::uuid, 10.00, transaction_timestamp() - interval '1 day')`,
        [operationId],
      );
      const workerRows: Array<{ id: string }> =
        await tenant.runtimeDataSource.query(
          `INSERT INTO "workers" ("full_name") VALUES ('Bootstrap Worker')
         RETURNING "id"::text AS "id"`,
        );
      const workerId = workerRows[0]?.id;
      if (!workerId)
        throw new Error('Bootstrap worker fixture was not created');
      await tenant.runtimeDataSource.query(
        `INSERT INTO "worker_badge_history" ("badge_number", "worker_id", "valid_from")
         VALUES ('BOOT-18', $1::bigint, transaction_timestamp() - interval '1 day')`,
        [workerId],
      );
      const templateRows: Array<{ id: string }> =
        await tenant.runtimeDataSource.query(
          `INSERT INTO "patta_templates" ("name", "model_id", "konveyer")
         VALUES ('Bootstrap template', $1::uuid, '1-konveyer')
         RETURNING "id"::text AS "id"`,
          [modelId],
        );
      const templateId = templateRows[0]?.id;
      if (!templateId)
        throw new Error('Bootstrap template fixture was not created');
      const blockId = randomUUID();
      await tenant.runtimeDataSource.query(
        `INSERT INTO "patta_number_blocks" ("id", "device_id", "range_start", "range_end")
         VALUES ($1::uuid, $2::uuid, 1000, 1999)`,
        [blockId, randomUUID()],
      );
      const pattaId = randomUUID();
      await tenant.runtimeDataSource.query(
        `INSERT INTO "patta_hisob"
           ("id", "partiya_number", "patta_number", "model_id", "model_name_snapshot",
            "template_id", "konveyer_snapshot", "ish_soni", "created_device_id")
         VALUES ($1::uuid, 'BOOTSTRAP-1', 1000, $2::uuid, 'Bootstrap Atlas',
                 $3::uuid, '1-konveyer', 1, $4::uuid)`,
        [pattaId, modelId, templateId, randomUUID()],
      );
      const snapshotId = randomUUID();
      await tenant.runtimeDataSource.query(
        `INSERT INTO "patta_operation_snapshots"
           ("id", "patta_hisob_id", "operation_id", "operation_name_snapshot", "unit_price_snapshot", "sort_order")
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Bootstrap stitch', 10.00, 0)`,
        [snapshotId, pattaId, operationId],
      );

      const roleRows: Array<{ id: string }> =
        await tenant.runtimeDataSource.query(
          `INSERT INTO "roles" ("name") VALUES ('Bootstrap private role') RETURNING "id"::text AS "id"`,
        );
      const roleId = roleRows[0]?.id;
      if (!roleId) throw new Error('Bootstrap role fixture was not created');
      const userRows: Array<{ id: string }> =
        await tenant.runtimeDataSource.query(
          `INSERT INTO "users" ("role_id", "email", "full_name", "password_hash")
         VALUES ($1::uuid, 'bootstrap-private@example.test', 'Bootstrap Private User', $2)
         RETURNING "id"::text AS "id"`,
          [roleId, 'test-only-password-hash-not-for-sync'],
        );
      const userId = userRows[0]?.id;
      if (!userId) throw new Error('Bootstrap user fixture was not created');
      await tenant.runtimeDataSource.query(
        `INSERT INTO "auth_sessions" ("user_id", "refresh_token_hash", "expires_at")
         VALUES ($1::uuid, repeat('a', 64), transaction_timestamp() + interval '1 day')`,
        [userId],
      );
      await tenant.runtimeDataSource.query(
        `INSERT INTO "audit_log"
           ("actor_user_id", "entity_type", "entity_id", "entity_key", "action", "after_json")
         VALUES ($1::uuid, 'model', $2::uuid, $2, 'model.create', '{"marker":"DO_NOT_SYNC"}'::jsonb)`,
        [userId, randomUUID()],
      );

      const service = new SyncBootstrapService(
        loadSyncConfiguration({ SYNC_BOOTSTRAP_PAGE_SIZE: '2' }),
      );
      const deviceId = randomUUID();
      const watermarkRows: Array<{ watermark: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT COALESCE(MAX("sequence_id"), 0)::text AS "watermark" FROM "server_change_log"`,
        );
      const session = await service.create(tenant.runtimeDataSource, deviceId);
      expect(session).toMatchObject({
        device_id: deviceId,
        watermark: watermarkRows[0]?.watermark,
        status: 'ACTIVE',
      });

      const items: Array<{
        order_key: string;
        projection: { entity_type: string; entity_id: string };
      }> = [];
      let after: string | null = null;
      let hasMore = true;
      while (hasMore) {
        const page = await service.page(
          tenant.runtimeDataSource,
          deviceId,
          session.id,
          after,
          2,
        );
        items.push(...page.items);
        after = page.next_order_key;
        hasMore = page.has_more;
      }

      expect(items.length).toBeGreaterThanOrEqual(10);
      expect(
        new Set(items.map(({ projection }) => projection.entity_type)),
      ).toEqual(
        new Set([
          'workers',
          'worker_badge_history',
          'models',
          'model_operations',
          'model_operation_prices',
          'patta_templates',
          'patta_hisob',
          'patta_operation_snapshots',
          'patta_number_blocks',
        ]),
      );
      expect(items.map(({ order_key }) => order_key)).toEqual(
        Array.from({ length: items.length }, (_, index) => String(index + 1)),
      );
      expect(
        items.find(
          ({ projection }) =>
            projection.entity_type === 'workers' &&
            projection.entity_id === workerId,
        )?.projection.entity_id,
      ).toBe(workerId);
      expect(
        items.find(
          ({ projection }) =>
            projection.entity_type === 'patta_hisob' &&
            projection.entity_id === pattaId,
        )?.projection.entity_id,
      ).toBe(pattaId);
      expect(JSON.stringify(items)).not.toMatch(
        /password_hash|auth_sessions|audit_log|platform_users/i,
      );

      await expect(
        service.page(
          tenant.runtimeDataSource,
          randomUUID(),
          session.id,
          null,
          2,
        ),
      ).rejects.toMatchObject({
        response: { code: 'SYNC_BOOTSTRAP_DEVICE_MISMATCH' },
      });
      await expect(
        service.complete(tenant.runtimeDataSource, deviceId, session.id),
      ).resolves.toEqual({
        session_id: session.id,
        status: 'COMPLETED',
      });
      await expect(
        service.complete(tenant.runtimeDataSource, deviceId, session.id),
      ).resolves.toEqual({
        session_id: session.id,
        status: 'COMPLETED',
      });
    });

    it('returns one immutable result for ten serial duplicate event deliveries', async () => {
      const fixture = await createOfflineEventFixture();
      const { processor } = createProcessor();
      const results: SyncPushResult[] = [];
      for (let index = 0; index < 10; index += 1) {
        results.push(
          await processor.process(
            tenant.runtimeDataSource,
            fixture.context,
            fixture.event,
          ),
        );
      }

      expect(results.map(({ status }) => status)).toEqual(
        Array(10).fill('SYNCED'),
      );
      expect(results.slice(1)).toEqual(Array(9).fill(results[0]));
      const rows: Array<{ pattas: string; events: string; changes: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT
             (SELECT count(*)::text FROM "patta_hisob" WHERE "id" = $1::uuid) AS "pattas",
              (SELECT count(*)::text FROM "processed_sync_events" WHERE "event_id" = $2::uuid) AS "events",
              (SELECT count(*)::text FROM "server_change_log"
               WHERE "entity_type" = 'patta_hisob' AND "entity_id" = $1::text) AS "changes"`,
          [fixture.event.entity_id, fixture.event.event_id],
        );
      expect(rows[0]).toEqual({ pattas: '1', events: '1', changes: '1' });
      expect(results[0]).toMatchObject({ change_sequence: expect.any(String) });
    });

    it('serializes two concurrent deliveries of one event ID without duplicate business writes', async () => {
      const fixture = await createOfflineEventFixture();
      const { processor } = createProcessor();
      const results = await Promise.all([
        processor.process(
          tenant.runtimeDataSource,
          fixture.context,
          fixture.event,
        ),
        processor.process(
          tenant.runtimeDataSource,
          fixture.context,
          fixture.event,
        ),
      ]);
      expect(results.map(({ status }) => status)).toEqual(['SYNCED', 'SYNCED']);
      expect(results[0]).toEqual(results[1]);
      const rows: Array<{ pattas: string; events: string; changes: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT
             (SELECT count(*)::text FROM "patta_hisob" WHERE "id" = $1::uuid) AS "pattas",
              (SELECT count(*)::text FROM "processed_sync_events" WHERE "event_id" = $2::uuid) AS "events",
              (SELECT count(*)::text FROM "server_change_log"
               WHERE "entity_type" = 'patta_hisob' AND "entity_id" = $1::text) AS "changes"`,
          [fixture.event.entity_id, fixture.event.event_id],
        );
      expect(rows[0]).toEqual({ pattas: '1', events: '1', changes: '1' });
    });

    it('rejects event ID fingerprint reuse and replays a stored business conflict without handler reapplication', async () => {
      const fixture = await createOfflineEventFixture();
      const { processor, handler } = createProcessor();
      const applySpy = vi.spyOn(handler, 'apply');
      const first = await processor.process(
        tenant.runtimeDataSource,
        fixture.context,
        fixture.event,
      );
      expect(first.status).toBe('SYNCED');

      const changedFingerprint = {
        ...fixture.event,
        payload: {
          ...fixture.event.payload,
          patta_number: (
            BigInt(fixture.event.payload.patta_number) + 1n
          ).toString(),
        },
      };
      const reuse = await processor.process(
        tenant.runtimeDataSource,
        fixture.context,
        changedFingerprint,
      );
      expect(reuse).toMatchObject({
        status: 'CONFLICT',
        conflict: { code: 'EVENT_ID_REUSE_MISMATCH' },
      });
      expect(applySpy).toHaveBeenCalledTimes(1);

      const conflictEvent = variantEvent(fixture.event, {
        partiyaNumber: fixture.event.payload.partiya_number,
        pattaNumber: fixture.event.payload.patta_number,
      });
      const conflict = await processor.process(
        tenant.runtimeDataSource,
        fixture.context,
        conflictEvent,
      );
      expect(conflict).toMatchObject({
        status: 'CONFLICT',
        conflict: { code: 'PATTA_ALREADY_EXISTS' },
      });
      const retries = await Promise.all(
        Array.from({ length: 10 }, () =>
          processor.process(
            tenant.runtimeDataSource,
            fixture.context,
            conflictEvent,
          ),
        ),
      );
      expect(retries).toEqual(Array(10).fill(conflict));
      expect(applySpy).toHaveBeenCalledTimes(2);
    });

    it('rolls back an unfinished PROCESSING reservation after infrastructure failure and retries once', async () => {
      const fixture = await createOfflineEventFixture();
      let failOnce = true;
      const { processor } = createProcessor((handler) => ({
        supports: (entityType, operation) =>
          handler.supports(entityType, operation),
        apply: async (manager, context, event) => {
          if (failOnce) {
            failOnce = false;
            throw new Error('injected sync infrastructure failure');
          }
          return handler.apply(manager, context, event);
        },
      }));

      await expect(
        processor.process(
          tenant.runtimeDataSource,
          fixture.context,
          fixture.event,
        ),
      ).rejects.toThrow('injected sync infrastructure failure');
      const afterFailure: Array<{ events: string; pattas: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT
             (SELECT count(*)::text FROM "processed_sync_events" WHERE "event_id" = $1::uuid) AS "events",
             (SELECT count(*)::text FROM "patta_hisob" WHERE "id" = $2::uuid) AS "pattas"`,
          [fixture.event.event_id, fixture.event.entity_id],
        );
      expect(afterFailure[0]).toEqual({ events: '0', pattas: '0' });

      expect(
        (
          await processor.process(
            tenant.runtimeDataSource,
            fixture.context,
            fixture.event,
          )
        ).status,
      ).toBe('SYNCED');
      const afterRetry: Array<{ events: string; pattas: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT
             (SELECT count(*)::text FROM "processed_sync_events" WHERE "event_id" = $1::uuid) AS "events",
             (SELECT count(*)::text FROM "patta_hisob" WHERE "id" = $2::uuid) AS "pattas"`,
          [fixture.event.event_id, fixture.event.entity_id],
        );
      expect(afterRetry[0]).toEqual({ events: '1', pattas: '1' });
    });

    it('returns partial valid/conflict/valid outcomes and pulls change pages without gaps', async () => {
      const fixture = await createOfflineEventFixture();
      const { syncService } = createProcessor();
      const conflictEvent = variantEvent(fixture.event, {
        partiyaNumber: fixture.event.payload.partiya_number,
        pattaNumber: fixture.event.payload.patta_number,
      });
      const finalEvent = variantEvent(fixture.event, {
        partiyaNumber: `${fixture.event.payload.partiya_number}-SECOND`,
        pattaNumber: (
          BigInt(fixture.event.payload.patta_number) + 1n
        ).toString(),
      });
      const response = await syncService.push(
        {
          dataSource: tenant.runtimeDataSource,
          actorUserId: fixture.actorUserId,
          companyId: tenant.companyId,
        },
        fixture.deviceId,
        [fixture.event, conflictEvent, finalEvent],
      );
      expect(response.results.map(({ status }) => status)).toEqual([
        'SYNCED',
        'CONFLICT',
        'SYNCED',
      ]);

      const expectedRows: Array<{ sequence_id: string }> =
        await tenant.runtimeDataSource.query(
          `SELECT "sequence_id"::text AS "sequence_id" FROM "server_change_log"
         WHERE "sequence_id" > $1::bigint ORDER BY "sequence_id"`,
          [fixture.event.reference_cursor],
        );
      const pulledSequences: string[] = [];
      let cursor = fixture.event.reference_cursor;
      let hasMore = true;
      while (hasMore) {
        const page = await syncService.pull(
          tenant.runtimeDataSource,
          cursor,
          2,
        );
        pulledSequences.push(
          ...page.changes.map(({ sequence_id }) => sequence_id),
        );
        cursor = page.next_cursor;
        hasMore = page.has_more;
      }
      expect(pulledSequences).toEqual(
        expectedRows.map(({ sequence_id }) => sequence_id),
      );
      expect(new Set(pulledSequences).size).toBe(pulledSequences.length);
    });

    it('keeps overlapping worker/model/Patta identities isolated across two tenant databases', async () => {
      const secondTenant = await createGeneratedTenantFixture();
      try {
        const existingWorkerRows: Array<{ id: string }> =
          await tenant.runtimeDataSource.query(
            `SELECT "id"::text AS "id" FROM "workers"
           WHERE "full_name" = 'Bootstrap Worker' LIMIT 1`,
          );
        const sharedWorkerId = existingWorkerRows[0]?.id;
        if (!sharedWorkerId)
          throw new Error('Shared worker fixture is missing from tenant one');

        const modelId = randomUUID();
        const operationId = randomUUID();
        const priceId = randomUUID();
        const templateId = randomUUID();
        const blockId = randomUUID();
        const pattaId = randomUUID();
        const snapshotId = randomUUID();
        const primaryDeviceId = randomUUID();
        const secondaryDeviceId = randomUUID();
        const partiyaNumber = `OVERLAP-${randomUUID()}`;
        const pattaNumber = '3000000';

        await secondTenant.runtimeDataSource.query(
          `INSERT INTO "workers" ("id", "full_name", "status")
           OVERRIDING SYSTEM VALUE VALUES ($1::bigint, 'Bootstrap Worker', 'INACTIVE')`,
          [sharedWorkerId],
        );

        const seedOverlappingBusinessRows = async (
          dataSource: DataSource,
          modelName: string,
          conveyor: string,
          operationPrice: string,
          workerStatus: 'ACTIVE' | 'INACTIVE',
          deviceId: string,
        ): Promise<void> => {
          await dataSource.query(
            `INSERT INTO "models" ("id", "name", "status") VALUES ($1::uuid, $2, 'ACTIVE')`,
            [modelId, modelName],
          );
          await dataSource.query(
            `INSERT INTO "model_operations" ("id", "model_id", "name", "price", "sort_order")
             VALUES ($1::uuid, $2::uuid, 'Overlap operation', $3::numeric, 0)`,
            [operationId, modelId, operationPrice],
          );
          await dataSource.query(
            `INSERT INTO "model_operation_prices" ("id", "operation_id", "price", "valid_from")
             VALUES ($1::uuid, $2::uuid, $3::numeric, transaction_timestamp() - interval '1 day')`,
            [priceId, operationId, operationPrice],
          );
          await dataSource.query(
            `UPDATE "workers" SET "status" = $1 WHERE "id" = $2::bigint`,
            [workerStatus, sharedWorkerId],
          );
          await dataSource.query(
            `INSERT INTO "worker_badge_history" ("id", "badge_number", "worker_id", "valid_from")
             VALUES ($1::uuid, 'OVERLAP-BADGE', $2::bigint, transaction_timestamp() - interval '1 day')`,
            [randomUUID(), sharedWorkerId],
          );
          await dataSource.query(
            `INSERT INTO "patta_templates" ("id", "name", "model_id", "konveyer")
             VALUES ($1::uuid, 'Overlap template', $2::uuid, $3)`,
            [templateId, modelId, conveyor],
          );
          await dataSource.query(
            `INSERT INTO "patta_number_blocks" ("id", "device_id", "range_start", "range_end")
             VALUES ($1::uuid, $2::uuid, 3000000, 3000999)`,
            [blockId, deviceId],
          );
          await dataSource.query(
            `INSERT INTO "patta_hisob"
             ("id", "partiya_number", "patta_number", "model_id", "model_name_snapshot",
                "template_id", "konveyer_snapshot", "ish_soni", "created_device_id", "created_from_block_id",
                "client_created_at", "occurred_at")
             VALUES ($1::uuid, $2, $3::bigint, $4::uuid, $5, $6::uuid, $7, 1, $8::uuid, $9::uuid,
                     transaction_timestamp(), transaction_timestamp())`,
            [
              pattaId,
              partiyaNumber,
              pattaNumber,
              modelId,
              modelName,
              templateId,
              conveyor,
              deviceId,
              blockId,
            ],
          );
          await dataSource.query(
            `INSERT INTO "patta_operation_snapshots"
               ("id", "patta_hisob_id", "operation_id", "operation_name_snapshot",
                "unit_price_snapshot", "sort_order")
             VALUES ($1::uuid, $2::uuid, $3::uuid, 'Overlap operation', $4::numeric, 0)`,
            [snapshotId, pattaId, operationId, operationPrice],
          );
        };

        await seedOverlappingBusinessRows(
          tenant.runtimeDataSource,
          'Tenant One Model',
          'Tenant One Line',
          '1.00',
          'ACTIVE',
          primaryDeviceId,
        );
        await seedOverlappingBusinessRows(
          secondTenant.runtimeDataSource,
          'Tenant Two Model',
          'Tenant Two Line',
          '2.00',
          'INACTIVE',
          secondaryDeviceId,
        );

        const bootstrapService = new SyncBootstrapService(
          loadSyncConfiguration({}),
        );
        const [primarySession, secondarySession] = await Promise.all([
          bootstrapService.create(tenant.runtimeDataSource, primaryDeviceId),
          bootstrapService.create(
            secondTenant.runtimeDataSource,
            secondaryDeviceId,
          ),
        ]);
        const collectItems = async (
          dataSource: DataSource,
          deviceId: string,
          sessionId: string,
        ) => {
          const items: Array<{ projection: SyncProjection }> = [];
          let after: string | null = null;
          let hasMore = true;
          while (hasMore) {
            const page = await bootstrapService.page(
              dataSource,
              deviceId,
              sessionId,
              after,
              250,
            );
            items.push(...page.items);
            after = page.next_order_key;
            hasMore = page.has_more;
          }
          return items;
        };
        const [primaryItems, secondaryItems] = await Promise.all([
          collectItems(
            tenant.runtimeDataSource,
            primaryDeviceId,
            primarySession.id,
          ),
          collectItems(
            secondTenant.runtimeDataSource,
            secondaryDeviceId,
            secondarySession.id,
          ),
        ]);
        const primaryModels = primaryItems.filter(
          ({ projection }) =>
            projection.entity_type === 'models' &&
            projection.entity_id === modelId,
        );
        const secondaryModels = secondaryItems.filter(
          ({ projection }) =>
            projection.entity_type === 'models' &&
            projection.entity_id === modelId,
        );
        expect(JSON.stringify(primaryModels)).toContain('Tenant One Model');
        expect(JSON.stringify(primaryModels)).not.toContain('Tenant Two Model');
        expect(JSON.stringify(secondaryModels)).toContain('Tenant Two Model');
        expect(JSON.stringify(secondaryModels)).not.toContain(
          'Tenant One Model',
        );
        expect(
          JSON.stringify(
            primaryItems.filter(
              ({ projection }) =>
                projection.entity_type === 'workers' &&
                projection.entity_id === sharedWorkerId,
            ),
          ),
        ).toContain('ACTIVE');
        expect(
          JSON.stringify(
            secondaryItems.filter(
              ({ projection }) =>
                projection.entity_type === 'workers' &&
                projection.entity_id === sharedWorkerId,
            ),
          ),
        ).toContain('INACTIVE');
        expect(
          JSON.stringify(
            primaryItems.filter(
              ({ projection }) =>
                projection.entity_type === 'patta_operation_snapshots' &&
                projection.entity_id === snapshotId,
            ),
          ),
        ).toContain('1.00');
        expect(
          JSON.stringify(
            secondaryItems.filter(
              ({ projection }) =>
                projection.entity_type === 'patta_operation_snapshots' &&
                projection.entity_id === snapshotId,
            ),
          ),
        ).toContain('2.00');

        const recorder = new SyncChangeRecorder();
        const updateModelInTenant = async (
          dataSource: DataSource,
          name: string,
        ): Promise<void> => {
          await dataSource.transaction(async (manager) => {
            const updateResult: [
              Array<{
                id: string;
                status: 'ACTIVE' | 'INACTIVE';
                version: string;
                created_at: string;
                updated_at: string;
              }>,
              number,
            ] = await manager.query(
              `UPDATE "models" SET "name" = $1, "version" = "version" + 1,
                 "updated_at" = transaction_timestamp()
               WHERE "id" = $2::uuid
               RETURNING "id"::text AS "id", "status", "version"::text AS "version",
                 to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
                 to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at"`,
              [name, modelId],
            );
            const row = updateResult[0][0];
            if (!row)
              throw new Error('Tenant model update fixture disappeared');
            const modelProjection = createSyncProjection({
              entityType: 'models',
              entityVersion: row.version,
              data: {
                id: row.id,
                name,
                status: row.status,
                version: row.version,
                created_at: row.created_at,
                updated_at: row.updated_at,
              },
            });
            await recorder.record(manager, {
              entityType: 'models',
              entityId: modelId,
              operation: 'UPSERT',
              entityVersion: row.version,
              projectionVersion: 1,
              payload: modelProjection,
            });
          });
        };
        await Promise.all([
          updateModelInTenant(tenant.runtimeDataSource, 'Tenant One Updated'),
          updateModelInTenant(
            secondTenant.runtimeDataSource,
            'Tenant Two Updated',
          ),
        ]);
        const { syncService } = createProcessor();
        const [primaryPull, secondaryPull] = await Promise.all([
          syncService.pull(
            tenant.runtimeDataSource,
            primarySession.watermark,
            100,
          ),
          syncService.pull(
            secondTenant.runtimeDataSource,
            secondarySession.watermark,
            100,
          ),
        ]);
        expect(JSON.stringify(primaryPull.changes)).toContain(
          'Tenant One Updated',
        );
        expect(JSON.stringify(primaryPull.changes)).not.toContain(
          'Tenant Two Updated',
        );
        expect(JSON.stringify(secondaryPull.changes)).toContain(
          'Tenant Two Updated',
        );
        expect(JSON.stringify(secondaryPull.changes)).not.toContain(
          'Tenant One Updated',
        );
        await Promise.all([
          bootstrapService.complete(
            tenant.runtimeDataSource,
            primaryDeviceId,
            primarySession.id,
          ),
          bootstrapService.complete(
            secondTenant.runtimeDataSource,
            secondaryDeviceId,
            secondarySession.id,
          ),
        ]);
      } finally {
        if (secondTenant.runtimeDataSource.isInitialized)
          await secondTenant.runtimeDataSource.destroy();
        if (secondTenant.migrationDataSource.isInitialized)
          await secondTenant.migrationDataSource.destroy();
      }
    });

    it('releases the global change lock before snapshot materialization and preserves before/after-watermark changes', async () => {
      const modelId = randomUUID();
      await tenant.runtimeDataSource.query(
        `INSERT INTO "models" ("id", "name") VALUES ($1::uuid, 'Barrier initial model')`,
        [modelId],
      );
      const recorder = new SyncChangeRecorder();
      const updateModel = async (name: string): Promise<string> =>
        tenant.runtimeDataSource.transaction(async (manager) => {
          await manager.query(
            `UPDATE "models" SET "name" = $1, "version" = "version" + 1,
               "updated_at" = transaction_timestamp() WHERE "id" = $2::uuid`,
            [name, modelId],
          );
          const rows: Array<{
            id: string;
            status: 'ACTIVE' | 'INACTIVE';
            version: string;
            created_at: string;
            updated_at: string;
          }> = await manager.query(
            `SELECT "id"::text AS "id", "status", "version"::text AS "version",
                    to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
                    to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at"
             FROM "models" WHERE "id" = $1::uuid`,
            [modelId],
          );
          const row = rows[0];
          if (!row)
            throw new Error('Bootstrap barrier model fixture disappeared');
          const projection = createSyncProjection({
            entityType: 'models',
            entityVersion: row.version,
            data: {
              id: row.id,
              name,
              status: row.status,
              version: row.version,
              created_at: row.created_at,
              updated_at: row.updated_at,
            },
          });
          const recorded = await recorder.record(manager, {
            entityType: 'models',
            entityId: modelId,
            operation: 'UPSERT',
            entityVersion: row.version,
            projectionVersion: 1,
            payload: projection,
          });
          return recorded.sequenceId;
        });

      const beforeWatermarkSequence = await updateModel(
        'Before watermark model',
      );
      const barrierRunner = tenant.runtimeDataSource.createQueryRunner();
      await barrierRunner.connect();
      await barrierRunner.startTransaction('READ COMMITTED');
      const lockClass = 1_234_567;
      const lockObject = 890_123;
      await barrierRunner.query(
        'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
        [lockClass, lockObject],
      );
      await tenant.migrationDataSource.query(`
        CREATE OR REPLACE FUNCTION "test_sync_projection_barrier"()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW."entity_type" = 'models' THEN
            PERFORM pg_advisory_xact_lock(${lockClass}, ${lockObject});
          END IF;
          RETURN NEW;
        END
        $$
      `);
      await tenant.migrationDataSource.query(`
        CREATE TRIGGER "test_sync_projection_barrier"
        BEFORE INSERT ON "bootstrap_items"
        FOR EACH ROW EXECUTE FUNCTION "test_sync_projection_barrier"()
      `);

      const bootstrapService = new SyncBootstrapService(
        loadSyncConfiguration({}),
      );
      const deviceId = randomUUID();
      let bootstrapPromise:
        ReturnType<SyncBootstrapService['create']> | undefined;
      let writerPromise: Promise<string> | undefined;
      let writerCompletedWhileProjectionWasBlocked = false;
      try {
        bootstrapPromise = bootstrapService.create(
          tenant.runtimeDataSource,
          deviceId,
        );
        let barrierObserved = false;
        const barrierDeadline = Date.now() + 5_000;
        while (Date.now() < barrierDeadline) {
          const waitingRows: Array<{ waiting: boolean }> =
            await tenant.runtimeDataSource.query(
              `SELECT EXISTS (
               SELECT 1 FROM pg_locks
               WHERE "locktype" = 'advisory' AND NOT "granted"
                 AND "classid" = $1::oid AND "objid" = $2::oid AND "objsubid" = 2
             ) AS "waiting"`,
              [lockClass, lockObject],
            );
          if (waitingRows[0]?.waiting === true) {
            barrierObserved = true;
            break;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
        expect(barrierObserved).toBe(true);
        writerPromise = updateModel('After watermark model');
        writerCompletedWhileProjectionWasBlocked = await Promise.race([
          writerPromise.then(() => true),
          new Promise<boolean>((resolveWait) =>
            setTimeout(() => resolveWait(false), 1_000),
          ),
        ]);
      } finally {
        if (barrierRunner.isTransactionActive)
          await barrierRunner.rollbackTransaction();
        await barrierRunner.release();
        if (bootstrapPromise) await bootstrapPromise.catch(() => undefined);
        if (writerPromise) await writerPromise.catch(() => undefined);
        await tenant.migrationDataSource.query(
          'DROP TRIGGER IF EXISTS "test_sync_projection_barrier" ON "bootstrap_items"',
        );
        await tenant.migrationDataSource.query(
          'DROP FUNCTION IF EXISTS "test_sync_projection_barrier"()',
        );
      }

      expect(writerCompletedWhileProjectionWasBlocked).toBe(true);
      if (!bootstrapPromise)
        throw new Error('Bootstrap barrier did not start a session');
      const session = await bootstrapPromise;
      expect(BigInt(session.watermark)).toBe(BigInt(beforeWatermarkSequence));
      const page = await bootstrapService.page(
        tenant.runtimeDataSource,
        deviceId,
        session.id,
        null,
        250,
      );
      const snapshotModel = page.items.find(
        ({ projection }) =>
          projection.entity_type === 'models' &&
          projection.entity_id === modelId,
      )?.projection;
      expect(snapshotModel).toMatchObject({
        entity_type: 'models',
        data: { name: 'Before watermark model' },
      });
      const afterWatermarkPull = await createProcessor().syncService.pull(
        tenant.runtimeDataSource,
        session.watermark,
        250,
      );
      expect(afterWatermarkPull.changes).toContainEqual(
        expect.objectContaining({
          entity_type: 'models',
          entity_id: modelId,
          operation: 'UPSERT',
          payload: expect.objectContaining({
            entity_type: 'models',
            data: expect.objectContaining({ name: 'After watermark model' }),
          }),
        }),
      );
      await bootstrapService.complete(
        tenant.runtimeDataSource,
        deviceId,
        session.id,
      );
    });

    it('runs the real authenticated HTTP API against two Electron SQLite clients', async () => {
      const cipherKey = randomBytes(32).toString('base64url');
      const environment: Record<string, string> = {
        MASTER_DB_HOST: process.env.TEST_MASTER_DB_HOST ?? '',
        MASTER_DB_PORT: process.env.TEST_MASTER_DB_PORT ?? '',
        MASTER_DB_NAME: process.env.TEST_MASTER_DB_NAME ?? '',
        MASTER_DB_USER: process.env.TEST_MASTER_DB_USER ?? '',
        MASTER_DB_PASSWORD: process.env.TEST_MASTER_DB_PASSWORD ?? '',
        TENANT_PROVISIONER_DB_HOST: provisionerCredentials.host,
        TENANT_PROVISIONER_DB_PORT: String(provisionerCredentials.port),
        TENANT_PROVISIONER_DB_NAME: provisionerCredentials.database,
        TENANT_PROVISIONER_DB_USER: provisionerCredentials.username,
        TENANT_PROVISIONER_DB_PASSWORD: provisionerCredentials.password,
        TENANT_DB_HOST: provisionerCredentials.host,
        TENANT_DB_PORT: String(provisionerCredentials.port),
        TENANT_CONNECTION_ENCRYPTION_KEY: cipherKey,
        PLATFORM_JWT_ACCESS_SECRET:
          'task16-platform-access-secret-for-test-only-0001',
        PLATFORM_JWT_REFRESH_SECRET:
          'task16-platform-refresh-secret-for-test-only-0002',
        TENANT_JWT_ACCESS_SECRET:
          'task16-tenant-access-secret-for-test-only-000003',
        TENANT_JWT_REFRESH_SECRET:
          'task16-tenant-refresh-secret-for-test-only-000004',
        AUTH_LOGIN_BUCKET_HASH_SECRET:
          'task16-login-bucket-hash-secret-for-test-only-00005',
      };
      const previousEnvironment = new Map<string, string | undefined>();
      let apiApp: INestApplication | undefined;
      const createdDeviceIds: string[] = [];
      for (const [key, value] of Object.entries(environment)) {
        previousEnvironment.set(key, process.env[key]);
        process.env[key] = value;
      }
      const localDataDirectory = mkdtempSync(
        join(tmpdir(), 'textile-erp-two-pc-'),
      );
      try {
        const authSessionId = randomUUID();
        const authUserId = randomUUID();
        const devicePc1 = randomUUID();
        const devicePc2 = randomUUID();
        createdDeviceIds.push(devicePc1, devicePc2);
        const tenantSlugRows: Array<{ slug: string }> =
          await masterDataSource.query(
            'SELECT "slug" FROM "companies" WHERE "id" = $1',
            [tenant.companyId],
          );
        const tenantSlug = tenantSlugRows[0]?.slug;
        if (!tenantSlug)
          throw new Error('Two-PC tenant company slug is missing');

        const secretCipher = new AesGcmTenantConnectionSecretCipher(
          Buffer.from(cipherKey, 'base64url'),
        );
        const encryptedTenantSecret = await secretCipher.encrypt(
          JSON.stringify(tenant.secret),
        );
        await masterDataSource.query(
          'UPDATE "companies" SET "db_connection_ciphertext" = $1 WHERE "id" = $2',
          [encryptedTenantSecret, tenant.companyId],
        );

        const connectionIds = [devicePc1, devicePc2];
        for (const [index, deviceId] of connectionIds.entries()) {
          await masterDataSource.query(
            `INSERT INTO "devices"
               ("id", "company_id", "installation_id", "hardware_fingerprint_hash",
                "device_name", "status", "first_seen_at", "last_seen_at")
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'ACTIVE', now(), now())`,
            [
              deviceId,
              tenant.companyId,
              randomUUID(),
              `two-pc-fingerprint-${randomUUID()}`,
              `Sync PC ${index + 1}`,
            ],
          );
        }

        const roleRows: Array<{ id: string }> =
          await tenant.runtimeDataSource.query(
            `SELECT "id"::text AS "id" FROM "roles" WHERE "name" = $1`,
            [TENANT_ADMIN_ROLE_NAME],
          );
        const roleId = roleRows[0]?.id;
        if (!roleId)
          throw new Error('Two-PC tenant administrator role is missing');
        await tenant.runtimeDataSource.query(
          `INSERT INTO "users" ("id", "role_id", "email", "full_name", "password_hash")
           VALUES ($1::uuid, $2::uuid, $3, 'Two PC Sync Actor', 'test-only-password-hash')`,
          [authUserId, roleId, `two-pc-${authUserId}@example.test`],
        );
        await tenant.runtimeDataSource.query(
          `INSERT INTO "auth_sessions" ("id", "user_id", "refresh_token_hash", "expires_at")
           VALUES ($1::uuid, $2::uuid, repeat('b', 64), now() + interval '10 minutes')`,
          [authSessionId, authUserId],
        );

        const modelRows: Array<{ id: string }> =
          await tenant.runtimeDataSource.query(
            `INSERT INTO "models" ("name") VALUES ($1) RETURNING "id"::text AS "id"`,
            [`Two PC Model ${randomUUID()}`],
          );
        const modelId = modelRows[0]?.id;
        if (!modelId) throw new Error('Two-PC model fixture was not created');
        const operationRows: Array<{ id: string }> =
          await tenant.runtimeDataSource.query(
            `INSERT INTO "model_operations" ("model_id", "name", "price", "sort_order")
           VALUES ($1::uuid, 'Two PC stitch', 12.50, 0) RETURNING "id"::text AS "id"`,
            [modelId],
          );
        const operationId = operationRows[0]?.id;
        if (!operationId)
          throw new Error('Two-PC operation fixture was not created');
        await tenant.runtimeDataSource.query(
          `INSERT INTO "model_operation_prices" ("operation_id", "price", "valid_from")
           VALUES ($1::uuid, 12.50, now() - interval '1 day')`,
          [operationId],
        );
        await tenant.runtimeDataSource.query(
          `INSERT INTO "patta_number_sequence" ("id", "next_number", "version")
           VALUES (1, 1, 1) ON CONFLICT ("id") DO NOTHING`,
        );

        const authConfiguration = loadAuthConfiguration(process.env);
        const tenantToken = await new JwtTokenService().sign(
          {
            sub: authUserId,
            session_id: authSessionId,
            jti: randomUUID(),
            scope: 'tenant',
            token_type: 'access',
            company_id: tenant.companyId,
          },
          {
            secret: authConfiguration.tenant.accessSecret,
            issuer: authConfiguration.tenant.issuer,
            audience: authConfiguration.tenant.audience,
            expiresInSeconds: 600,
          },
        );

        const { AppModule } = await import('../../app.module.js');
        const testingModule = await Test.createTestingModule({
          imports: [AppModule],
        })
          .overrideProvider(TenantDatabaseManager)
          .useValue(tenantDatabaseManager)
          .compile();
        apiApp = testingModule.createNestApplication();
        apiApp.use(
          (request: Request, _response: Response, next: NextFunction) => {
            request.headers.host = `${tenantSlug}.factory.test`;
            next();
          },
        );
        apiApp.useGlobalPipes(
          new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            forbidUnknownValues: true,
            transform: true,
          }),
        );
        apiApp.useGlobalFilters(new StructuredApiExceptionFilter());
        await apiApp.listen(0, '127.0.0.1');
        const apiAddress = apiApp.getHttpServer().address();
        if (!apiAddress || typeof apiAddress === 'string') {
          throw new Error(
            'Two-PC API listener did not bind an ephemeral TCP port',
          );
        }
        const apiBaseUrl = `http://127.0.0.1:${apiAddress.port}`;
        await tenant.runtimeDataSource.query(
          `INSERT INTO "patta_number_sequence" ("id", "next_number", "version")
           VALUES (1, 80000000, 1) ON CONFLICT ("id") DO NOTHING`,
        );
        const sequenceRows: Array<{ next_number: string }> =
          await tenant.runtimeDataSource.query(
            `SELECT "next_number"::text AS "next_number"
           FROM "patta_number_sequence" WHERE "id" = 1`,
          );
        if (BigInt(sequenceRows[0]?.next_number ?? '0') < 80_000_000n) {
          await tenant.runtimeDataSource.query(
            `UPDATE "patta_number_sequence"
             SET "next_number" = 80000000, "version" = "version" + 1 WHERE "id" = 1`,
          );
        }
        for (const deviceId of connectionIds) {
          const allocationResponse = await request(apiApp.getHttpServer())
            .post('/api/v1/patta-number-blocks/allocate')
            .set('Host', `${tenantSlug}.factory.test`)
            .set('Authorization', `Bearer ${tenantToken}`)
            .send({ device_id: deviceId });
          expect(
            allocationResponse.status,
            JSON.stringify(allocationResponse.body),
          ).toBe(201);
        }

        const npmExecPath = process.env.npm_execpath;
        if (!npmExecPath)
          throw new Error('npm_execpath is required for two-PC acceptance');
        const repositoryRoot = resolve(
          dirname(fileURLToPath(import.meta.url)),
          '../../../../..',
        );
        const desktopChild = spawn(
          process.execPath,
          [
            npmExecPath,
            'run',
            'test',
            '--workspace=apps/desktop',
            '--',
            'src/main/sync/two-client-sync.integration.spec.ts',
          ],
          {
            cwd: repositoryRoot,
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              TEMP: process.env.TEMP,
              TMP: process.env.TMP,
              USERPROFILE: process.env.USERPROFILE,
              SYNC_TEST_API_BASE_URL: apiBaseUrl,
              SYNC_TEST_TENANT_HOST: tenantSlug,
              SYNC_TEST_TENANT_TOKEN: tenantToken,
              SYNC_TEST_DEVICE_PC1: devicePc1,
              SYNC_TEST_DEVICE_PC2: devicePc2,
              SYNC_TEST_MODEL_ID: modelId,
              SYNC_TEST_LOCAL_DATA_DIR: localDataDirectory,
            },
            stdio: 'inherit',
          },
        );
        const timeout = setTimeout(() => desktopChild.kill(), 110_000);
        try {
          await waitForSuccessfulExit(desktopChild);
        } finally {
          clearTimeout(timeout);
        }

        const acceptedRows: Array<{ count: string }> =
          await tenant.runtimeDataSource.query(
            `SELECT count(*)::text AS "count" FROM "patta_hisob" WHERE "created_device_id" = $1::uuid`,
            [devicePc1],
          );
        const processedRows: Array<{ count: string }> =
          await tenant.runtimeDataSource.query(
            `SELECT count(*)::text AS "count" FROM "processed_sync_events"
           WHERE "device_id" = $1::uuid AND "user_id" = $2::uuid AND "result_status" = 'SYNCED'`,
            [devicePc1, authUserId],
          );
        expect(acceptedRows[0]?.count).toBe('1');
        expect(processedRows[0]?.count).toBe('1');
      } finally {
        if (apiApp) await apiApp.close();
        if (createdDeviceIds.length > 0) {
          await masterDataSource.query(
            'DELETE FROM "devices" WHERE "id" = ANY($1::uuid[])',
            [createdDeviceIds],
          );
        }
        rmSync(localDataDirectory, { recursive: true, force: true });
        for (const [key, previousValue] of previousEnvironment) {
          if (previousValue === undefined) delete process.env[key];
          else process.env[key] = previousValue;
        }
      }
    }, 120_000);

    it('refuses to revert processed events or change history before dropping sync schema', async () => {
      await expect(
        tenant.migrationDataSource.undoLastMigration({ transaction: 'all' }),
      ).rejects.toThrow('cannot revert sync schema');

      const retained: TableNameRow[] = await tenant.migrationDataSource.query(
        `SELECT "table_name" FROM information_schema.tables
         WHERE "table_schema" = 'public' AND "table_name" = ANY($1::varchar[])
         ORDER BY "table_name"`,
        [
          [
            'processed_sync_events',
            'server_change_log',
            'bootstrap_sessions',
            'bootstrap_items',
          ],
        ],
      );
      expect(retained.map(({ table_name }) => table_name)).toEqual([
        'bootstrap_items',
        'bootstrap_sessions',
        'processed_sync_events',
        'server_change_log',
      ]);
    });
  },
);
