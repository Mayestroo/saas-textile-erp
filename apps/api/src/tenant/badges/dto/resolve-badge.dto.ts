import { IsISO8601, Matches } from 'class-validator';

export class ResolveBadgeDto {
  @IsISO8601({ strict: true })
  @Matches(/(?:Z|[+-][0-9]{2}:[0-9]{2})$/)
  at!: string;
}
