import { Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'platform_role_permissions' })
export class PlatformRolePermissionEntity {
  @PrimaryColumn({ name: 'role_id', type: 'uuid' })
  roleId!: string;

  @PrimaryColumn({ name: 'permission_id', type: 'uuid' })
  permissionId!: string;
}
