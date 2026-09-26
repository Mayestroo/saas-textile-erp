import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsString, IsUUID, Matches, ValidateIf } from 'class-validator';
import { canonicalizeBusinessName } from '../../models/business-name.js';

function canonicalRequired(value: unknown): unknown {
  return typeof value === 'string' ? canonicalizeBusinessName(value) : value;
}

function canonicalOptional(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  return canonicalizeBusinessName(value) || null;
}

export class UpdatePattaTemplateDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID()
  model_id?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }) => canonicalRequired(value))
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }) => canonicalRequired(value))
  @IsString()
  @IsNotEmpty()
  konveyer?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @Transform(({ value }) => canonicalOptional(value))
  @IsString()
  razmer?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @Transform(({ value }) => canonicalOptional(value))
  @IsString()
  rang?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';

  @IsString()
  @Matches(/^[1-9][0-9]*$/)
  expected_version!: string;
}
