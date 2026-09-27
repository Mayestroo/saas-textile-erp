import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Matches, Min } from 'class-validator';

const DECIMAL_CURSOR_PATTERN = /^(0|[1-9][0-9]*)$/;

function integerQueryValue(value: unknown): unknown {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

export class SyncBootstrapPageQueryDto {
  @IsUUID()
  device_id!: string;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_CURSOR_PATTERN)
  after?: string;

  @IsOptional()
  @Transform(({ value }) => integerQueryValue(value))
  @IsInt()
  @Min(1)
  limit?: number;
}
