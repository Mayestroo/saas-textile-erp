import { Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

export interface LockedTenantSession {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  user_status: string;
}

export interface NewTenantSession {
  id: string;
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
}

@Injectable()
export class TenantSessionRepository {
  async create(dataSource: DataSource, session: NewTenantSession): Promise<void> {
    await dataSource.query(
      `INSERT INTO "auth_sessions" (
         "id", "user_id", "refresh_token_hash", "expires_at", "last_used_at"
       ) VALUES ($1, $2, $3, $4, now())`,
      [session.id, session.userId, session.refreshTokenHash, session.expiresAt],
    );
  }

  async findForUpdate(manager: EntityManager, sessionId: string): Promise<LockedTenantSession | null> {
    const rows: LockedTenantSession[] = await manager.query(
      `SELECT session."id", session."user_id", session."refresh_token_hash",
              session."expires_at", session."revoked_at", user_account."status" AS "user_status"
       FROM "auth_sessions" AS session
       INNER JOIN "users" AS user_account ON user_account."id" = session."user_id"
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
      `UPDATE "auth_sessions"
       SET "refresh_token_hash" = $2, "expires_at" = $3, "last_used_at" = now()
       WHERE "id" = $1 AND "revoked_at" IS NULL`,
      [sessionId, refreshTokenHash, expiresAt],
    );
  }

  async revoke(manager: EntityManager, sessionId: string): Promise<void> {
    await manager.query(
      `UPDATE "auth_sessions"
       SET "revoked_at" = COALESCE("revoked_at", now())
       WHERE "id" = $1`,
      [sessionId],
    );
  }
}
