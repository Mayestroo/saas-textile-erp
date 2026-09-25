import { createHash } from 'node:crypto';
import { ForbiddenException, Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTenantRuntimeDataSourceOptions } from '../../database/tenant/tenant-database.config.js';
import {
  createTenantRuntimeRoleName,
  normalizeCompanyUuid,
} from '../../database/tenant/tenant-database-names.js';
import { TenantDatabaseManager, TenantRuntimeSecret } from '../../database/tenant/tenant-database-manager.js';
import { TENANT_CONNECTION_SECRET_CIPHER } from '../../master/provisioning/tenant-connection-secret-cipher.js';
import type { TenantConnectionSecretCipher } from '../../master/provisioning/tenant-connection-secret-cipher.js';
import {
  MASTER_TENANT_READER,
} from '../tenant-resolver/master-tenant-lookup.service.js';
import type {
  MasterTenantMetadata,
  MasterTenantReader,
} from '../tenant-resolver/master-tenant-lookup.service.js';

interface CachedTenantDataSource {
  dataSource: DataSource;
  metadataFingerprint: string;
  lastAccessedAt: number;
}

function isRuntimeSecret(value: unknown): value is TenantRuntimeSecret {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (
    typeof Reflect.get(value, 'username') === 'string' &&
    typeof Reflect.get(value, 'password') === 'string'
  );
}

function metadataFingerprint(company: MasterTenantMetadata): string {
  return createHash('sha256')
    .update(company.databaseName)
    .update('\0')
    .update(company.connectionCiphertext ?? '')
    .digest('hex');
}

@Injectable()
export class TenantConnectionManager implements OnModuleDestroy {
  private readonly dataSources = new Map<string, CachedTenantDataSource>();
  private readonly initializing = new Map<string, Promise<CachedTenantDataSource>>();
  private isClosed = false;

  constructor(
    @Inject(MASTER_TENANT_READER) private readonly masterTenantReader: MasterTenantReader,
    private readonly tenantDatabaseManager: TenantDatabaseManager,
    @Inject(TENANT_CONNECTION_SECRET_CIPHER)
    private readonly tenantConnectionSecretCipher: TenantConnectionSecretCipher,
  ) {}

  async getDataSource(authenticatedCompanyId: string): Promise<DataSource> {
    if (this.isClosed) {
      throw new Error('Tenant connection manager is closed');
    }
    normalizeCompanyUuid(authenticatedCompanyId);
    const companyId = authenticatedCompanyId.toLowerCase();
    const company = await this.masterTenantReader.findTenantById(companyId);
    if (this.isClosed) {
      throw new Error('Tenant connection manager is closed');
    }
    if (!company || company.status !== 'ACTIVE' || !company.connectionCiphertext) {
      await this.closeCached(companyId);
      throw new ForbiddenException({
        code: 'TENANT_DATABASE_UNAVAILABLE',
        message: 'Korxona ma’lumotlar bazasiga ruxsat yo‘q',
      });
    }

    const fingerprint = metadataFingerprint(company);
    const cached = this.dataSources.get(companyId);
    if (cached && cached.metadataFingerprint === fingerprint) {
      try {
        await this.assertHealthy(cached.dataSource, company);
        cached.lastAccessedAt = Date.now();
        return cached.dataSource;
      } catch {
        await this.closeCached(companyId);
      }
    } else if (cached) {
      await this.closeCached(companyId);
    }

    const inFlight = this.initializing.get(companyId);
    if (inFlight) {
      const pending = await inFlight;
      if (this.isClosed) {
        throw new Error('Tenant connection manager is closed');
      }
      if (pending.metadataFingerprint === fingerprint) {
        await this.assertHealthy(pending.dataSource, company);
        pending.lastAccessedAt = Date.now();
        return pending.dataSource;
      }
      if (this.dataSources.get(companyId)?.dataSource === pending.dataSource) {
        this.dataSources.delete(companyId);
      }
      await this.destroyDataSource(pending.dataSource);
    }

    const newInitialization = this.initialize(companyId, company, fingerprint);
    this.initializing.set(companyId, newInitialization);
    try {
      const entry = await newInitialization;
      if (this.isClosed) {
        await this.destroyDataSource(entry.dataSource);
        throw new Error('Tenant connection manager is closed');
      }
      this.dataSources.set(companyId, entry);
      return entry.dataSource;
    } finally {
      if (this.initializing.get(companyId) === newInitialization) {
        this.initializing.delete(companyId);
      }
    }
  }

  async close(): Promise<void> {
    this.isClosed = true;
    const entries = [...this.dataSources.values()];
    this.dataSources.clear();
    const pending = await Promise.allSettled(this.initializing.values());
    const initialized = pending.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value.dataSource] : [],
    );
    await Promise.all(
      [...entries.map(({ dataSource }) => dataSource), ...initialized].map((dataSource) =>
        this.destroyDataSource(dataSource),
      ),
    );
    this.initializing.clear();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private async initialize(
    companyId: string,
    company: MasterTenantMetadata,
    fingerprint: string,
  ): Promise<CachedTenantDataSource> {
    const plaintext = await this.tenantConnectionSecretCipher.decrypt(company.connectionCiphertext ?? '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      throw new Error('Tenant connection credential envelope contains invalid data');
    }
    if (!isRuntimeSecret(parsed) || parsed.username !== createTenantRuntimeRoleName(companyId)) {
      throw new Error('Tenant connection credential does not match the authenticated company');
    }

    const runtimeCredentials = this.tenantDatabaseManager.runtimeCredentials(
      companyId,
      company.databaseName,
      parsed,
    );
    const dataSource = new DataSource(createTenantRuntimeDataSourceOptions(runtimeCredentials));
    try {
      await dataSource.initialize();
      await this.assertHealthy(dataSource, company);
      return { dataSource, metadataFingerprint: fingerprint, lastAccessedAt: Date.now() };
    } catch (error) {
      await this.destroyDataSource(dataSource);
      throw error;
    }
  }

  private async assertHealthy(dataSource: DataSource, company: MasterTenantMetadata): Promise<void> {
    const rows: Array<{ database_name: string; role_name: string }> = await dataSource.query(
      'SELECT current_database() AS database_name, current_user AS role_name',
    );
    if (rows[0]?.database_name !== company.databaseName) {
      throw new Error('Cached tenant connection resolved to a different database');
    }

    const expectedUsername = createTenantRuntimeRoleName(company.id);
    if (rows[0]?.role_name !== expectedUsername) {
      throw new Error('Cached tenant connection resolved to a different runtime role');
    }
  }

  private async closeCached(companyId: string): Promise<void> {
    const cached = this.dataSources.get(companyId);
    if (!cached) {
      return;
    }
    this.dataSources.delete(companyId);
    await this.destroyDataSource(cached.dataSource);
  }

  private async destroyDataSource(dataSource: DataSource): Promise<void> {
    if (dataSource.isInitialized) {
      try {
        await dataSource.destroy();
      } catch {
        // A broken pool has already been evicted; shutdown must continue for other tenants.
      }
    }
  }
}
