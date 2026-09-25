export class AddDefaultAdminRequirement20260926000100 {
  name = 'AddDefaultAdminRequirement20260926000100';

  async up(queryRunner) {
    await queryRunner.query(
      'ALTER TABLE "companies" ADD "default_admin_required" boolean NOT NULL DEFAULT false',
    );
  }

  async down(queryRunner) {
    await queryRunner.query('ALTER TABLE "companies" DROP COLUMN "default_admin_required"');
  }
}
