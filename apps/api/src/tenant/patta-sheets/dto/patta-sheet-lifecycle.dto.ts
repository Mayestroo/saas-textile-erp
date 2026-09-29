import { IsString, IsUUID, Matches } from 'class-validator';

export class PattaSheetLifecycleDto {
  @IsString()
  @Matches(/^[1-9][0-9]*$/)
  expected_version!: string;

  @IsUUID()
  device_id!: string;
}
