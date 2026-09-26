import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsString, Matches, ValidateIf } from 'class-validator';
import { canonicalizeBusinessName } from '../business-name.js';

export class UpdateModelDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }) => typeof value === 'string' ? canonicalizeBusinessName(value) : value)
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';

  @IsString()
  @Matches(/^[1-9][0-9]*$/)
  expected_version!: string;
}
