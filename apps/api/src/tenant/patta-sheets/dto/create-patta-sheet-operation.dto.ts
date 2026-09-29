import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, IsUUID, Matches, Max, Min } from 'class-validator';
import { canonicalizeBusinessName } from '../../models/business-name.js';

export class CreatePattaSheetOperationDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  model_id!: string;

  @Transform(({ value }) => typeof value === 'string' ? canonicalizeBusinessName(value) : value)
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @Matches(/^\d{1,12}(?:\.[0-9]{1,2})?$/)
  initial_price!: string;

  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  sort_order!: number;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i)
  effective_from!: string;

  @IsUUID()
  device_id!: string;
}
