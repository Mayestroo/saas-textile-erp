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
import { ChangeOperationPriceDto } from './dto/change-operation-price.dto.js';
import { CreateOperationDto } from './dto/create-operation.dto.js';
import { ListOperationPricesDto } from './dto/list-operation-prices.dto.js';
import { ListOperationsDto } from './dto/list-operations.dto.js';
import { UpdateOperationDto } from './dto/update-operation.dto.js';
import { OperationPriceService } from './operation-price.service.js';
import { OperationsService } from './operations.service.js';

@Controller('api/v1')
@UseGuards(TenantAuthGuard, TenantPermissionGuard)
export class OperationsController {
  constructor(
    private readonly operationsService: OperationsService,
    private readonly operationPriceService: OperationPriceService,
  ) {}

  @Get('models/:modelId/operations')
  @TenantPermissions('models.view')
  listByModel(
    @Req() request: TenantAuthenticatedRequest,
    @Param('modelId', new ParseUUIDPipe()) modelId: string,
    @Query() query: ListOperationsDto,
  ) {
    const { dataSource } = requireTenantContext(request);
    return this.operationsService.listByModel(dataSource, modelId, query.status ?? 'ACTIVE');
  }

  @Post('models/:modelId/operations')
  @HttpCode(201)
  @TenantPermissions('models.manage')
  create(
    @Req() request: TenantAuthenticatedRequest,
    @Param('modelId', new ParseUUIDPipe()) modelId: string,
    @Body() input: CreateOperationDto,
  ) {
    const { dataSource, actorUserId } = requireTenantContext(request);
    return this.operationsService.create(dataSource, modelId, actorUserId, input);
  }

  @Patch('operations/:operationId')
  @TenantPermissions('models.manage')
  update(
    @Req() request: TenantAuthenticatedRequest,
    @Param('operationId', new ParseUUIDPipe()) operationId: string,
    @Body() input: UpdateOperationDto,
  ) {
    const { dataSource, actorUserId } = requireTenantContext(request);
    return this.operationsService.update(dataSource, actorUserId, operationId, input);
  }

  @Post('operations/:operationId/price')
  @HttpCode(200)
  @TenantPermissions('models.manage')
  changePrice(
    @Req() request: TenantAuthenticatedRequest,
    @Param('operationId', new ParseUUIDPipe()) operationId: string,
    @Body() input: ChangeOperationPriceDto,
  ) {
    const { dataSource, actorUserId } = requireTenantContext(request);
    return this.operationPriceService.changePrice(dataSource, {
      operationId,
      actorUserId,
      price: input.price,
      effectiveFrom: input.effective_from,
      expectedVersion: input.expected_version,
    });
  }

  @Get('operations/:operationId/prices')
  @TenantPermissions('models.view')
  listPrices(
    @Req() request: TenantAuthenticatedRequest,
    @Param('operationId', new ParseUUIDPipe()) operationId: string,
    @Query() query: ListOperationPricesDto,
  ) {
    const { dataSource } = requireTenantContext(request);
    if (query.effective_at !== undefined) {
      return this.operationPriceService.resolvePrice(operationId, query.effective_at, dataSource)
        .then((price) => ({ operation_id: operationId, effective_at: query.effective_at, price }));
    }
    return this.operationPriceService.listHistory(dataSource, operationId);
  }
}
