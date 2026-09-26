import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { TenantDatabaseManager } from '../../database/tenant/tenant-database-manager.js';
import { MASTER_DATA_SOURCE_NAME } from '../../database/master/master-database.config.js';
import { CompanyEntity } from './company.entity.js';
import {
  DefaultTenantAdminInput,
} from '../../tenant/users/tenant-admin.seed.js';
import { ProvisioningService, ProvisioningSnapshot } from '../provisioning/provisioning.service.js';

export interface CreateCompanyInput {
  name: string;
  slug: string;
  timezone?: string;
  defaultAdmin?: DefaultTenantAdminInput;
}

function postgresConstraint(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const driverError = Reflect.get(error, 'driverError');
  if (typeof driverError !== 'object' || driverError === null) {
    return undefined;
  }
  const constraint = Reflect.get(driverError, 'constraint');
  return typeof constraint === 'string' ? constraint : undefined;
}

function validateCompanyInput(input: CreateCompanyInput): {
  name: string;
  slug: string;
  timezone: string;
} {
  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  const timezone = input.timezone?.trim() || process.env.DEFAULT_TENANT_TIMEZONE || 'Asia/Tashkent';
  if (name.length === 0 || name.length > 255) {
    throw new BadRequestException({
      code: 'INVALID_COMPANY_NAME',
      message: 'Korxona nomi 1–255 belgidan iborat bo‘lishi kerak',
      details: {},
    });
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new BadRequestException({
      code: 'INVALID_COMPANY_SLUG',
      message: 'Korxona manzili yaroqsiz',
      details: {},
    });
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new BadRequestException({
      code: 'INVALID_COMPANY_TIMEZONE',
      message: 'Vaqt mintaqasi yaroqsiz',
      details: {},
    });
  }
  return { name, slug, timezone };
}

@Injectable()
export class CompaniesService {
  constructor(
    @InjectDataSource(MASTER_DATA_SOURCE_NAME) private readonly masterDataSource: DataSource,
    private readonly tenantDatabaseManager: TenantDatabaseManager,
    private readonly provisioningService: ProvisioningService,
  ) {}

  async createAndProvision(input: CreateCompanyInput): Promise<ProvisioningSnapshot> {
    const validated = validateCompanyInput(input);
    const companyId = randomUUID();
    try {
      await this.masterDataSource.manager.insert(CompanyEntity, {
        id: companyId,
        name: validated.name,
        slug: validated.slug,
        status: 'PROVISIONING',
        dbName: this.tenantDatabaseManager.expectedDatabaseName(companyId),
        dbConnectionCiphertext: null,
        schemaVersion: null,
        timezone: validated.timezone,
        provisioningStatus: 'REQUESTED',
        failureStep: null,
        failureReason: null,
        defaultAdminRequired: Boolean(input.defaultAdmin),
        lastMigrationAt: null,
      });
    } catch (error) {
      if (postgresConstraint(error) === 'uq_companies_slug') {
        throw new ConflictException({
          code: 'COMPANY_SLUG_ALREADY_EXISTS',
          message: 'Bu kompaniya manzili band',
        });
      }
      throw error;
    }

    return this.provisioningService.provision(companyId, input.defaultAdmin);
  }
}
