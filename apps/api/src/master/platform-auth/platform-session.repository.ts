import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { MASTER_DATA_SOURCE_NAME } from '../../database/master/master-database.config.js';

export interface LockedPlatformSession {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  user_status: string;
}

export interface NewPlatformSession {
  id: string;
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
}

@Injectable()
export class PlatformSessionRepository {
  constructor(
    @InjectDataSource(MASTER_DATA_SOURCE_NAME) private readonly masterDataSource: DataSource,
  ) {}

  async create(session: NewPlatformSession): Promise<void> {
    await this.masterDataSource.query(
      `INSERT INTO "platform_auth_sessions" (
         "id", "user_id", "refresh_token_hash", "expires_at", "last_used_at"
       ) VALUES ($1, $2, $3, $4, now())`,
      [session.id, session.userId, session.refreshTokenHash, session.expiresAt],
    );
  }

  async findForUpdate(manager: EntityManager, sessionId: string): Promise<LockedPlatformSession | null> {
    const rows: LockedPlatformSession[] = await manager.query(
      `SELECT session."id", session."user_id", session."refresh_token_hash",
              session."expires_at", session."revoked_at", user_account."status" AS "user_status"
       FROM "platform_auth_sessions" AS session
       INNER JOIN "platform_users" AS user_account ON user_account."id" = session."user_id"
       WHERE session."id" = $1
       FOR UPDATE OF session`,
      [sessionId],
    );
    return rows[0] ?? null;
  }

  async rotate(
    manager: EntityManager,
    sessionId: string,
    refreshTokenHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await manager.query(
      `UPDATE "platform_auth_sessions"
       SET "refresh_token_hash" = $2, "expires_at" = $3, "last_used_at" = now()
       WHERE "id" = $1 AND "revoked_at" IS NULL`,
      [sessionId, refreshTokenHash, expiresAt],
    );
  }

  async revoke(manager: EntityManager, sessionId: string): Promise<void> {
    await manager.query(
      `UPDATE "platform_auth_sessions"
       SET "revoked_at" = COALESCE("revoked_at", now())
       WHERE "id" = $1`,
      [sessionId],
    );
  }
}
