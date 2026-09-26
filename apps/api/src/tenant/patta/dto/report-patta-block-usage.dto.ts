import { IsString, IsUUID, Matches } from 'class-validator';

export class ReportPattaBlockUsageDto {
  @IsUUID()
  device_id!: string;

  @IsString()
  @Matches(/^(0|[1-9][0-9]*)$/)
  reported_used_count!: string;
}
