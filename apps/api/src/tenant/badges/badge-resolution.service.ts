import { Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { badgeNotFound, invalidBadgeNumber, invalidBadgeTimestamp } from './badge-errors.js';

const ISO_TIMESTAMP_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

export interface BadgeAssignmentSummary {
  id: string;
  badge_number: string;
  valid_from: string;
  valid_to: string | null;
}

export interface BadgeResolution {
  worker_id: string;
  full_name: string;
  assignment: BadgeAssignmentSummary;
}

interface BadgeResolutionRow {
  id: string;
  badge_number: string;
  worker_id: string;
  full_name: string;
  valid_from: string;
  valid_to: string | null;
}

const RESOLUTION_COLUMNS = `history."id"::text AS "id", history."badge_number",
  history."worker_id"::text AS "worker_id", worker."full_name",
  to_char(history."valid_from" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "valid_from",
  CASE WHEN history."valid_to" IS NULL THEN NULL ELSE
    to_char(history."valid_to" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  END AS "valid_to"`;

function canonicalBadge(value: string): string {
  const badgeNumber = value.trim();
  if (!badgeNumber) {
    throw invalidBadgeNumber();
  }
  return badgeNumber;
}

function serialize(row: BadgeResolutionRow): BadgeResolution {
  return {
    worker_id: row.worker_id,
    full_name: row.full_name,
    assignment: {
      id: row.id,
      badge_number: row.badge_number,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
    },
  };
}

@Injectable()
export class BadgeResolutionService {
  async resolve(
    dataSource: DataSource,
    badgeNumberInput: string,
    performedAt: string,
  ): Promise<BadgeResolution> {
    if (!ISO_TIMESTAMP_WITH_OFFSET.test(performedAt) || !Number.isFinite(Date.parse(performedAt))) {
      throw invalidBadgeTimestamp();
    }
    const badgeNumber = canonicalBadge(badgeNumberInput);
    const rows: BadgeResolutionRow[] = await dataSource.query(
      `SELECT ${RESOLUTION_COLUMNS}
       FROM "worker_badge_history" AS history
       INNER JOIN "workers" AS worker ON worker."id" = history."worker_id"
       WHERE history."badge_number" = $1
         AND history."valid_from" <= $2::timestamptz
         AND (history."valid_to" IS NULL OR $2::timestamptz < history."valid_to")
       ORDER BY history."valid_from" DESC, history."id"
       LIMIT 1`,
      [badgeNumber, performedAt],
    );
    const row = rows[0];
    if (!row) {
      throw badgeNotFound();
    }
    return serialize(row);
  }

  async resolveCurrent(
    dataSource: DataSource,
    badgeNumberInput: string,
  ): Promise<BadgeResolution> {
    const badgeNumber = canonicalBadge(badgeNumberInput);
    const rows: BadgeResolutionRow[] = await dataSource.query(
      `SELECT ${RESOLUTION_COLUMNS}
       FROM "worker_badge_history" AS history
       INNER JOIN "workers" AS worker ON worker."id" = history."worker_id"
       WHERE history."badge_number" = $1
         AND history."valid_from" <= transaction_timestamp()
         AND (history."valid_to" IS NULL OR transaction_timestamp() < history."valid_to")
       ORDER BY history."valid_from" DESC, history."id"
       LIMIT 1`,
      [badgeNumber],
    );
    const row = rows[0];
    if (!row) {
      throw badgeNotFound();
    }
    return serialize(row);
  }
}
