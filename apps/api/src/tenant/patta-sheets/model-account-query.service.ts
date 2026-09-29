import { Injectable, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { ModelAccountSheetResult } from './patta-sheets.service.js';

interface ModelRow { id: string }

@Injectable()
export class ModelAccountQueryService {
  async getModelAccountSheet(dataSource: DataSource, modelId: string): Promise<ModelAccountSheetResult> {
    const modelRows: ModelRow[] = await dataSource.query(
      `SELECT "id"::text AS "id" FROM "models" WHERE "id" = $1`, [modelId],
    );
    if (!modelRows[0]) {
      throw new NotFoundException({ code: 'MODEL_NOT_FOUND', message: 'Model topilmadi', details: {} });
    }
    const operations: ModelAccountSheetResult['operations'] = await dataSource.query(
      `SELECT "id"::text AS "model_operation_id", "name" AS "operation_name", "sort_order"
       FROM "model_operations" operation WHERE operation."model_id" = $1
          AND (operation."status" = 'ACTIVE' OR EXISTS (
          SELECT 1 FROM "patta_sheet_operation_snapshots" snapshot
          JOIN "patta_sheet_rows" sheet_row ON sheet_row."patta_sheet_operation_snapshot_id" = snapshot."id"
          JOIN "patta_sheets" sheet ON sheet."id" = sheet_row."patta_sheet_id"
          JOIN "patta_hisob" patta ON patta."id" = sheet."patta_hisob_id"
          WHERE snapshot."model_operation_id" = operation."id"
              AND patta."status" = 'ACTIVE' AND sheet."deleted_at" IS NULL AND sheet_row."deleted_at" IS NULL
         ))
       ORDER BY "sort_order", "name_normalized", "id"`,
      [modelId],
    );
    const rows: ModelAccountSheetResult['rows'] = await dataSource.query(
      `SELECT sheet_operation."model_operation_id"::text AS "model_operation_id",
          sheet_row."worker_id"::text AS "worker_id", worker."full_name" AS "worker_name",
          sum(sheet_row."quantity_snapshot")::text AS "quantity"
       FROM "patta_sheet_rows" sheet_row
       JOIN "patta_sheets" sheet ON sheet."id" = sheet_row."patta_sheet_id"
       JOIN "patta_hisob" patta ON patta."id" = sheet."patta_hisob_id"
       JOIN "patta_sheet_operation_snapshots" sheet_operation
         ON sheet_operation."id" = sheet_row."patta_sheet_operation_snapshot_id"
       JOIN "workers" worker ON worker."id" = sheet_row."worker_id"
       WHERE patta."model_id" = $1 AND patta."status" = 'ACTIVE'
         AND sheet."deleted_at" IS NULL AND sheet_row."deleted_at" IS NULL
       GROUP BY patta."model_id", sheet_operation."model_operation_id", sheet_row."worker_id", worker."full_name"
       ORDER BY worker."full_name", sheet_row."worker_id", sheet_operation."model_operation_id"`,
      [modelId],
    );
    return { model_id: modelId, operations, rows };
  }
}
