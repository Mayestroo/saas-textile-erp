export interface TenantConnectionSecretCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

export const TENANT_CONNECTION_SECRET_CIPHER = Symbol('TENANT_CONNECTION_SECRET_CIPHER');
