import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, IsUUID, Min, ValidateIf } from 'class-validator';
import { canonicalizeBusinessName } from '../../models/business-name.js';

function canonicalString(value: unknown): unknown {
  return typeof value === 'string' ? canonicalizeBusinessName(value) : value;
}

export class GeneratePattaDto {
  @Transform(({ value }) => canonicalString(value))
  @IsString()
  @IsNotEmpty()
  partiya_number!: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID()
  model_id?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID()
  template_id?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }) => canonicalString(value))
  @IsString()
  @IsNotEmpty()
  konveyer?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @Transform(({ value }) => canonicalString(value))
  @IsString()
  @IsNotEmpty()
  razmer?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @Transform(({ value }) => canonicalString(value))
  @IsString()
  @IsNotEmpty()
  rang?: string | null;

  @IsInt()
  @Min(1)
  count!: number;

  @IsUUID()
  device_id!: string;
}
