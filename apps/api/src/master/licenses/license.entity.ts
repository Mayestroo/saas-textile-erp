import { Check, Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export const LICENSE_STATUSES = ['ACTIVE', 'REVOKED', 'EXPIRED'] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

@Entity({ name: 'licenses' })
@Check('ck_licenses_status', `"status" IN ('ACTIVE', 'REVOKED', 'EXPIRED')`)
@Check('ck_licenses_valid_dates', '"valid_until" >= "issued_at" AND "offline_grace_until" >= "valid_until"')
@Check('ck_licenses_revoked_at', `("status" = 'REVOKED') = ("revoked_at" IS NOT NULL)`)
@Check('ck_licenses_signed_license_not_empty', 'length(trim("signed_license")) > 0')
export class LicenseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'company_id', type: 'uuid' })
  companyId!: string;

  @Column({ name: 'device_id', type: 'uuid' })
  deviceId!: string;

  @Column({ name: 'signed_license', type: 'text' })
  signedLicense!: string;

  @Column({ name: 'issued_at', type: 'timestamptz' })
  issuedAt!: Date;

  @Column({ name: 'valid_until', type: 'timestamptz' })
  validUntil!: Date;

  @Column({ name: 'offline_grace_until', type: 'timestamptz' })
  offlineGraceUntil!: Date;

  @Column({ type: 'varchar' })
  status!: LicenseStatus;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
