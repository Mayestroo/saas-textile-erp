import { Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'platform_user_roles' })
export class PlatformUserRoleEntity {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @PrimaryColumn({ name: 'role_id', type: 'uuid' })
  roleId!: string;
}
