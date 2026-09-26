import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { TenantAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { TenantPermissions } from '../../common/auth/auth-decorators.js';
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js';
import { TenantPermissionGuard } from '../auth/tenant-permission.guard.js';
import { requireTenantContext } from '../auth/require-tenant-context.js';
import { CreatePattaTemplateDto } from './dto/create-patta-template.dto.js';
import { ListPattaTemplatesDto } from './dto/list-patta-templates.dto.js';
import { UpdatePattaTemplateDto } from './dto/update-patta-template.dto.js';
import { PattaTemplatesService } from './patta-templates.service.js';

@Controller('api/v1/patta-templates')
@UseGuards(TenantAuthGuard, TenantPermissionGuard)
export class PattaTemplatesController {
  constructor(private readonly pattaTemplatesService: PattaTemplatesService) {}

  @Get()
  @TenantPermissions('models.view')
  list(
    @Req() request: TenantAuthenticatedRequest,
    @Query() query: ListPattaTemplatesDto,
  ) {
    const { dataSource } = requireTenantContext(request);
    return this.pattaTemplatesService.list(dataSource, query);
  }

  @Post()
  @HttpCode(201)
  @TenantPermissions('models.manage')
  create(
    @Req() request: TenantAuthenticatedRequest,
    @Body() input: CreatePattaTemplateDto,
  ) {
    const { dataSource, actorUserId } = requireTenantContext(request);
    return this.pattaTemplatesService.create(dataSource, actorUserId, input);
  }

  @Get(':id')
  @TenantPermissions('models.view')
  getById(
    @Req() request: TenantAuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) templateId: string,
  ) {
    const { dataSource } = requireTenantContext(request);
    return this.pattaTemplatesService.getById(dataSource, templateId);
  }

  @Patch(':id')
  @TenantPermissions('models.manage')
  update(
    @Req() request: TenantAuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) templateId: string,
    @Body() input: UpdatePattaTemplateDto,
  ) {
    const { dataSource, actorUserId } = requireTenantContext(request);
    return this.pattaTemplatesService.update(dataSource, actorUserId, templateId, input);
  }
}
