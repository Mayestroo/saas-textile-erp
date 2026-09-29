import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, Req, UseGuards } from '@nestjs/common';
import type { TenantAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { TenantPermissions } from '../../common/auth/auth-decorators.js';
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js';
import { TenantPermissionGuard } from '../auth/tenant-permission.guard.js';
import { requireTenantContext } from '../auth/require-tenant-context.js';
import { LookupPattaV2Dto } from './dto/lookup-patta-v2.dto.js';
import { PattaPrintBatchesService } from './patta-print-batches.service.js';
import { DeviceAccessService } from '../../master/devices/device-access.service.js';
import { CorrectLegacyPattaQuantityDto } from './dto/correct-legacy-patta-quantity.dto.js';

@Controller('api/v2/patta')
@UseGuards(TenantAuthGuard, TenantPermissionGuard)
export class PattaV2Controller {
  constructor(
    private readonly printBatchesService: PattaPrintBatchesService,
    private readonly deviceAccessService: DeviceAccessService,
  ) {}

  @Get('lookup')
  @TenantPermissions('patta.hisob.view')
  lookup(@Req() request: TenantAuthenticatedRequest, @Query() query: LookupPattaV2Dto) {
    const { dataSource } = requireTenantContext(request);
    return this.printBatchesService.lookup(dataSource, query);
  }

  @Patch(':id/quantity-correction')
  @TenantPermissions('patta.chiqarish.correct')
  async correctLegacyQuantity(
    @Req() request: TenantAuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) pattaId: string,
    @Body() input: CorrectLegacyPattaQuantityDto,
  ) {
    const { dataSource, actorUserId, companyId } = requireTenantContext(request);
    const device = await this.deviceAccessService.assertActiveDevice(companyId, input.device_id);
    return this.printBatchesService.correctLegacyQuantity(dataSource, actorUserId, device.id, pattaId, input);
  }
}
