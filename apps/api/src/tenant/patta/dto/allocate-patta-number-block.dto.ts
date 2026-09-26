import { IsUUID } from 'class-validator';

export class AllocatePattaNumberBlockDto {
  @IsUUID()
  device_id!: string;
}
