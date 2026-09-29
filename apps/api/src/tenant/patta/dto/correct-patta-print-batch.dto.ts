import { Transform, Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsNotEmpty, IsString, IsUUID, Matches, Min, ValidateNested } from 'class-validator';
import { canonicalizeBusinessName } from '../../models/business-name.js';

function canonicalString(value: unknown): unknown {
  return typeof value === 'string' ? canonicalizeBusinessName(value) : value;
}

export class CorrectPattaPrintBatchSizeDto {
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

export class CorrectPattaPrintBatchDto {
  @IsString()
  @Matches(/^[1-9][0-9]*$/)
  expected_version!: string;

  @Transform(({ value }) => canonicalString(value))
  @IsString()
  @IsNotEmpty()
  @Matches(/^.{3,500}$/)
  correction_reason!: string;

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
  @Type(() => CorrectPattaPrintBatchSizeDto)
  size_distribution!: CorrectPattaPrintBatchSizeDto[];

  @IsUUID()
  device_id!: string;
}
