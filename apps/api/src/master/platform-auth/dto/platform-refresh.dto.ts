import { IsString, MaxLength, MinLength } from 'class-validator';

export class PlatformRefreshDto {
  @IsString()
  @MinLength(1)
  @MaxLength(8_192)
  refresh_token!: string;
}
