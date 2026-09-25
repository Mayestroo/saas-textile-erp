import { Check, Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

export const PLATFORM_USER_STATUSES = ['ACTIVE', 'BLOCKED'] as const;
export type PlatformUserStatus = (typeof PLATFORM_USER_STATUSES)[number];

@Entity({ name: 'platform_users' })
@Unique('uq_platform_users_email', ['email'])
@Check('ck_platform_users_status', `"status" IN ('ACTIVE', 'BLOCKED')`)
@Check('ck_platform_users_email_not_empty', 'length(trim("email"::text)) > 0')
@Check('ck_platform_users_password_hash_not_empty', 'length(trim("password_hash")) > 0')
export class PlatformUserEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'citext' })
  email!: string;

  @Column({ name: 'password_hash', type: 'text' })
  passwordHash!: string;

  @Column({ type: 'varchar' })
  status!: PlatformUserStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
