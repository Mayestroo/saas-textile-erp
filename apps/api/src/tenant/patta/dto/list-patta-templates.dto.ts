import { IsIn, ValidateIf } from 'class-validator';

export class ListPattaTemplatesDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';
}
