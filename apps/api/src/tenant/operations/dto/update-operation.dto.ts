import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsString, Matches, Max, Min, ValidateIf } from 'class-validator';
import { canonicalizeBusinessName } from '../../models/business-name.js';

export class UpdateOperationDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }) => typeof value === 'string' ? canonicalizeBusinessName(value) : value)
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  sort_order?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';

  @IsString()
  @Matches(/^[1-9][0-9]*$/)
  expected_version!: string;
}
