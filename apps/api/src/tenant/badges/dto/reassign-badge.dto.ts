import { IsISO8601, IsString, Matches, ValidateIf } from 'class-validator';

export class ReassignBadgeDto {
  @IsString()
  @Matches(/^[1-9][0-9]*$/)
  worker_id!: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsISO8601({ strict: true })
  @Matches(/(?:Z|[+-][0-9]{2}:[0-9]{2})$/)
  effective_at?: string;
}
