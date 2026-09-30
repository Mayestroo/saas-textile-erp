import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';

export class ModelAccountAdjustmentInputDto {
  @IsUUID()
  model_id!: string;

  @IsUUID()
  model_operation_id!: string;

  @IsString()
  @Matches(/^[1-9][0-9]*$/)
  worker_id!: string;

  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  quantity!: number;

  @IsString()
  @Matches(/^(0|[1-9][0-9]*)\.[0-9]{2}$/)
  unit_price_snapshot!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i)
  entered_at!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  business_date!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i)
  deleted_at?: string | null;

  @IsOptional()
  @IsUUID()
  deleted_by?: string | null;

  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  depends_on_event_ids!: string[];
}
