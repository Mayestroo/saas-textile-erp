import { Check, Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

export const DEVICE_STATUSES = ['ACTIVE', 'BLOCKED', 'REPLACED'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

@Entity({ name: 'devices' })
@Unique('uq_devices_installation_id', ['installationId'])
@Unique('uq_devices_id_company_id', ['id', 'companyId'])
@Check('ck_devices_status', `"status" IN ('ACTIVE', 'BLOCKED', 'REPLACED')`)
@Check('ck_devices_seen_order', '"last_seen_at" >= "first_seen_at"')
@Check('ck_devices_fingerprint_not_empty', 'length(trim("hardware_fingerprint_hash")) > 0')
export class DeviceEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'company_id', type: 'uuid' })
  companyId!: string;

  @Column({ name: 'installation_id', type: 'uuid' })
  installationId!: string;

  @Column({ name: 'hardware_fingerprint_hash', type: 'text' })
  hardwareFingerprintHash!: string;

  @Column({ name: 'device_name', type: 'varchar' })
  deviceName!: string;

  @Column({ type: 'varchar' })
  status!: DeviceStatus;

  @Column({ name: 'first_seen_at', type: 'timestamptz' })
  firstSeenAt!: Date;

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
