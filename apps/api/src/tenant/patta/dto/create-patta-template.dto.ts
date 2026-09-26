import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsString, IsUUID, ValidateIf } from 'class-validator';
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

export class CreatePattaTemplateDto {
  @IsString()
  @IsUUID()
  model_id!: string;

  @Transform(({ value }) => canonicalRequired(value))
  @IsString()
  @IsNotEmpty()
  name!: string;

  @Transform(({ value }) => canonicalRequired(value))
  @IsString()
  @IsNotEmpty()
  konveyer!: string;

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
}
