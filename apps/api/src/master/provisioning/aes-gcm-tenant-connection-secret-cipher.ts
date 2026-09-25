import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { TenantConnectionSecretCipher } from './tenant-connection-secret-cipher.js';

const CIPHER_ALGORITHM = 'aes-256-gcm';
const CIPHER_VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const AUTHENTICATED_CONTEXT = Buffer.from('textile-erp:tenant-connection:v1', 'utf8');
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function decodeBase64Url(value: string, label: string, expectedBytes?: number): Buffer {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new Error(`${label} must be canonical base64url`);
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
    throw new Error(`${label} has an invalid length or encoding`);
  }

  return decoded;
}

export class AesGcmTenantConnectionSecretCipher implements TenantConnectionSecretCipher {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error('Tenant connection encryption key must contain exactly 32 bytes');
    }

    this.key = Buffer.from(key);
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): AesGcmTenantConnectionSecretCipher {
    const encodedKey = environment.TENANT_CONNECTION_ENCRYPTION_KEY;
    if (!encodedKey) {
      throw new Error('Missing required tenant connection secret setting: TENANT_CONNECTION_ENCRYPTION_KEY');
    }

    return new AesGcmTenantConnectionSecretCipher(
      decodeBase64Url(encodedKey, 'TENANT_CONNECTION_ENCRYPTION_KEY', KEY_BYTES),
    );
  }

  async encrypt(plaintext: string): Promise<string> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER_ALGORITHM, this.key, iv, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(AUTHENTICATED_CONTEXT);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [CIPHER_VERSION, iv.toString('base64url'), authTag.toString('base64url'), ciphertext.toString('base64url')].join(
      ':',
    );
  }

  async decrypt(envelope: string): Promise<string> {
    const parts = envelope.split(':');
    if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) {
      throw new Error('Tenant connection secret has an unsupported envelope');
    }

    const iv = decodeBase64Url(parts[1] ?? '', 'Tenant connection secret IV', IV_BYTES);
    const authTag = decodeBase64Url(parts[2] ?? '', 'Tenant connection secret authentication tag', AUTH_TAG_BYTES);
    const ciphertextPart = parts[3] ?? '';
    const ciphertext = ciphertextPart.length === 0 ? Buffer.alloc(0) : decodeBase64Url(ciphertextPart, 'Tenant connection secret ciphertext');

    try {
      const decipher = createDecipheriv(CIPHER_ALGORITHM, this.key, iv, { authTagLength: AUTH_TAG_BYTES });
      decipher.setAAD(AUTHENTICATED_CONTEXT);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Tenant connection secret authentication failed');
    }
  }
}

export class EnvironmentTenantConnectionSecretCipher implements TenantConnectionSecretCipher {
  async encrypt(plaintext: string): Promise<string> {
    return AesGcmTenantConnectionSecretCipher.fromEnvironment().encrypt(plaintext);
  }

  async decrypt(envelope: string): Promise<string> {
    return AesGcmTenantConnectionSecretCipher.fromEnvironment().decrypt(envelope);
  }
}
