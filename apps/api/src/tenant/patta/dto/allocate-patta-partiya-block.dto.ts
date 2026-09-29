import { IsUUID } from 'class-validator';

export class AllocatePattaPartiyaBlockDto {
  @IsUUID()
  device_id!: string;
}
