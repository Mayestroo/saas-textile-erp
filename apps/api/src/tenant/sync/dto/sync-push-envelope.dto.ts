import { IsArray, IsUUID } from 'class-validator';

export class SyncPushEnvelopeDto {
  @IsUUID()
  device_id!: string;

  @IsArray()
  events!: unknown[];
}
