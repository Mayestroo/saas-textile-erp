import { Check, Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

export const COMPANY_STATUSES = ['PROVISIONING', 'ACTIVE', 'SUSPENDED', 'FAILED', 'ARCHIVED'] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

@Entity({ name: 'companies' })
@Unique('uq_companies_slug', ['slug'])
@Unique('uq_companies_db_name', ['dbName'])
@Check('ck_companies_status', `"status" IN ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'FAILED', 'ARCHIVED')`)
@Check('ck_companies_name_not_empty', 'length(trim("name")) > 0')
@Check('ck_companies_slug_not_empty', 'length(trim("slug")) > 0')
export class CompanyEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'varchar' })
  slug!: string;

  @Column({ type: 'varchar' })
  status!: CompanyStatus;

  @Column({ name: 'db_name', type: 'varchar' })
  dbName!: string;

  @Column({ name: 'db_connection_ciphertext', type: 'text', nullable: true })
  dbConnectionCiphertext!: string | null;

  @Column({ name: 'schema_version', type: 'varchar', nullable: true })
  schemaVersion!: string | null;

  @Column({ type: 'varchar', default: 'Asia/Tashkent' })
  timezone!: string;

  @Column({ name: 'provisioning_status', type: 'varchar', nullable: true })
  provisioningStatus!: string | null;

  @Column({ name: 'failure_step', type: 'varchar', nullable: true })
  failureStep!: string | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason!: string | null;

  @Column({ name: 'default_admin_required', type: 'boolean', default: false })
  defaultAdminRequired!: boolean;

  @Column({ name: 'last_migration_at', type: 'timestamptz', nullable: true })
  lastMigrationAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
