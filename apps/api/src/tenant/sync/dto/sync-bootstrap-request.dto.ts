import { IsUUID } from 'class-validator';

export class SyncBootstrapRequestDto {
  @IsUUID()
  device_id!: string;
}
