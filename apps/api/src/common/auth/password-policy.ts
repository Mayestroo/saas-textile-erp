import { hash, verify, argon2id } from 'argon2';

export interface Argon2Driver {
  hash(password: string, options: { type: typeof argon2id }): Promise<string>;
  verify(encodedHash: string, password: string): Promise<boolean>;
}

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1_024;

export class PasswordPolicy {
  constructor(private readonly argon2: Argon2Driver = { hash, verify }) {}

  async hash(password: string): Promise<string> {
    this.assertValidForCreation(password);
    return this.argon2.hash(password, { type: argon2id });
  }

  async verify(encodedHash: string | null, password: string): Promise<boolean> {
    if (password.length > PASSWORD_MAX_LENGTH) {
      return false;
    }
    if (encodedHash === null) {
      await this.argon2.hash(password, { type: argon2id });
      return false;
    }

    try {
      return await this.argon2.verify(encodedHash, password);
    } catch {
      return false;
    }
  }

  assertValidForCreation(password: string): void {
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      throw new Error(`Password must contain ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`);
    }
  }
}
