import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsString, ValidateIf } from 'class-validator';
import { canonicalizeWorkerName } from '../worker-name.js';

export class CreateWorkerDto {
  @Transform(({ value }) => typeof value === 'string' ? canonicalizeWorkerName(value) : value)
  @IsString()
  @IsNotEmpty()
  full_name!: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';
}
