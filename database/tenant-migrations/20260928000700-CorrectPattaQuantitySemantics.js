export class CorrectPattaQuantitySemantics20260928000700 {
  name = 'CorrectPattaQuantitySemantics20260928000700';

  async up(queryRunner) {
    await queryRunner.query(`
      ALTER TABLE "patta_hisob"
        DROP CONSTRAINT "ck_patta_hisob_ish_soni_positive",
        DROP CONSTRAINT "ck_patta_hisob_konveyer_snapshot"
    `);
    await queryRunner.query(
      'ALTER TABLE "patta_hisob" RENAME COLUMN "ish_soni" TO "legacy_operation_count"',
    );
    await queryRunner.query(`
      ALTER TABLE "patta_hisob"
        ALTER COLUMN "legacy_operation_count" DROP NOT NULL,
        ADD COLUMN "ish_soni" integer NULL,
        ALTER COLUMN "konveyer_snapshot" DROP NOT NULL,
        ADD CONSTRAINT "ck_patta_hisob_legacy_operation_count_positive"
          CHECK ("legacy_operation_count" IS NULL OR "legacy_operation_count" > 0),
        ADD CONSTRAINT "ck_patta_hisob_ish_soni_positive"
          CHECK ("ish_soni" IS NULL OR "ish_soni" > 0),
        ADD CONSTRAINT "ck_patta_hisob_konveyer_snapshot"
          CHECK ("konveyer_snapshot" IS NULL OR (
            "konveyer_snapshot" <> '' AND
            "konveyer_snapshot" = "canonicalize_business_name"("konveyer_snapshot")
          ))
    `);
  }

  async down(queryRunner) {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "patta_hisob") THEN
          RAISE EXCEPTION 'cannot revert Patta quantity semantics while historical Pattas exist'
            USING ERRCODE = '55000', CONSTRAINT = 'ck_patta_quantity_legacy_safe_down';
        END IF;
      END
      $$
    `);
    await queryRunner.query(`
      ALTER TABLE "patta_hisob"
        DROP CONSTRAINT "ck_patta_hisob_ish_soni_positive",
        DROP CONSTRAINT "ck_patta_hisob_legacy_operation_count_positive",
        DROP CONSTRAINT "ck_patta_hisob_konveyer_snapshot",
        DROP COLUMN "ish_soni"
    `);
    await queryRunner.query(
      'ALTER TABLE "patta_hisob" RENAME COLUMN "legacy_operation_count" TO "ish_soni"',
    );
    await queryRunner.query(`
      ALTER TABLE "patta_hisob"
        ALTER COLUMN "ish_soni" SET NOT NULL,
        ALTER COLUMN "konveyer_snapshot" SET NOT NULL,
        ADD CONSTRAINT "ck_patta_hisob_ish_soni_positive" CHECK ("ish_soni" > 0),
        ADD CONSTRAINT "ck_patta_hisob_konveyer_snapshot" CHECK (
          "konveyer_snapshot" <> '' AND
          "konveyer_snapshot" = "canonicalize_business_name"("konveyer_snapshot")
        )
    `);
  }
}
