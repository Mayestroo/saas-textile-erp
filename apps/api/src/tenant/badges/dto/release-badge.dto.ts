import { IsISO8601, Matches, ValidateIf } from 'class-validator';

export class ReleaseBadgeDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsISO8601({ strict: true })
  @Matches(/(?:Z|[+-][0-9]{2}:[0-9]{2})$/)
  effective_at?: string;
}
