import { Check, Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity({ name: 'platform_roles' })
@Unique('uq_platform_roles_name', ['name'])
@Check('ck_platform_roles_name_not_empty', 'length(trim("name")) > 0')
export class PlatformRoleEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  name!: string;
}
