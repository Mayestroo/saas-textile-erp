export const MATERIALIZE_BOOTSTRAP_ITEMS_SQL = `
  WITH reference_projection (
    "entity_order", "entity_type", "entity_id", "payload_json"
  ) AS (
    SELECT 1, 'workers', worker."id"::text,
      jsonb_build_object(
        'projection_version', 1, 'entity_type', 'workers',
        'entity_id', worker."id"::text, 'entity_version', worker."version"::text,
        'data', jsonb_build_object(
          'id', worker."id"::text, 'full_name', worker."full_name",
          'status', worker."status", 'version', worker."version"::text,
          'created_at', to_char(worker."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'updated_at', to_char(worker."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        )
      )
    FROM "workers" AS worker

    UNION ALL
    SELECT 2, 'worker_badge_history', badge."id"::text,
      jsonb_build_object(
        'projection_version', 1, 'entity_type', 'worker_badge_history',
        'entity_id', badge."id"::text, 'entity_version', NULL,
        'data', jsonb_build_object(
          'id', badge."id"::text, 'badge_number', badge."badge_number",
          'worker_id', badge."worker_id"::text,
          'valid_from', to_char(badge."valid_from" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'valid_to', CASE WHEN badge."valid_to" IS NULL THEN NULL ELSE
            to_char(badge."valid_to" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
          'created_at', to_char(badge."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        )
      )
    FROM "worker_badge_history" AS badge

    UNION ALL
    SELECT 3, 'models', model."id"::text,
      jsonb_build_object(
        'projection_version', 1, 'entity_type', 'models',
        'entity_id', model."id"::text, 'entity_version', model."version"::text,
        'data', jsonb_build_object(
          'id', model."id"::text, 'name', model."name", 'status', model."status",
          'version', model."version"::text,
          'created_at', to_char(model."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'updated_at', to_char(model."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        )
      )
    FROM "models" AS model

    UNION ALL
    SELECT 4, 'model_operations', operation."id"::text,
      jsonb_build_object(
        'projection_version', 1, 'entity_type', 'model_operations',
        'entity_id', operation."id"::text, 'entity_version', operation."version"::text,
        'data', jsonb_build_object(
          'id', operation."id"::text, 'model_id', operation."model_id"::text,
          'name', operation."name", 'sort_order', operation."sort_order",
          'status', operation."status", 'version', operation."version"::text,
          'created_at', to_char(operation."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'updated_at', to_char(operation."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        )
      )
    FROM "model_operations" AS operation

    UNION ALL
    SELECT 5, 'model_operation_prices', price."id"::text,
      jsonb_build_object(
        'projection_version', 1, 'entity_type', 'model_operation_prices',
        'entity_id', price."id"::text, 'entity_version', NULL,
        'data', jsonb_build_object(
          'id', price."id"::text, 'operation_id', price."operation_id"::text,
          'price', price."price"::text,
          'valid_from', to_char(price."valid_from" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'valid_to', CASE WHEN price."valid_to" IS NULL THEN NULL ELSE
            to_char(price."valid_to" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
          'created_at', to_char(price."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        )
      )
    FROM "model_operation_prices" AS price

    UNION ALL
    SELECT 6, 'patta_templates', template."id"::text,
      jsonb_build_object(
        'projection_version', 1, 'entity_type', 'patta_templates',
        'entity_id', template."id"::text, 'entity_version', template."version"::text,
        'data', jsonb_build_object(
          'id', template."id"::text, 'name', template."name",
          'model_id', template."model_id"::text, 'konveyer', template."konveyer",
          'razmer', template."razmer", 'rang', template."rang",
          'status', template."status", 'version', template."version"::text,
          'created_at', to_char(template."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'updated_at', to_char(template."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        )
      )
    FROM "patta_templates" AS template

    UNION ALL
    SELECT 7, 'patta_hisob', patta."id"::text,
      jsonb_build_object(
        'projection_version', 1, 'entity_type', 'patta_hisob',
        'entity_id', patta."id"::text, 'entity_version', patta."version"::text,
        'data', jsonb_build_object(
          'id', patta."id"::text, 'partiya_number', patta."partiya_number",
          'patta_number', patta."patta_number"::text, 'model_id', patta."model_id"::text,
          'model_name_snapshot', patta."model_name_snapshot", 'template_id', patta."template_id"::text,
          'konveyer_snapshot', patta."konveyer_snapshot", 'razmer', patta."razmer",
          'rang', patta."rang", 'ish_soni', patta."ish_soni",
          'created_device_id', patta."created_device_id"::text,
          'created_from_block_id', patta."created_from_block_id"::text,
          'created_at', to_char(patta."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'client_created_at', CASE WHEN patta."client_created_at" IS NULL THEN NULL ELSE
            to_char(patta."client_created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
          'occurred_at', CASE WHEN patta."occurred_at" IS NULL THEN NULL ELSE
            to_char(patta."occurred_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
        )
      )
    FROM "patta_hisob" AS patta

    UNION ALL
    SELECT 8, 'patta_operation_snapshots', snapshot."id"::text,
      jsonb_build_object(
        'projection_version', 1, 'entity_type', 'patta_operation_snapshots',
        'entity_id', snapshot."id"::text, 'entity_version', NULL,
        'data', jsonb_build_object(
          'id', snapshot."id"::text, 'patta_hisob_id', snapshot."patta_hisob_id"::text,
          'operation_id', snapshot."operation_id"::text,
          'operation_name_snapshot', snapshot."operation_name_snapshot",
          'unit_price_snapshot', snapshot."unit_price_snapshot"::text,
          'sort_order', snapshot."sort_order",
          'created_at', to_char(snapshot."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        )
      )
    FROM "patta_operation_snapshots" AS snapshot

    UNION ALL
    SELECT 9, 'patta_number_blocks', block."id"::text,
      jsonb_build_object(
        'projection_version', 1, 'entity_type', 'patta_number_blocks',
        'entity_id', block."id"::text, 'entity_version', NULL,
        'data', jsonb_build_object(
          'id', block."id"::text, 'device_id', block."device_id"::text,
          'range_start', block."range_start"::text, 'range_end', block."range_end"::text,
          'reported_used_count', block."reported_used_count"::text,
          'status', block."status",
          'allocated_at', to_char(block."allocated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'exhausted_at', CASE WHEN block."exhausted_at" IS NULL THEN NULL ELSE
            to_char(block."exhausted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
        )
      )
    FROM "patta_number_blocks" AS block
  )
  INSERT INTO "bootstrap_items"
    ("session_id", "order_key", "entity_type", "entity_id", "projection_version", "payload_json")
  SELECT $1::uuid,
         row_number() OVER (ORDER BY "entity_order", "entity_id")::bigint,
         "entity_type", "entity_id", 1, "payload_json"
  FROM reference_projection
  WHERE "entity_type" NOT LIKE 'patta%'
     OR ($2::smallint = 2 AND "entity_type" IN ('patta_templates', 'patta_number_blocks'))
  ORDER BY "entity_order", "entity_id"
`;

export const MATERIALIZE_PATTA_V2_BOOTSTRAP_ITEMS_SQL = `
  WITH patta_projection (
    "entity_order", "entity_type", "entity_id", "entity_version", "payload_json"
  ) AS (
    SELECT 10, 'patta_hisob', patta."id"::text, patta."version"::text,
      jsonb_build_object(
        'projection_version', 2, 'entity_type', 'patta_hisob',
        'entity_id', patta."id"::text, 'entity_version', patta."version"::text,
        'data', jsonb_build_object(
          'id', patta."id"::text, 'partiya_number', patta."partiya_number",
          'patta_number', patta."patta_number"::text, 'model_id', patta."model_id"::text,
          'model_name_snapshot', patta."model_name_snapshot", 'template_id', patta."template_id"::text,
          'konveyer_snapshot', patta."konveyer_snapshot", 'razmer', patta."razmer", 'rang', patta."rang",
          'ish_soni', patta."ish_soni", 'legacy_operation_count', patta."legacy_operation_count",
          'status', patta."status", 'print_batch_id', NULL,
          'created_device_id', patta."created_device_id"::text,
          'created_from_block_id', patta."created_from_block_id"::text,
          'created_at', to_char(patta."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'client_created_at', CASE WHEN patta."client_created_at" IS NULL THEN NULL ELSE
            to_char(patta."client_created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
          'occurred_at', CASE WHEN patta."occurred_at" IS NULL THEN NULL ELSE
            to_char(patta."occurred_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
        )
      )
    FROM "patta_hisob" patta WHERE patta."print_batch_id" IS NULL

    UNION ALL
    SELECT 11, 'patta_operation_snapshots', snapshot."id"::text, NULL,
      jsonb_build_object(
        'projection_version', 2, 'entity_type', 'patta_operation_snapshots',
        'entity_id', snapshot."id"::text, 'entity_version', NULL,
        'data', jsonb_build_object(
          'id', snapshot."id"::text, 'patta_hisob_id', snapshot."patta_hisob_id"::text,
          'operation_id', snapshot."operation_id"::text,
          'operation_name_snapshot', snapshot."operation_name_snapshot",
          'unit_price_snapshot', snapshot."unit_price_snapshot"::text,
          'sort_order', snapshot."sort_order",
          'created_at', to_char(snapshot."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        )
      )
    FROM "patta_operation_snapshots" snapshot
    JOIN "patta_hisob" patta ON patta."id" = snapshot."patta_hisob_id"
    WHERE patta."print_batch_id" IS NULL

    UNION ALL
    SELECT 12, 'patta_partiya_number_blocks', block."id"::text, NULL,
      jsonb_build_object(
        'projection_version', 2, 'entity_type', 'patta_partiya_number_blocks',
        'entity_id', block."id"::text, 'entity_version', NULL,
        'data', jsonb_build_object(
          'id', block."id"::text, 'device_id', block."device_id"::text,
          'range_start', block."range_start"::text, 'range_end', block."range_end"::text,
          'reported_used_count', block."reported_used_count"::text, 'status', block."status",
          'allocated_at', to_char(block."allocated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'exhausted_at', CASE WHEN block."exhausted_at" IS NULL THEN NULL ELSE
            to_char(block."exhausted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
        )
      )
    FROM "patta_partiya_number_blocks" block

    UNION ALL
    SELECT 13, 'patta_print_batches', batch."id"::text, batch."version"::text,
      jsonb_build_object(
        'projection_version', 2, 'entity_type', 'patta_print_batches',
        'entity_id', batch."id"::text, 'entity_version', batch."version"::text,
        'data', jsonb_build_object(
          'id', batch."id"::text, 'model_id', batch."model_id"::text,
          'model_name_snapshot', batch."model_name_snapshot", 'partiya_number', batch."partiya_number",
          'partiya_block_id', batch."partiya_block_id"::text, 'ish_soni', batch."ish_soni",
          'rang', batch."rang", 'status', batch."status", 'version', batch."version"::text,
          'revision', batch."revision", 'corrected_from_batch_id', batch."corrected_from_batch_id"::text,
          'created_by', batch."created_by"::text, 'created_device_id', batch."created_device_id"::text,
          'created_at', to_char(batch."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'updated_at', to_char(batch."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'printed_at', CASE WHEN batch."printed_at" IS NULL THEN NULL ELSE
            to_char(batch."printed_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
          'size_distribution', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', size."id"::text, 'print_batch_id', size."print_batch_id"::text,
              'razmer', size."razmer", 'patta_count', size."patta_count", 'sort_order', size."sort_order"
            ) ORDER BY size."sort_order", size."razmer")
            FROM "patta_print_batch_sizes" size WHERE size."print_batch_id" = batch."id"
          ), '[]'::jsonb),
          'pattas', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', patta."id"::text, 'partiya_number', patta."partiya_number",
              'patta_number', patta."patta_number"::text, 'model_id', patta."model_id"::text,
              'model_name_snapshot', patta."model_name_snapshot", 'template_id', patta."template_id"::text,
              'konveyer_snapshot', patta."konveyer_snapshot", 'razmer', patta."razmer", 'rang', patta."rang",
              'ish_soni', patta."ish_soni", 'legacy_operation_count', patta."legacy_operation_count",
              'status', patta."status", 'version', patta."version"::text,
              'print_batch_id', patta."print_batch_id"::text,
              'created_device_id', patta."created_device_id"::text,
              'created_from_block_id', patta."created_from_block_id"::text,
              'created_at', to_char(patta."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
              'client_created_at', CASE WHEN patta."client_created_at" IS NULL THEN NULL ELSE
                to_char(patta."client_created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
              'occurred_at', CASE WHEN patta."occurred_at" IS NULL THEN NULL ELSE
                to_char(patta."occurred_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
              'operations', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', snapshot."id"::text, 'patta_hisob_id', snapshot."patta_hisob_id"::text,
                  'operation_id', snapshot."operation_id"::text,
                  'operation_name_snapshot', snapshot."operation_name_snapshot",
                  'unit_price_snapshot', snapshot."unit_price_snapshot"::text,
                  'sort_order', snapshot."sort_order",
                  'created_at', to_char(snapshot."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                ) ORDER BY snapshot."sort_order", snapshot."operation_id")
                FROM "patta_operation_snapshots" snapshot WHERE snapshot."patta_hisob_id" = patta."id"
              ), '[]'::jsonb)
            ) ORDER BY patta."patta_number")
            FROM "patta_hisob" patta WHERE patta."print_batch_id" = batch."id"
          ), '[]'::jsonb)
        )
      )
    FROM "patta_print_batches" batch

    UNION ALL
    SELECT 14, 'patta_print_batch_sizes', size."id"::text, NULL,
      jsonb_build_object(
        'projection_version', 2, 'entity_type', 'patta_print_batch_sizes',
        'entity_id', size."id"::text, 'entity_version', NULL,
        'data', jsonb_build_object(
          'id', size."id"::text, 'print_batch_id', size."print_batch_id"::text,
          'razmer', size."razmer", 'patta_count', size."patta_count", 'sort_order', size."sort_order"
        )
      )
    FROM "patta_print_batch_sizes" size

    UNION ALL
    SELECT 15, 'patta_print_events', event."id"::text, NULL,
      jsonb_build_object(
        'projection_version', 2, 'entity_type', 'patta_print_events',
        'entity_id', event."id"::text, 'entity_version', NULL,
        'data', jsonb_build_object(
          'id', event."id"::text, 'batch_id', event."batch_id"::text,
          'revision', event."revision", 'kind', event."kind", 'outcome', event."outcome",
          'actor_user_id', event."actor_user_id"::text, 'device_id', event."device_id"::text,
          'created_at', to_char(event."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'printed_at', CASE WHEN batch."printed_at" IS NULL THEN NULL ELSE
            to_char(batch."printed_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
        )
      )
    FROM "patta_print_events" event JOIN "patta_print_batches" batch ON batch."id" = event."batch_id"

    UNION ALL
    SELECT 16, 'patta_sheets', sheet."id"::text, sheet."version"::text,
      jsonb_build_object(
        'projection_version', 2, 'entity_type', 'patta_sheets',
        'entity_id', sheet."id"::text, 'entity_version', sheet."version"::text,
        'data', jsonb_build_object(
          'id', sheet."id"::text, 'patta_hisob_id', sheet."patta_hisob_id"::text,
          'entered_at', to_char(sheet."entered_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'business_date', sheet."business_date"::text, 'conveyor_snapshot', sheet."conveyor_snapshot",
          'version', sheet."version"::text, 'created_by', sheet."created_by"::text,
          'created_at', to_char(sheet."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'updated_at', to_char(sheet."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'deleted_at', CASE WHEN sheet."deleted_at" IS NULL THEN NULL ELSE
            to_char(sheet."deleted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
          'deleted_by', sheet."deleted_by"::text,
          'operation_snapshots', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', snapshot."id"::text, 'patta_sheet_id', snapshot."patta_sheet_id"::text,
              'model_operation_id', snapshot."model_operation_id"::text,
              'source_type', snapshot."source_type",
              'source_patta_operation_snapshot_id', snapshot."source_patta_operation_snapshot_id"::text,
              'operation_name_snapshot', snapshot."operation_name_snapshot",
              'unit_price_snapshot', snapshot."unit_price_snapshot"::text,
              'sort_order', snapshot."sort_order",
              'created_at', to_char(snapshot."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            ) ORDER BY snapshot."sort_order", snapshot."model_operation_id")
            FROM "patta_sheet_operation_snapshots" snapshot WHERE snapshot."patta_sheet_id" = sheet."id"
          ), '[]'::jsonb),
          'rows', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', sheet_row."id"::text, 'patta_sheet_id', sheet_row."patta_sheet_id"::text,
              'patta_sheet_operation_snapshot_id', sheet_row."patta_sheet_operation_snapshot_id"::text,
              'worker_id', sheet_row."worker_id"::text, 'quantity_snapshot', sheet_row."quantity_snapshot",
              'nuqson', sheet_row."nuqson",
              'deleted_at', CASE WHEN sheet_row."deleted_at" IS NULL THEN NULL ELSE
                to_char(sheet_row."deleted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
              'deleted_by', sheet_row."deleted_by"::text,
              'created_at', to_char(sheet_row."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
              'updated_at', to_char(sheet_row."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            ) ORDER BY sheet_row."created_at", sheet_row."id")
            FROM "patta_sheet_rows" sheet_row WHERE sheet_row."patta_sheet_id" = sheet."id"
          ), '[]'::jsonb)
        )
      )
    FROM "patta_sheets" sheet
  )
  INSERT INTO "bootstrap_items"
    ("session_id", "order_key", "entity_type", "entity_id", "projection_version", "payload_json")
  SELECT $1::uuid,
         (SELECT count(*) FROM "bootstrap_items" WHERE "session_id" = $1::uuid)
           + row_number() OVER (ORDER BY "entity_order", "entity_id"),
         "entity_type", "entity_id", 2, "payload_json"
  FROM patta_projection
  ORDER BY "entity_order", "entity_id"
`;
