import { IsISO8601, IsString, Matches, ValidateIf } from 'class-validator';

export class ChangeOperationPriceDto {
  @IsString()
  @Matches(/^\d{1,12}(?:\.\d{1,2})?$/)
  price!: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
  @IsISO8601({ strict: true, strictSeparator: true })
  effective_from?: string;

  @IsString()
  @Matches(/^[1-9][0-9]*$/)
  expected_version!: string;
}
