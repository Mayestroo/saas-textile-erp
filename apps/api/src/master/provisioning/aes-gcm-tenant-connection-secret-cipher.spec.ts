import { randomBytes } from 'node:crypto';
import { AesGcmTenantConnectionSecretCipher } from './aes-gcm-tenant-connection-secret-cipher.js';

describe('AesGcmTenantConnectionSecretCipher', () => {
  it('round-trips credentials with a versioned envelope', async () => {
    const cipher = new AesGcmTenantConnectionSecretCipher(randomBytes(32));
    const plaintext = JSON.stringify({ username: 'tenant_app', password: 'runtime-only-secret' });

    const envelope = await cipher.encrypt(plaintext);

    expect(envelope.split(':')).toHaveLength(4);
    expect(envelope.startsWith('v1:')).toBe(true);
    expect(await cipher.decrypt(envelope)).toBe(plaintext);
  });

  it('uses a fresh nonce for each encryption', async () => {
    const cipher = new AesGcmTenantConnectionSecretCipher(randomBytes(32));
    const first = await cipher.encrypt('same secret');
    const second = await cipher.encrypt('same secret');

    expect(first).not.toBe(second);
    expect(first.split(':')[1]).not.toBe(second.split(':')[1]);
  });

  it('rejects tampered envelopes and unsupported versions', async () => {
    const cipher = new AesGcmTenantConnectionSecretCipher(randomBytes(32));
    const envelope = await cipher.encrypt('secret');
    const [version, iv, , ciphertext] = envelope.split(':');

    await expect(cipher.decrypt(`v2:${iv}:invalid:${ciphertext}`)).rejects.toThrow(
      'Tenant connection secret has an unsupported envelope',
    );
    await expect(cipher.decrypt(`${version}:${iv}:${randomBytes(16).toString('base64url')}:${ciphertext}`)).rejects.toThrow(
      'Tenant connection secret authentication failed',
    );
  });

  it('requires a canonical 32-byte base64url environment key', () => {
    expect(() => new AesGcmTenantConnectionSecretCipher(randomBytes(31))).toThrow(
      'Tenant connection encryption key must contain exactly 32 bytes',
    );
    expect(() =>
      AesGcmTenantConnectionSecretCipher.fromEnvironment({ TENANT_CONNECTION_ENCRYPTION_KEY: 'short' }),
    ).toThrow('TENANT_CONNECTION_ENCRYPTION_KEY has an invalid length or encoding');
  });
});
