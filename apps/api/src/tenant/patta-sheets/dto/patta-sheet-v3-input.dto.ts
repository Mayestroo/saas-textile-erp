import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  isUUID,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { canonicalizeBusinessName } from '../../models/business-name.js';
import { PattaSheetRowInputDto } from './patta-sheet-input.dto.js';

function canonical(value: unknown): unknown {
  return typeof value === 'string' ? canonicalizeBusinessName(value) : value;
}

export type PattaSheetEntryKind = 'PATTA_LINKED' | 'STANDALONE';
export type PattaSheetOperationSource = 'PATTA' | 'MODEL' | 'CUSTOM';

@ValidatorConstraint({ name: 'pattaSheetV3PattaId', async: false })
class PattaSheetV3PattaIdConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const entryKind = (args.object as PattaSheetV3AggregateInputDto).entry_kind;
    return entryKind === 'PATTA_LINKED'
      ? typeof value === 'string' && isUUID(value)
      : value === null;
  }

  defaultMessage(args: ValidationArguments): string {
    const entryKind = (args.object as PattaSheetV3AggregateInputDto).entry_kind;
    return entryKind === 'PATTA_LINKED'
      ? 'PATTA_LINKED entry requires a Patta UUID'
      : 'STANDALONE entry must not reference a Patta';
  }
}

@ValidatorConstraint({ name: 'pattaSheetV3OperationSourceId', async: false })
class PattaSheetV3OperationSourceIdConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const sourceType = (args.object as PattaSheetV3OperationSnapshotInputDto).source_type;
    return sourceType === 'PATTA'
      ? typeof value === 'string' && isUUID(value)
      : value === null;
  }

  defaultMessage(args: ValidationArguments): string {
    const sourceType = (args.object as PattaSheetV3OperationSnapshotInputDto).source_type;
    return sourceType === 'PATTA'
      ? 'PATTA operation requires a source snapshot UUID'
      : 'MODEL and CUSTOM operations must not reference a Patta snapshot';
  }
}

export class PattaSheetV3OperationSnapshotInputDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  model_operation_id!: string;

  @IsString()
  @IsIn(['PATTA', 'MODEL', 'CUSTOM'])
  source_type!: PattaSheetOperationSource;

  @Validate(PattaSheetV3OperationSourceIdConstraint)
  source_patta_operation_snapshot_id!: string | null;

  @Transform(({ value }) => canonical(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  operation_name_snapshot!: string;

  @IsString()
  @Matches(/^(0|[1-9][0-9]*)\.[0-9]{2}$/)
  unit_price_snapshot!: string;

  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  sort_order!: number;
}

export class PattaSheetV3AggregateInputDto {
  @IsUUID()
  id!: string;

  @IsString()
  @IsIn(['PATTA_LINKED', 'STANDALONE'])
  entry_kind!: PattaSheetEntryKind;

  @Validate(PattaSheetV3PattaIdConstraint)
  patta_hisob_id!: string | null;

  @IsUUID()
  model_id!: string;

  @Transform(({ value }) => canonical(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  model_name_snapshot!: string;

  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  ish_soni!: number;

  @IsOptional()
  @Transform(({ value }) => canonical(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  partiya_number_snapshot?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^[1-9][0-9]*$/)
  @MaxLength(19)
  patta_number_snapshot?: string | null;

  @IsOptional()
  @Transform(({ value }) => canonical(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  rang_snapshot?: string | null;

  @IsOptional()
  @Transform(({ value }) => canonical(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(48)
  razmer_snapshot?: string | null;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i)
  entered_at!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  business_date!: string;

  @IsOptional()
  @Transform(({ value }) => canonical(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  conveyor_snapshot?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i)
  deleted_at?: string | null;

  @IsOptional()
  @IsUUID()
  deleted_by?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  deleted_by_name_snapshot?: string | null;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PattaSheetV3OperationSnapshotInputDto)
  operation_snapshots!: PattaSheetV3OperationSnapshotInputDto[];

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

export class CreatePattaSheetV3Dto extends PattaSheetV3AggregateInputDto {}

export class UpdatePattaSheetV3Dto extends PattaSheetV3AggregateInputDto {
  @IsString()
  @Matches(/^[1-9][0-9]*$/)
  expected_version!: string;
}
