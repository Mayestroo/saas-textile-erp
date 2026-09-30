import type { DataSource } from 'typeorm';
import type { DefaultTenantAdminInput } from '../../tenant/users/tenant-admin.seed.js';
import {
  ensureLocalDemoTestUser,
  type LocalDemoTestUserDependencies,
  type LocalDemoTestUserRecord,
} from './local-dev-demo-test-user.js';

function createHarness(initialUser?: LocalDemoTestUserRecord) {
  let user = initialUser;
  const dataSource = {} as DataSource;
  const dependencies: LocalDemoTestUserDependencies = {
    findUser: vi.fn(async () => user),
    seedAdmin: vi.fn(async (_source: DataSource, input: DefaultTenantAdminInput) => {
      user = {
        fullName: input.fullName,
        status: 'ACTIVE',
        isSystemAdmin: true,
        passwordHash: `hash:${input.password}`,
      };
    }),
    verifyPassword: vi.fn(async (passwordHash, password) => passwordHash === `hash:${password}`),
    generatePassword: vi.fn(() => 'fresh-local-test-password-2026'),
  };
  return {
    dataSource,
    dependencies,
    getUser: () => user,
    setUser: (nextUser: LocalDemoTestUserRecord) => {
      user = nextUser;
    },
  };
}

describe('ensureLocalDemoTestUser', () => {
  it('creates an active test administrator and returns its one-time password', async () => {
    const { dataSource, dependencies, getUser } = createHarness();

    const result = await ensureLocalDemoTestUser(
      dataSource,
      ' TEST@textile-dev.local ',
      dependencies,
    );

    expect(result).toEqual({
      email: 'test@textile-dev.local',
      fullName: 'Lokal sinov foydalanuvchisi',
      created: true,
      password: 'fresh-local-test-password-2026',
    });
    expect(getUser()).toMatchObject({
      status: 'ACTIVE',
      isSystemAdmin: true,
    });
    expect(dependencies.seedAdmin).toHaveBeenCalledWith(dataSource, {
      email: 'test@textile-dev.local',
      fullName: 'Lokal sinov foydalanuvchisi',
      password: 'fresh-local-test-password-2026',
    });
    expect(dependencies.verifyPassword).toHaveBeenCalledWith(
      'hash:fresh-local-test-password-2026',
      'fresh-local-test-password-2026',
    );
  });

  it('reuses an existing active administrator without generating or resetting a password', async () => {
    const existingUser: LocalDemoTestUserRecord = {
      fullName: 'Lokal sinov foydalanuvchisi',
      status: 'ACTIVE',
      isSystemAdmin: true,
      passwordHash: 'existing-hash',
    };
    const { dataSource, dependencies } = createHarness(existingUser);

    const result = await ensureLocalDemoTestUser(
      dataSource,
      'test@textile-dev.local',
      dependencies,
    );

    expect(result).toEqual({
      email: 'test@textile-dev.local',
      fullName: 'Lokal sinov foydalanuvchisi',
      created: false,
    });
    expect(dependencies.seedAdmin).not.toHaveBeenCalled();
    expect(dependencies.generatePassword).not.toHaveBeenCalled();
  });

  it('refuses to reuse an inactive or non-administrator account', async () => {
    const { dataSource, dependencies } = createHarness({
      fullName: 'Other account',
      status: 'ACTIVE',
      isSystemAdmin: false,
      passwordHash: 'existing-hash',
    });

    await expect(
      ensureLocalDemoTestUser(
        dataSource,
        'test@textile-dev.local',
        dependencies,
      ),
    ).rejects.toThrow(
      'Local demo test-user email test@textile-dev.local belongs to a non-active or non-administrator account',
    );
    expect(dependencies.seedAdmin).not.toHaveBeenCalled();
  });

  it('does not print a password if another process won the creation race', async () => {
    const { dataSource, dependencies, setUser } = createHarness();
    dependencies.seedAdmin = vi.fn(async () => {
      setUser({
        fullName: 'Lokal sinov foydalanuvchisi',
        status: 'ACTIVE',
        isSystemAdmin: true,
        passwordHash: 'different-process-hash',
      });
    });

    await expect(
      ensureLocalDemoTestUser(
        dataSource,
        'test@textile-dev.local',
        dependencies,
      ),
    ).rejects.toThrow(
      'Local demo test-user test@textile-dev.local was created concurrently; rerun the seed to use the existing account',
    );
  });
});
