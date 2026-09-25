const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_DATABASE_PATTERN = /^tenant_[0-9a-f]{32}$/;
const TEST_TENANT_DATABASE_PATTERN = /^tenant_test_[0-9a-f]{32}$/;
const TENANT_RUNTIME_ROLE_PATTERN = /^tenant_[0-9a-f]{32}_app$/;

export type TenantDatabaseNameMode = 'production' | 'test';

export function normalizeCompanyUuid(companyId: string): string {
  if (!UUID_PATTERN.test(companyId)) {
    throw new Error('Company ID must be a valid UUID');
  }

  return companyId.replaceAll('-', '').toLowerCase();
}

export function createTenantDatabaseName(
  companyId: string,
  mode: TenantDatabaseNameMode = 'production',
): string {
  const normalizedId = normalizeCompanyUuid(companyId);
  return mode === 'test' ? `tenant_test_${normalizedId}` : `tenant_${normalizedId}`;
}

export function createTenantRuntimeRoleName(companyId: string): string {
  return `tenant_${normalizeCompanyUuid(companyId)}_app`;
}

export function assertTenantDatabaseName(name: string, mode: TenantDatabaseNameMode): string {
  const pattern = mode === 'test' ? TEST_TENANT_DATABASE_PATTERN : TENANT_DATABASE_PATTERN;
  if (!pattern.test(name)) {
    throw new Error('Tenant database name is not a valid generated identifier');
  }

  return name;
}

export function assertTenantRuntimeRoleName(name: string): string {
  if (!TENANT_RUNTIME_ROLE_PATTERN.test(name)) {
    throw new Error('Tenant runtime role name is not a valid generated identifier');
  }

  return name;
}

export function isTestTenantDatabaseName(name: string): boolean {
  return TEST_TENANT_DATABASE_PATTERN.test(name);
}
