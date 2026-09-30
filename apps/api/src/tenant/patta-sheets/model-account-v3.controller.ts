import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import type { TenantAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { TenantPermissions } from '../../common/auth/auth-decorators.js';
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js';
import { TenantPermissionGuard } from '../auth/tenant-permission.guard.js';
import { requireTenantContext } from '../auth/require-tenant-context.js';
import { ModelAccountQueryService } from './model-account-query.service.js';

@Controller('api/v3/models')
@UseGuards(TenantAuthGuard, TenantPermissionGuard)
export class ModelAccountV3Controller {
  constructor(private readonly accountQuery: ModelAccountQueryService) {}

  @Get(':modelId/account-sheet')
  @TenantPermissions('patta.hisob.view')
  getAccountSheet(
    @Req() request: TenantAuthenticatedRequest,
    @Param('modelId', new ParseUUIDPipe()) modelId: string,
  ) {
    const { dataSource } = requireTenantContext(request);
    return this.accountQuery.getModelAccountSheetV3(dataSource, modelId);
  }

  @Get('workers/:workerId/details')
  @TenantPermissions('patta.hisob.view')
  getWorkerDetails(
    @Req() request: TenantAuthenticatedRequest,
    @Param('workerId') workerId: string,
  ) {
    const { dataSource } = requireTenantContext(request);
    return this.accountQuery.getWorkerDetails(dataSource, workerId);
  }

  @Get('conveyor-account')
  @TenantPermissions('patta.hisob.view')
  getConveyorAccount(@Req() request: TenantAuthenticatedRequest) {
    const { dataSource } = requireTenantContext(request);
    return this.accountQuery.getConveyorAccount(dataSource);
  }
}
