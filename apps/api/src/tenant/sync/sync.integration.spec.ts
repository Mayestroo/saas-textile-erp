import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestMasterDataSourceOptions } from '../../database/master/master-database.config.js';
import {
  createTenantMigrationDataSourceOptions,
  createTenantRuntimeDataSourceOptions,
  createTestTenantProvisionerCredentials,
} from '../../database/tenant/tenant-database.config.js';
import { TenantDatabaseManager } from '../../database/tenant/tenant-database-manager.js';
import { TenantTestDatabaseCleanup } from '../../database/tenant/tenant-test-database-cleanup.js';
import { loadSyncConfiguration } from './sync.config.js';
import { SyncBootstrapService } from './sync-bootstrap.service.js';

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

interface TenantFixture {
  companyId: string;
  databaseName: string;
  secret: ReturnType<TenantDatabaseManager['createSecret']>;
  migrationDataSource: DataSource;
  runtimeDataSource: DataSource;
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

    it('materializes all nine versioned reference projections and serves stable keyset pages', async () => {
      const modelRows: Array<{ id: string }> = await tenant.runtimeDataSource.query(
        `INSERT INTO "models" ("name") VALUES ('Bootstrap Atlas') RETURNING "id"::text AS "id"`,
      );
      const modelId = modelRows[0]?.id;
      if (!modelId) throw new Error('Bootstrap model fixture was not created');
      const operationRows: Array<{ id: string }> = await tenant.runtimeDataSource.query(
        `INSERT INTO "model_operations" ("model_id", "name", "price", "sort_order")
         VALUES ($1::uuid, 'Bootstrap stitch', 10.00, 0) RETURNING "id"::text AS "id"`,
        [modelId],
      );
      const operationId = operationRows[0]?.id;
      if (!operationId) throw new Error('Bootstrap operation fixture was not created');
      await tenant.runtimeDataSource.query(
        `INSERT INTO "model_operation_prices" ("operation_id", "price", "valid_from")
         VALUES ($1::uuid, 10.00, transaction_timestamp() - interval '1 day')`,
        [operationId],
      );
      const workerRows: Array<{ id: string }> = await tenant.runtimeDataSource.query(
        `INSERT INTO "workers" ("full_name") VALUES ('Bootstrap Worker')
         RETURNING "id"::text AS "id"`,
      );
      const workerId = workerRows[0]?.id;
      if (!workerId) throw new Error('Bootstrap worker fixture was not created');
      await tenant.runtimeDataSource.query(
        `INSERT INTO "worker_badge_history" ("badge_number", "worker_id", "valid_from")
         VALUES ('BOOT-18', $1::bigint, transaction_timestamp() - interval '1 day')`,
        [workerId],
      );
      const templateRows: Array<{ id: string }> = await tenant.runtimeDataSource.query(
        `INSERT INTO "patta_templates" ("name", "model_id", "konveyer")
         VALUES ('Bootstrap template', $1::uuid, '1-konveyer')
         RETURNING "id"::text AS "id"`,
        [modelId],
      );
      const templateId = templateRows[0]?.id;
      if (!templateId) throw new Error('Bootstrap template fixture was not created');
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

      const roleRows: Array<{ id: string }> = await tenant.runtimeDataSource.query(
        `INSERT INTO "roles" ("name") VALUES ('Bootstrap private role') RETURNING "id"::text AS "id"`,
      );
      const roleId = roleRows[0]?.id;
      if (!roleId) throw new Error('Bootstrap role fixture was not created');
      const userRows: Array<{ id: string }> = await tenant.runtimeDataSource.query(
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
      const watermarkRows: Array<{ watermark: string }> = await tenant.runtimeDataSource.query(
        `SELECT COALESCE(MAX("sequence_id"), 0)::text AS "watermark" FROM "server_change_log"`,
      );
      const session = await service.create(tenant.runtimeDataSource, deviceId);
      expect(session).toMatchObject({
        device_id: deviceId,
        watermark: watermarkRows[0]?.watermark,
        status: 'ACTIVE',
      });

      const items: Array<{ order_key: string; projection: { entity_type: string; entity_id: string } }> = [];
      let after: string | null = null;
      let hasMore = true;
      while (hasMore) {
        const page = await service.page(tenant.runtimeDataSource, deviceId, session.id, after, 2);
        items.push(...page.items);
        after = page.next_order_key;
        hasMore = page.has_more;
      }

      expect(items).toHaveLength(10);
      expect(items.map(({ projection }) => projection.entity_type)).toEqual([
        'workers',
        'workers',
        'worker_badge_history',
        'models',
        'model_operations',
        'model_operation_prices',
        'patta_templates',
        'patta_hisob',
        'patta_operation_snapshots',
        'patta_number_blocks',
      ]);
      expect(items.map(({ order_key }) => order_key)).toEqual([
        '1', '2', '3', '4', '5', '6', '7', '8', '9', '10',
      ]);
      expect(items.find(({ projection }) =>
        projection.entity_type === 'workers' && projection.entity_id === workerId,
      )?.projection.entity_id).toBe(workerId);
      expect(items.find(({ projection }) => projection.entity_type === 'patta_hisob')?.projection.entity_id)
        .toBe(pattaId);
      expect(JSON.stringify(items)).not.toMatch(/password_hash|auth_sessions|audit_log|platform_users/i);

      await expect(service.page(tenant.runtimeDataSource, randomUUID(), session.id, null, 2))
        .rejects.toMatchObject({ response: { code: 'SYNC_BOOTSTRAP_DEVICE_MISMATCH' } });
      await expect(service.complete(tenant.runtimeDataSource, deviceId, session.id)).resolves.toEqual({
        session_id: session.id,
        status: 'COMPLETED',
      });
      await expect(service.complete(tenant.runtimeDataSource, deviceId, session.id)).resolves.toEqual({
        session_id: session.id,
        status: 'COMPLETED',
      });
    });

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
