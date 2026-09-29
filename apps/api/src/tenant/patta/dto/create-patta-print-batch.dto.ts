import { Transform, Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsNotEmpty, IsString, IsUUID, Min, ValidateNested } from 'class-validator';
import { canonicalizeBusinessName } from '../../models/business-name.js';

function canonicalString(value: unknown): unknown {
  return typeof value === 'string' ? canonicalizeBusinessName(value) : value;
}

export class PattaPrintBatchSizeDto {
  @Transform(({ value }) => canonicalString(value))
  @IsString()
  @IsNotEmpty()
  razmer!: string;

  @IsInt()
  @Min(1)
  patta_count!: number;

  @IsInt()
  @Min(0)
  sort_order!: number;
}

export class CreatePattaPrintBatchDto {
  @IsUUID()
  model_id!: string;

  @IsInt()
  @Min(1)
  ish_soni!: number;

  @Transform(({ value }) => canonicalString(value))
  @IsString()
  @IsNotEmpty()
  rang!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PattaPrintBatchSizeDto)
  size_distribution!: PattaPrintBatchSizeDto[];

  @IsUUID()
  device_id!: string;
}
