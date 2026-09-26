import { IsISO8601, IsString, Matches, ValidateIf } from 'class-validator';

export class ListOperationPricesDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
  @IsISO8601({ strict: true, strictSeparator: true })
  effective_at?: string;
}
