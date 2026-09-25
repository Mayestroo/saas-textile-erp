import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { createTenantRuntimeDataSourceOptions } from '../../database/tenant/tenant-database.config.js';
import { TenantDatabaseManager, TenantRuntimeSecret } from '../../database/tenant/tenant-database-manager.js';
import { TenantMigrationRunner } from '../../database/tenant/tenant-migration-runner.js';
import { CompanyEntity, CompanyStatus } from '../companies/company.entity.js';
import { seedDefaultTenantAdmin } from '../../tenant/users/tenant-admin.seed.js';
import type { DefaultTenantAdminInput } from '../../tenant/users/tenant-admin.seed.js';
import { seedTenantPermissions } from '../../tenant/rbac/tenant-permission.seed.js';
import { TENANT_CONNECTION_SECRET_CIPHER } from './tenant-connection-secret-cipher.js';
import type { TenantConnectionSecretCipher } from './tenant-connection-secret-cipher.js';
import { MASTER_DATA_SOURCE_NAME } from '../../database/master/master-database.config.js';

export const PROVISIONING_STEPS = [
  'CREATING_DATABASE',
  'RUNNING_MIGRATIONS',
  'SEEDING_PERMISSIONS',
  'CREATING_DEFAULT_ADMIN',
] as const;

export type ProvisioningStep = (typeof PROVISIONING_STEPS)[number];
export type ProvisioningStatus = 'REQUESTED' | ProvisioningStep | 'FAILED' | 'ACTIVE';

export interface ProvisioningSnapshot {
  companyId: string;
  status: CompanyStatus;
  provisioningStatus: string | null;
  failureStep: string | null;
  failureReason: string | null;
  schemaVersion: string | null;
}

interface StoredTenantRuntimeSecret {
  username: string;
  password: string;
}

function isTenantRuntimeSecret(value: unknown): value is StoredTenantRuntimeSecret {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const username = Reflect.get(value, 'username');
  const password = Reflect.get(value, 'password');
  return typeof username === 'string' && typeof password === 'string';
}

function postgresPassword(options: DataSource['options']): string | undefined {
  if (options.type !== 'postgres' || typeof options.password !== 'string') {
    return undefined;
  }
  return options.password;
}

function safeFailureReason(error: unknown, secrets: readonly string[]): string {
  const type = error instanceof Error ? error.name : 'Error';
  let message = error instanceof Error ? error.message : 'Unknown provisioning error';
  for (const secret of secrets) {
    if (secret.length > 0) {
      message = message.replaceAll(secret, '[redacted]');
    }
  }
  message = message
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@[^\s]+/gi, 'postgresql://[redacted]')
    .replace(/password\s*[:=]\s*[^\s,;]+/gi, 'password=[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();

  return `${type}: ${message}`.slice(0, 2000);
}

@Injectable()
export class ProvisioningService {
  constructor(
    @InjectDataSource(MASTER_DATA_SOURCE_NAME) private readonly masterDataSource: DataSource,
    private readonly tenantDatabaseManager: TenantDatabaseManager,
    private readonly tenantMigrationRunner: TenantMigrationRunner,
    @Inject(TENANT_CONNECTION_SECRET_CIPHER)
    private readonly tenantConnectionSecretCipher: TenantConnectionSecretCipher,
  ) {}

  async provision(companyId: string, defaultAdmin?: DefaultTenantAdminInput): Promise<ProvisioningSnapshot> {
    const queryRunner = this.masterDataSource.createQueryRunner();
    let connected = false;
    let lockAcquired = false;
    try {
      await queryRunner.connect();
      connected = true;
      await queryRunner.query(
        'SELECT pg_advisory_lock(hashtextextended(($1::uuid)::text, 0))',
        [companyId],
      );
      lockAcquired = true;
      return await this.provisionWhileLocked(queryRunner, companyId, defaultAdmin);
    } finally {
      try {
        if (lockAcquired) {
          await queryRunner.query(
            'SELECT pg_advisory_unlock(hashtextextended(($1::uuid)::text, 0))',
            [companyId],
          );
        }
      } finally {
        if (connected) {
          await queryRunner.release();
        }
      }
    }
  }

  private async provisionWhileLocked(
    queryRunner: QueryRunner,
    companyId: string,
    defaultAdmin?: DefaultTenantAdminInput,
  ): Promise<ProvisioningSnapshot> {
    const company = await queryRunner.manager.findOne(CompanyEntity, { where: { id: companyId } });
    if (!company) {
      throw new NotFoundException({ code: 'COMPANY_NOT_FOUND', message: 'Korxona topilmadi' });
    }
    if (company.status === 'SUSPENDED' || company.status === 'ARCHIVED') {
      throw new Error(`Company in ${company.status} state cannot be provisioned`);
    }
    if (company.status === 'ACTIVE' && company.provisioningStatus === 'ACTIVE') {
      return this.snapshot(company);
    }
    if (company.defaultAdminRequired && !defaultAdmin) {
      throw new ConflictException({
        code: 'DEFAULT_ADMIN_INPUT_REQUIRED',
        message: 'Qayta provision qilish uchun standart administrator ma’lumoti kerak',
      });
    }

    await this.updateCompany(queryRunner, companyId, {
      status: 'PROVISIONING',
      provisioningStatus: 'REQUESTED',
      failureStep: null,
      failureReason: null,
    });

    let currentStep: ProvisioningStep = 'CREATING_DATABASE';
    let runtimeSecret: TenantRuntimeSecret | undefined;
    const provisionerPassword = process.env.TENANT_PROVISIONER_DB_PASSWORD ?? '';
    const masterPassword = postgresPassword(this.masterDataSource.options) ?? '';

    try {
      const refreshedCompany = await queryRunner.manager.findOneOrFail(CompanyEntity, {
        where: { id: companyId },
      });
      const expectedDatabaseName = this.tenantDatabaseManager.expectedDatabaseName(companyId);
      if (refreshedCompany.dbName !== expectedDatabaseName) {
        throw new Error('Company tenant database name does not match its generated identity');
      }

      currentStep = 'CREATING_DATABASE';
      await this.setStep(queryRunner, companyId, currentStep);
      runtimeSecret = await this.loadOrCreateRuntimeSecret(queryRunner, refreshedCompany);
      await this.tenantDatabaseManager.ensureDatabase(companyId, refreshedCompany.dbName, runtimeSecret);
      const runtimeCredentials = this.tenantDatabaseManager.runtimeCredentials(
        companyId,
        refreshedCompany.dbName,
        runtimeSecret,
      );
      await this.tenantDatabaseManager.testRuntimeConnection(runtimeCredentials);

      currentStep = 'RUNNING_MIGRATIONS';
      await this.setStep(queryRunner, companyId, currentStep);
      const schemaVersion = await this.tenantMigrationRunner.run(
        this.tenantDatabaseManager.migrationCredentials(refreshedCompany.dbName),
      );
      if (!schemaVersion) {
        throw new Error('Tenant migration metadata does not contain an executed schema version');
      }
      await this.tenantDatabaseManager.grantRuntimePrivileges(
        companyId,
        refreshedCompany.dbName,
        runtimeSecret,
      );
      await this.updateCompany(queryRunner, companyId, {
        schemaVersion,
        lastMigrationAt: new Date(),
      });

      currentStep = 'SEEDING_PERMISSIONS';
      await this.setStep(queryRunner, companyId, currentStep);
      await this.withTenantRuntimeDataSource(runtimeCredentials, seedTenantPermissions);

      currentStep = 'CREATING_DEFAULT_ADMIN';
      await this.setStep(queryRunner, companyId, currentStep);
      if (defaultAdmin) {
        await this.withTenantRuntimeDataSource(runtimeCredentials, (dataSource) =>
          seedDefaultTenantAdmin(dataSource, defaultAdmin),
        );
      }

      await this.updateCompany(queryRunner, companyId, {
        status: 'ACTIVE',
        provisioningStatus: 'ACTIVE',
        failureStep: null,
        failureReason: null,
      });
      return await this.loadSnapshot(queryRunner, companyId);
    } catch (error) {
      const failureReason = safeFailureReason(error, [
        provisionerPassword,
        masterPassword,
        runtimeSecret?.password ?? '',
        defaultAdmin?.password ?? '',
        ...this.tenantDatabaseManager.sensitiveValues(),
      ]);
      await this.updateCompany(queryRunner, companyId, {
        status: 'FAILED',
        provisioningStatus: 'FAILED',
        failureStep: currentStep,
        failureReason,
      });
      return await this.loadSnapshot(queryRunner, companyId);
    }
  }

  private async loadOrCreateRuntimeSecret(
    queryRunner: QueryRunner,
    company: CompanyEntity,
  ): Promise<TenantRuntimeSecret> {
    if (!company.dbConnectionCiphertext) {
      const generated = this.tenantDatabaseManager.createSecret(company.id);
      const encrypted = await this.tenantConnectionSecretCipher.encrypt(JSON.stringify(generated));
      await this.updateCompany(queryRunner, company.id, { dbConnectionCiphertext: encrypted });
      return generated;
    }

    const plaintext = await this.tenantConnectionSecretCipher.decrypt(company.dbConnectionCiphertext);
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      throw new Error('Encrypted tenant runtime credential is not valid JSON');
    }
    if (!isTenantRuntimeSecret(parsed)) {
      throw new Error('Encrypted tenant runtime credential has an invalid shape');
    }
    return parsed;
  }

  private async setStep(
    queryRunner: QueryRunner,
    companyId: string,
    step: ProvisioningStep,
  ): Promise<void> {
    await this.updateCompany(queryRunner, companyId, {
      status: 'PROVISIONING',
      provisioningStatus: step,
      failureStep: null,
      failureReason: null,
    });
  }

  private async updateCompany(
    queryRunner: QueryRunner,
    companyId: string,
    changes: Partial<CompanyEntity>,
  ): Promise<void> {
    await queryRunner.manager.update(CompanyEntity, { id: companyId }, changes);
  }

  private async loadSnapshot(
    queryRunner: QueryRunner,
    companyId: string,
  ): Promise<ProvisioningSnapshot> {
    const company = await queryRunner.manager.findOneOrFail(CompanyEntity, { where: { id: companyId } });
    return this.snapshot(company);
  }

  private snapshot(company: CompanyEntity): ProvisioningSnapshot {
    return {
      companyId: company.id,
      status: company.status,
      provisioningStatus: company.provisioningStatus,
      failureStep: company.failureStep,
      failureReason: company.failureReason,
      schemaVersion: company.schemaVersion,
    };
  }

  private async withTenantRuntimeDataSource<T>(
    credentials: ReturnType<TenantDatabaseManager['runtimeCredentials']>,
    action: (dataSource: DataSource) => Promise<T>,
  ): Promise<T> {
    const dataSource = new DataSource(createTenantRuntimeDataSourceOptions(credentials));
    try {
      await dataSource.initialize();
      return await action(dataSource);
    } finally {
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }
    }
  }
}
