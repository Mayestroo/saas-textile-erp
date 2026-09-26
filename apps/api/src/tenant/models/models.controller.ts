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
import { CreateModelDto } from './dto/create-model.dto.js';
import { ListModelsDto } from './dto/list-models.dto.js';
import { UpdateModelDto } from './dto/update-model.dto.js';
import { ModelsService } from './models.service.js';

@Controller('api/v1/models')
@UseGuards(TenantAuthGuard, TenantPermissionGuard)
export class ModelsController {
  constructor(private readonly modelsService: ModelsService) {}

  @Get()
  @TenantPermissions('models.view')
  list(
    @Req() request: TenantAuthenticatedRequest,
    @Query() query: ListModelsDto,
  ) {
    const { dataSource } = requireTenantContext(request);
    return this.modelsService.list(dataSource, query.status ?? 'ACTIVE');
  }

  @Post()
  @HttpCode(201)
  @TenantPermissions('models.manage')
  create(
    @Req() request: TenantAuthenticatedRequest,
    @Body() input: CreateModelDto,
  ) {
    const { dataSource, actorUserId } = requireTenantContext(request);
    return this.modelsService.create(dataSource, actorUserId, input);
  }

  @Get(':id')
  @TenantPermissions('models.view')
  getById(
    @Req() request: TenantAuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) modelId: string,
  ) {
    const { dataSource } = requireTenantContext(request);
    return this.modelsService.getById(dataSource, modelId);
  }

  @Patch(':id')
  @TenantPermissions('models.manage')
  update(
    @Req() request: TenantAuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) modelId: string,
    @Body() input: UpdateModelDto,
  ) {
    const { dataSource, actorUserId } = requireTenantContext(request);
    return this.modelsService.update(dataSource, actorUserId, modelId, input);
  }
}
