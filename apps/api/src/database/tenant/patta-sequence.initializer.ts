import { Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

@Injectable()
export class PattaSequenceInitializer {
  async initialize(dataSource: DataSource, start: bigint): Promise<void> {
    if (start <= 0n || start > MAX_POSTGRES_BIGINT) {
      throw new Error('Patta number start must be between 1 and PostgreSQL BIGINT maximum');
    }

    await dataSource.query(
      `INSERT INTO "patta_number_sequence" ("id", "next_number", "version")
       VALUES (1, $1::bigint, 1)
       ON CONFLICT ("id") DO NOTHING`,
      [start.toString()],
    );
  }
}
