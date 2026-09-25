import { describe, expect, it, vi } from 'vitest';
import { argon2id } from 'argon2';
import { PasswordPolicy, type Argon2Driver } from './password-policy.js';

describe('PasswordPolicy', () => {
  const passwordPolicy = new PasswordPolicy();

  it('stores only an Argon2id hash and verifies the original password', async () => {
    const password = 'test-only-strong-password';
    const encoded = await passwordPolicy.hash(password);

    expect(encoded.startsWith('$argon2id$')).toBe(true);
    expect(encoded).not.toContain(password);
    await expect(passwordPolicy.verify(encoded, password)).resolves.toBe(true);
    await expect(passwordPolicy.verify(encoded, 'different-password')).resolves.toBe(false);
  });

  it('enforces the centralized 12 to 1024 character password policy', async () => {
    await expect(passwordPolicy.hash('short')).rejects.toThrow(
      'Password must contain 12 to 1024 characters',
    );
    await expect(passwordPolicy.hash('x'.repeat(1025))).rejects.toThrow(
      'Password must contain 12 to 1024 characters',
    );
  });

  it('performs an Argon2id operation for an unknown account', async () => {
    const hashing: Argon2Driver = {
      hash: vi.fn<Argon2Driver['hash']>(async () => 'discarded-dummy-hash'),
      verify: vi.fn<Argon2Driver['verify']>(async () => false),
    };
    const policy = new PasswordPolicy(hashing);

    await expect(policy.verify(null, 'test-only-login-password')).resolves.toBe(false);
    expect(hashing.hash).toHaveBeenCalledWith('test-only-login-password', { type: argon2id });
    expect(hashing.verify).not.toHaveBeenCalled();
  });

  it('treats malformed stored hashes as invalid credentials', async () => {
    await expect(passwordPolicy.verify('not-an-argon2-hash', 'test-only-password'))
      .resolves.toBe(false);
  });
});
