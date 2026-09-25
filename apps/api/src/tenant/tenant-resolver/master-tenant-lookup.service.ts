import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MASTER_DATA_SOURCE_NAME } from '../../database/master/master-database.config.js';

export interface MasterTenantMetadata {
  id: string;
  slug: string;
  status: string;
  databaseName: string;
  connectionCiphertext: string | null;
}

export interface MasterTenantReader {
  findTenantById(companyId: string): Promise<MasterTenantMetadata | null>;
}

export const MASTER_TENANT_READER = Symbol('MASTER_TENANT_READER');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

@Injectable()
export class MasterTenantLookupService implements MasterTenantReader {
  constructor(@InjectDataSource(MASTER_DATA_SOURCE_NAME) private readonly masterDataSource: DataSource) {}

  async findTenantById(companyId: string): Promise<MasterTenantMetadata | null> {
    const result: unknown = await this.masterDataSource.query(
      `SELECT "id", "slug", "status", "db_name", "db_connection_ciphertext"
       FROM "companies" WHERE "id" = $1`,
      [companyId],
    );
    if (!Array.isArray(result)) {
      throw new Error('Master tenant query returned an invalid result');
    }
    const row = result[0];
    if (row === undefined) {
      return null;
    }
    if (!isRecord(row)) {
      throw new Error('Master tenant query returned an invalid row');
    }

    const id = Reflect.get(row, 'id');
    const slug = Reflect.get(row, 'slug');
    const status = Reflect.get(row, 'status');
    const databaseName = Reflect.get(row, 'db_name');
    const connectionCiphertext = Reflect.get(row, 'db_connection_ciphertext');
    if (
      typeof id !== 'string' ||
      typeof slug !== 'string' ||
      typeof status !== 'string' ||
      typeof databaseName !== 'string' ||
      !(typeof connectionCiphertext === 'string' || connectionCiphertext === null)
    ) {
      throw new Error('Master tenant query returned incomplete metadata');
    }

    return { id, slug, status, databaseName, connectionCiphertext };
  }
}
