import { Transform } from 'class-transformer';
import { IsISO8601, IsString, Matches, MinLength, ValidateIf } from 'class-validator';

export class AssignBadgeDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MinLength(1)
  badge_number!: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsISO8601({ strict: true })
  @Matches(/(?:Z|[+-][0-9]{2}:[0-9]{2})$/)
  effective_at?: string;
}
