import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { canonicalizeBusinessName } from '../../models/business-name.js';

function optionalQueryInteger(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    return value;
  }
  return Number(value);
}

export class ListPattaDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }) => typeof value === 'string' ? canonicalizeBusinessName(value) : value)
  @IsString()
  @IsNotEmpty()
  partiya_number?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID()
  model_id?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^[1-9][0-9]*$/)
  patta_number?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsDateString()
  created_from?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsDateString()
  created_to?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }) => optionalQueryInteger(value))
  @IsInt()
  @Min(1)
  page?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }) => optionalQueryInteger(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
