import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches } from 'class-validator';
import { canonicalizeBusinessName } from '../../models/business-name.js';

export class LookupPattaDto {
  @Transform(({ value }) => typeof value === 'string' ? canonicalizeBusinessName(value) : value)
  @IsString()
  @IsNotEmpty()
  partiya_number!: string;

  @IsString()
  @Matches(/^[1-9][0-9]*$/)
  patta_number!: string;
}
