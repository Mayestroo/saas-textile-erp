import { IsInt, IsString, IsUUID, Matches, Max, Min } from 'class-validator';

export class CorrectLegacyPattaQuantityDto {
  @IsString()
  @Matches(/^[1-9][0-9]*$/)
  expected_version!: string;

  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  ish_soni!: number;

  @IsString()
  @Matches(/^.{3,500}$/)
  correction_reason!: string;

  @IsUUID()
  device_id!: string;
}
