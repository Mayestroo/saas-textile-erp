import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class PlatformLoginDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1_024)
  password!: string;
}
