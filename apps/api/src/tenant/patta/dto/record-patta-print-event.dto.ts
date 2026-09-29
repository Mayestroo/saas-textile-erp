import { IsIn, IsInt, IsUUID, Min } from 'class-validator';

export class RecordPattaPrintEventDto {
  @IsUUID()
  event_id!: string;

  @IsInt()
  @Min(1)
  revision!: number;

  @IsIn(['INITIAL', 'REPRINT', 'CORRECTED_REPRINT'])
  kind!: 'INITIAL' | 'REPRINT' | 'CORRECTED_REPRINT';

  @IsIn(['REQUESTED', 'SUCCEEDED', 'FAILED'])
  outcome!: 'REQUESTED' | 'SUCCEEDED' | 'FAILED';

  @IsUUID()
  device_id!: string;
}
