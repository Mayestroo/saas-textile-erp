import { IsUUID } from 'class-validator';

export class CancelPattaNumberBlockDto {
  @IsUUID()
  device_id!: string;
}
