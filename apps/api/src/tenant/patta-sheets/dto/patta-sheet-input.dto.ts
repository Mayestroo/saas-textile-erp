import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { canonicalizeBusinessName } from '../../models/business-name.js';

function canonical(value: unknown): unknown {
  return typeof value === 'string' ? canonicalizeBusinessName(value) : value;
}

export class PattaSheetOperationSnapshotInputDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  model_operation_id!: string;

  @IsString()
  @Matches(/^(PATTA|CUSTOM)$/)
  source_type!: 'PATTA' | 'CUSTOM';

  @ValidateIf((input: PattaSheetOperationSnapshotInputDto) => input.source_type === 'PATTA')
  @IsUUID()
  source_patta_operation_snapshot_id!: string | null;

  @Transform(({ value }) => canonical(value))
  @IsString()
  @IsNotEmpty()
  operation_name_snapshot!: string;

  @IsString()
  @Matches(/^(0|[1-9][0-9]*)\.[0-9]{2}$/)
  unit_price_snapshot!: string;

  @IsInt()
  @Min(0)
  sort_order!: number;
}

export class PattaSheetRowInputDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  patta_sheet_operation_snapshot_id!: string;

  @IsString()
  @Matches(/^[1-9][0-9]*$/)
  worker_id!: string;

  @IsInt()
  @Min(1)
  quantity_snapshot!: number;

  @IsBoolean()
  nuqson!: boolean;

  @IsString()
  entered_badge_number!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i)
  deleted_at?: string | null;

  @IsOptional()
  @ValidateIf((_input: PattaSheetRowInputDto, value: unknown) => value !== null)
  @IsUUID()
  deleted_by?: string | null;
}

export class PattaSheetAggregateInputDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  patta_hisob_id!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i)
  entered_at!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  business_date!: string;

  @IsOptional()
  @IsString()
  deleted_at?: string | null;

  @IsOptional()
  @ValidateIf((_input: PattaSheetAggregateInputDto, value: unknown) => value !== null)
  @IsUUID()
  deleted_by?: string | null;

  @IsOptional()
  @Transform(({ value }) => canonical(value))
  @IsString()
  @IsNotEmpty()
  conveyor_snapshot?: string | null;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PattaSheetOperationSnapshotInputDto)
  operation_snapshots!: PattaSheetOperationSnapshotInputDto[];

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PattaSheetRowInputDto)
  rows!: PattaSheetRowInputDto[];

  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  depends_on_event_ids!: string[];

  @IsUUID()
  device_id!: string;
}

export class CreatePattaSheetDto extends PattaSheetAggregateInputDto {}

export class UpdatePattaSheetDto extends PattaSheetAggregateInputDto {
  @IsString()
  @Matches(/^[1-9][0-9]*$/)
  expected_version!: string;
}
