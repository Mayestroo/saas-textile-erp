import { randomBytes } from 'node:crypto';
import { AppModule } from '../../app.module.js';
import { getDataSourceToken } from '@nestjs/typeorm';
import { NestFactory } from '@nestjs/core';
import type { DataSource } from 'typeorm';
import { CompaniesService } from '../companies/companies.service.js';
import { MASTER_DATA_SOURCE_NAME } from '../../database/master/master-database.config.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function assertLocalDevelopmentDatabase(): void {
  const host = process.env.MASTER_DB_HOST?.trim().toLowerCase();
  const database = process.env.MASTER_DB_NAME?.trim().toLowerCase();
  if (process.env.NODE_ENV !== 'development' || !host || !LOOPBACK_HOSTS.has(host) ||
    !database || database.endsWith('_test')) {
    throw new Error('Local tenant bootstrap is allowed only with NODE_ENV=development and a non-test loopback Master database.');
  }
}

async function main(): Promise<void> {
  assertLocalDevelopmentDatabase();
  const [slug = 'textile-dev', companyName = 'Textile Dev', email = `admin@${slug}.local`] = process.argv.slice(2);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new Error('Local tenant slug must be a lowercase DNS label.');
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const master = app.get<DataSource>(getDataSourceToken(MASTER_DATA_SOURCE_NAME), { strict: false });
    const existing: Array<{ id: string }> = await master.query(
      'SELECT "id"::text AS "id" FROM "companies" WHERE "slug" = $1', [slug],
    );
    if (existing.length > 0) {
      throw new Error(`Local company slug ${slug} already exists; this command will not reset its administrator password.`);
    }

    const password = randomBytes(32).toString('base64url');
    const result = await app.get(CompaniesService, { strict: false }).createAndProvision({
      name: companyName,
      slug,
      timezone: process.env.DEFAULT_TENANT_TIMEZONE ?? 'Asia/Tashkent',
      defaultAdmin: { email, fullName: 'Textile Dev Admin', password },
    });
    if (result.status !== 'ACTIVE' || result.provisioningStatus !== 'ACTIVE') {
      throw new Error(`Local tenant provisioning failed at ${result.failureStep ?? result.provisioningStatus}: ${result.failureReason ?? 'unknown reason'}`);
    }

    const port = process.env.PORT ?? '3000';
    process.stdout.write([
      'Local development tenant is ready.',
      `Company: ${companyName} (${slug})`,
      `Desktop tenant URL: http://${slug}.localhost:${port}`,
      `Email: ${email}`,
      `Password: ${password}`,
      'Save this generated password; it is not stored in plaintext.',
    ].join('\n') + '\n');
  } finally {
    await app.close();
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown local tenant bootstrap error';
  process.stderr.write(`Local tenant bootstrap failed: ${message}\n`);
  process.exitCode = 1;
}
