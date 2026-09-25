export class AddCompanyProvisioningFailure20260926000000 {
  name = 'AddCompanyProvisioningFailure20260926000000';

  async up(queryRunner) {
    await queryRunner.query('ALTER TABLE "companies" ADD "failure_step" varchar NULL');
    await queryRunner.query('ALTER TABLE "companies" ADD "failure_reason" text NULL');
  }

  async down(queryRunner) {
    await queryRunner.query('ALTER TABLE "companies" DROP COLUMN "failure_reason"');
    await queryRunner.query('ALTER TABLE "companies" DROP COLUMN "failure_step"');
  }
}
