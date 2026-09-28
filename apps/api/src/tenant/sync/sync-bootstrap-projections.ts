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
  ORDER BY "entity_order", "entity_id"
`;
