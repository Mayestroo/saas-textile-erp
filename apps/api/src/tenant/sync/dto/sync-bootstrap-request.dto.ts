import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class SyncBootstrapRequestDto {
  @IsUUID()
  device_id!: string;

  @IsOptional()
  @IsIn([1, 2, 3])
  protocol_version?: 1 | 2 | 3;
}
