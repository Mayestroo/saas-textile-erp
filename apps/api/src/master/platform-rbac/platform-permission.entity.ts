import { Check, Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity({ name: 'platform_permissions' })
@Unique('uq_platform_permissions_code', ['code'])
@Check('ck_platform_permissions_code_not_empty', 'length(trim("code")) > 0')
export class PlatformPermissionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  code!: string;

  @Column({ type: 'varchar', nullable: true })
  description!: string | null;
}
