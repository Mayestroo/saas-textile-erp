import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsString, Matches, Max, Min, ValidateIf } from 'class-validator';
import { canonicalizeBusinessName } from '../../models/business-name.js';

const DECIMAL_PRICE = /^\d{1,12}(?:\.\d{1,2})?$/;

export class CreateOperationDto {
  @Transform(({ value }) => typeof value === 'string' ? canonicalizeBusinessName(value) : value)
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @Matches(DECIMAL_PRICE)
  price!: string;

  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  sort_order!: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';
}
