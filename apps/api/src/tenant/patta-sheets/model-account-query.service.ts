import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { DataSource } from 'typeorm';
import type {
  ConveyorAccountRow,
  ModelAccountContributionRow,
  ModelAccountOperationTotal,
  ModelAccountSheetV3,
  ModelAccountWorkerDetail,
} from '@textile/sync-protocol';
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
    const v3Rows: Array<{ present: boolean }> = await dataSource.query(
      `SELECT EXISTS (SELECT 1 FROM "patta_sheets" WHERE "model_id" = $1 AND "entry_kind" = 'STANDALONE')
        OR EXISTS (SELECT 1 FROM "model_account_adjustments" WHERE "model_id" = $1) AS "present"`,
      [modelId],
    );
    if (v3Rows[0]?.present === true) {
      throw new ConflictException({
        code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED',
        message: 'Bu Model hisob ma’lumotlarini ko‘rish uchun dasturni yangilang',
        details: {},
      });
    }
    const operations: ModelAccountSheetResult['operations'] = await dataSource.query(
      `SELECT "id"::text AS "model_operation_id", "name" AS "operation_name", "sort_order"
       FROM "model_operations" operation WHERE operation."model_id" = $1
          AND (operation."status" = 'ACTIVE' OR EXISTS (
           SELECT 1 FROM "patta_sheet_operation_snapshots" snapshot
           JOIN "patta_sheet_rows" sheet_row ON sheet_row."patta_sheet_operation_snapshot_id" = snapshot."id"
           JOIN "patta_sheets" sheet ON sheet."id" = sheet_row."patta_sheet_id"
           WHERE snapshot."model_operation_id" = operation."id"
               AND sheet."model_id" = operation."model_id"
               AND sheet."deleted_at" IS NULL AND sheet_row."deleted_at" IS NULL
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
        JOIN "patta_sheet_operation_snapshots" sheet_operation
         ON sheet_operation."id" = sheet_row."patta_sheet_operation_snapshot_id"
       JOIN "workers" worker ON worker."id" = sheet_row."worker_id"
        WHERE sheet."model_id" = $1
          AND sheet."deleted_at" IS NULL AND sheet_row."deleted_at" IS NULL
        GROUP BY sheet."model_id", sheet_operation."model_operation_id", sheet_row."worker_id", worker."full_name"
       ORDER BY worker."full_name", sheet_row."worker_id", sheet_operation."model_operation_id"`,
      [modelId],
    );
    return { model_id: modelId, operations, rows };
  }

  async getModelAccountSheetV3(dataSource: DataSource, modelId: string): Promise<ModelAccountSheetV3> {
    const modelRows: Array<{ id: string; name: string }> = await dataSource.query(
      `SELECT "id"::text AS "id", "name" FROM "models" WHERE "id" = $1`, [modelId],
    );
    const model = modelRows[0];
    if (!model) throw new NotFoundException({ code: 'MODEL_NOT_FOUND', message: 'Model topilmadi', details: {} });
    const operationRows: Array<{
      model_operation_id: string; operation_name: string; sort_order: number; version: string;
      status: 'ACTIVE' | 'INACTIVE'; current_price: string | null;
    }> = await dataSource.query(
      `SELECT operation."id"::text AS "model_operation_id", operation."name" AS "operation_name",
          operation."sort_order", operation."version"::text AS "version", operation."status",
          current_price."price"::text AS "current_price"
       FROM "model_operations" operation
       LEFT JOIN LATERAL (
         SELECT price."price" FROM "model_operation_prices" price
         WHERE price."operation_id" = operation."id"
           AND price."valid_from" <= transaction_timestamp()
           AND (price."valid_to" IS NULL OR transaction_timestamp() < price."valid_to")
         ORDER BY price."valid_from" DESC LIMIT 1
       ) current_price ON true
       WHERE operation."model_id" = $1
         AND (operation."status" = 'ACTIVE' OR EXISTS (
           SELECT 1 FROM "patta_sheet_rows" sheet_row
           JOIN "patta_sheets" sheet ON sheet."id" = sheet_row."patta_sheet_id"
           JOIN "patta_sheet_operation_snapshots" snapshot ON snapshot."id" = sheet_row."patta_sheet_operation_snapshot_id"
           WHERE sheet."model_id" = operation."model_id"
             AND snapshot."model_operation_id" = operation."id"
             AND sheet."deleted_at" IS NULL AND sheet_row."deleted_at" IS NULL
         ) OR EXISTS (
           SELECT 1 FROM "model_account_adjustments" adjustment
           WHERE adjustment."model_id" = operation."model_id"
             AND adjustment."model_operation_id" = operation."id" AND adjustment."deleted_at" IS NULL
         ))
       ORDER BY operation."sort_order", operation."name_normalized", operation."id"`,
      [modelId],
    );
    const pattaRows: Array<{
      entry_kind: 'PATTA_LINKED' | 'STANDALONE';
      model_operation_id: string; worker_id: string; worker_name: string;
      quantity: string; gross_amount: string;
    }> = await dataSource.query(
      `SELECT sheet."entry_kind", snapshot."model_operation_id"::text AS "model_operation_id",
          sheet_row."worker_id"::text AS "worker_id", worker."full_name" AS "worker_name",
          sum(sheet_row."quantity_snapshot")::text AS "quantity",
          sum(sheet_row."quantity_snapshot"::numeric * snapshot."unit_price_snapshot")::text AS "gross_amount"
       FROM "patta_sheet_rows" sheet_row
       JOIN "patta_sheets" sheet ON sheet."id" = sheet_row."patta_sheet_id"
       JOIN "patta_sheet_operation_snapshots" snapshot ON snapshot."id" = sheet_row."patta_sheet_operation_snapshot_id"
       JOIN "workers" worker ON worker."id" = sheet_row."worker_id"
       WHERE sheet."model_id" = $1 AND sheet."deleted_at" IS NULL AND sheet_row."deleted_at" IS NULL
       GROUP BY sheet."entry_kind", snapshot."model_operation_id", sheet_row."worker_id", worker."full_name"`,
      [modelId],
    );
    const manualRows: Array<{
      model_operation_id: string; worker_id: string; worker_name: string;
      quantity: string; gross_amount: string;
    }> = await dataSource.query(
      `SELECT adjustment."model_operation_id"::text AS "model_operation_id",
          adjustment."worker_id"::text AS "worker_id", worker."full_name" AS "worker_name",
          sum(adjustment."quantity")::text AS "quantity",
          sum(adjustment."quantity"::numeric * adjustment."unit_price_snapshot")::text AS "gross_amount"
       FROM "model_account_adjustments" adjustment
       JOIN "workers" worker ON worker."id" = adjustment."worker_id"
       WHERE adjustment."model_id" = $1 AND adjustment."deleted_at" IS NULL
       GROUP BY adjustment."model_operation_id", adjustment."worker_id", worker."full_name"`,
      [modelId],
    );

    const keyedRows = new Map<string, {
      worker_id: string; worker_name: string; model_operation_id: string;
      patta_quantity: Decimal; standalone_quantity: Decimal; manual_quantity: Decimal;
      patta_amount: Decimal; standalone_amount: Decimal; manual_amount: Decimal;
    }>();
    for (const row of pattaRows) {
      const key = `${row.model_operation_id}\u0000${row.worker_id}`;
      const current = keyedRows.get(key) ?? {
        worker_id: row.worker_id, worker_name: row.worker_name, model_operation_id: row.model_operation_id,
        patta_quantity: new Decimal(0), standalone_quantity: new Decimal(0), manual_quantity: new Decimal(0),
        patta_amount: new Decimal(0), standalone_amount: new Decimal(0), manual_amount: new Decimal(0),
      };
      if (row.entry_kind === 'PATTA_LINKED') {
        current.patta_quantity = current.patta_quantity.plus(row.quantity);
        current.patta_amount = current.patta_amount.plus(row.gross_amount);
      } else {
        current.standalone_quantity = current.standalone_quantity.plus(row.quantity);
        current.standalone_amount = current.standalone_amount.plus(row.gross_amount);
      }
      keyedRows.set(key, current);
    }
    for (const row of manualRows) {
      const key = `${row.model_operation_id}\u0000${row.worker_id}`;
      const current = keyedRows.get(key);
      if (current) {
        current.manual_quantity = current.manual_quantity.plus(row.quantity);
        current.manual_amount = current.manual_amount.plus(row.gross_amount);
      } else {
        keyedRows.set(key, {
          worker_id: row.worker_id, worker_name: row.worker_name, model_operation_id: row.model_operation_id,
          patta_quantity: new Decimal(0), standalone_quantity: new Decimal(0),
          manual_quantity: new Decimal(row.quantity), patta_amount: new Decimal(0),
          standalone_amount: new Decimal(0), manual_amount: new Decimal(row.gross_amount),
        });
      }
    }
    const contributionRows: ModelAccountContributionRow[] = [...keyedRows.values()]
      .map((row) => ({
        worker_id: row.worker_id,
        worker_name: row.worker_name,
        model_operation_id: row.model_operation_id,
        patta_quantity: row.patta_quantity.toFixed(0),
        standalone_quantity: row.standalone_quantity.toFixed(0),
        manual_quantity: row.manual_quantity.toFixed(0),
        total_quantity: row.patta_quantity.plus(row.standalone_quantity).plus(row.manual_quantity).toFixed(0),
        patta_amount: row.patta_amount.toFixed(2),
        standalone_amount: row.standalone_amount.toFixed(2),
        manual_amount: row.manual_amount.toFixed(2),
        gross_amount: row.patta_amount.plus(row.standalone_amount).plus(row.manual_amount).toFixed(2),
      }))
      .sort((left, right) => left.worker_name.localeCompare(right.worker_name) ||
        left.worker_id.localeCompare(right.worker_id) || left.model_operation_id.localeCompare(right.model_operation_id));
    const operations: ModelAccountOperationTotal[] = operationRows.map((operation) => {
      const rows = [...keyedRows.values()].filter((row) => row.model_operation_id === operation.model_operation_id);
      const pattaQuantity = rows.reduce((sum, row) => sum.plus(row.patta_quantity), new Decimal(0));
      const standaloneQuantity = rows.reduce((sum, row) => sum.plus(row.standalone_quantity), new Decimal(0));
      const manualQuantity = rows.reduce((sum, row) => sum.plus(row.manual_quantity), new Decimal(0));
      const grossAmount = rows.reduce((sum, row) => sum.plus(row.patta_amount).plus(row.manual_amount), new Decimal(0));
      const standaloneAmount = rows.reduce((sum, row) => sum.plus(row.standalone_amount), new Decimal(0));
      const manualAmount = rows.reduce((sum, row) => sum.plus(row.manual_amount), new Decimal(0));
      return {
        model_operation_id: operation.model_operation_id,
        operation_name: operation.operation_name,
        sort_order: operation.sort_order,
        version: operation.version,
        status: operation.status,
        current_price: operation.current_price === null ? null : new Decimal(operation.current_price).toFixed(2),
        quantity: pattaQuantity.plus(standaloneQuantity).plus(manualQuantity).toFixed(0),
        patta_quantity: pattaQuantity.toFixed(0),
        standalone_quantity: standaloneQuantity.toFixed(0),
        manual_quantity: manualQuantity.toFixed(0),
        gross_amount: grossAmount.plus(standaloneAmount).toFixed(2),
        patta_amount: rows.reduce((sum, row) => sum.plus(row.patta_amount), new Decimal(0)).toFixed(2),
        standalone_amount: standaloneAmount.toFixed(2),
        manual_amount: manualAmount.toFixed(2),
      };
    });
    return { model_id: modelId, model_name: model.name, operations, rows: contributionRows };
  }

  async getWorkerDetails(dataSource: DataSource, workerId: string): Promise<readonly ModelAccountWorkerDetail[]> {
    if (!/^[1-9][0-9]*$/.test(workerId)) throw new NotFoundException({
      code: 'WORKER_NOT_FOUND', message: 'Ishchi topilmadi', details: {},
    });
    const rows: ModelAccountWorkerDetail[] = await dataSource.query(
      `SELECT sheet."model_id"::text AS "model_id", sheet."model_name_snapshot" AS "model_name",
          snapshot."model_operation_id"::text AS "model_operation_id",
          snapshot."operation_name_snapshot" AS "operation_name",
          CASE WHEN sheet."entry_kind" = 'PATTA_LINKED' THEN 'PATTA' ELSE 'STANDALONE' END::text AS "source",
          sheet_row."quantity_snapshot"::text AS "quantity", snapshot."unit_price_snapshot"::text AS "unit_price_snapshot",
          (sheet_row."quantity_snapshot"::numeric * snapshot."unit_price_snapshot")::text AS "gross_amount",
          to_char(sheet."entered_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "entered_at",
          NULL::text AS "manual_adjustment_id", sheet."version"::text AS "version",
          NULL::text AS "deleted_at", NULL::text AS "deleted_by"
       FROM "patta_sheet_rows" sheet_row
       JOIN "patta_sheets" sheet ON sheet."id" = sheet_row."patta_sheet_id"
       JOIN "patta_sheet_operation_snapshots" snapshot ON snapshot."id" = sheet_row."patta_sheet_operation_snapshot_id"
       WHERE sheet_row."worker_id" = $1::bigint AND sheet."deleted_at" IS NULL AND sheet_row."deleted_at" IS NULL
       UNION ALL
       SELECT adjustment."model_id"::text, model."name", adjustment."model_operation_id"::text,
          operation."name", 'MANUAL'::text, adjustment."quantity"::text,
          adjustment."unit_price_snapshot"::text,
          (adjustment."quantity"::numeric * adjustment."unit_price_snapshot")::text,
          to_char(adjustment."entered_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          adjustment."id"::text, adjustment."version"::text,
          CASE WHEN adjustment."deleted_at" IS NULL THEN NULL ELSE
            to_char(adjustment."deleted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
          adjustment."deleted_by"::text
       FROM "model_account_adjustments" adjustment
       JOIN "models" model ON model."id" = adjustment."model_id"
       JOIN "model_operations" operation ON operation."id" = adjustment."model_operation_id"
       WHERE adjustment."worker_id" = $1::bigint
       ORDER BY "entered_at" DESC, "model_id", "model_operation_id", "source"`,
      [workerId],
    );
    return rows;
  }

  async getConveyorAccount(dataSource: DataSource): Promise<readonly ConveyorAccountRow[]> {
    const rows: ConveyorAccountRow[] = await dataSource.query(
      `WITH contributions AS (
         SELECT COALESCE(sheet."conveyor_snapshot", 'Noma’lum') AS "conveyor_label",
           sheet."model_id"::text AS "model_id", sheet."model_name_snapshot" AS "model_name",
           CASE WHEN sheet."entry_kind" = 'PATTA_LINKED' THEN 1 ELSE 0 END AS "patta_count",
           CASE WHEN sheet."entry_kind" = 'STANDALONE' THEN 1 ELSE 0 END AS "standalone_entry_count",
           0 AS "manual_adjustment_count", sheet."ish_soni"::numeric AS "ish_soni"
         FROM "patta_sheets" sheet WHERE sheet."deleted_at" IS NULL
         UNION ALL
         SELECT 'Noma’lum', adjustment."model_id"::text, model."name", 0, 0, 1, adjustment."quantity"::numeric
         FROM "model_account_adjustments" adjustment
         JOIN "models" model ON model."id" = adjustment."model_id"
         WHERE adjustment."deleted_at" IS NULL
       )
       SELECT "conveyor_label", "model_id", "model_name",
         sum("patta_count")::text AS "patta_count",
         sum("standalone_entry_count")::text AS "standalone_entry_count",
         sum("manual_adjustment_count")::text AS "manual_adjustment_count",
         sum("ish_soni")::text AS "ish_soni"
       FROM contributions
       GROUP BY "conveyor_label", "model_id", "model_name"
       ORDER BY "conveyor_label", "model_name", "model_id"`,
    );
    return rows;
  }
}
