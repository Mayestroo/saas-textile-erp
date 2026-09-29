import { Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

@Injectable()
export class PattaSequenceInitializer {
  async initialize(dataSource: DataSource, pattaStart: bigint, partiyaStart: bigint = pattaStart): Promise<void> {
    if (pattaStart <= 0n || pattaStart > MAX_POSTGRES_BIGINT) {
      throw new Error('Patta number start must be between 1 and PostgreSQL BIGINT maximum');
    }
    if (partiyaStart <= 0n || partiyaStart > MAX_POSTGRES_BIGINT) {
      throw new Error('Partiya number start must be between 1 and PostgreSQL BIGINT maximum');
    }

    await dataSource.query(
      `INSERT INTO "patta_number_sequence" ("id", "next_number", "version")
       VALUES (1, $1::bigint, 1)
       ON CONFLICT ("id") DO NOTHING`,
      [pattaStart.toString()],
    );
    await dataSource.query(
      `INSERT INTO "patta_partiya_number_sequence" ("id", "next_number", "version")
       VALUES (1, $1::bigint, 1)
       ON CONFLICT ("id") DO NOTHING`,
      [partiyaStart.toString()],
    );
  }
}
