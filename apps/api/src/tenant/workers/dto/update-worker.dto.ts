import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsString, Matches, ValidateIf } from 'class-validator';
import { canonicalizeWorkerName } from '../worker-name.js';

export class UpdateWorkerDto {
  @Transform(({ value }) => typeof value === 'string' ? canonicalizeWorkerName(value) : value)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  full_name?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';

  @IsString()
  @Matches(/^[1-9][0-9]*$/)
  expected_version!: string;
}
