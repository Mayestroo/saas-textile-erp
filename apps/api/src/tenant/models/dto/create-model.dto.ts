import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsString, ValidateIf } from 'class-validator';
import { canonicalizeBusinessName } from '../business-name.js';

export class CreateModelDto {
  @Transform(({ value }) => typeof value === 'string' ? canonicalizeBusinessName(value) : value)
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';
}
