import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateDefaultTenantAdminDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(1_024)
  password!: string;
}
