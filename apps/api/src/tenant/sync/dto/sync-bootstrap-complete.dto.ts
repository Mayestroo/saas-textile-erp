import { IsUUID } from 'class-validator';

export class SyncBootstrapCompleteDto {
  @IsUUID()
  device_id!: string;
}
