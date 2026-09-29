import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { TenantAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { TenantPermissions } from '../../common/auth/auth-decorators.js';
import { DeviceAccessService } from '../../master/devices/device-access.service.js';
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js';
import { TenantPermissionGuard } from '../auth/tenant-permission.guard.js';
import { requireTenantContext } from '../auth/require-tenant-context.js';
import { AllocatePattaPartiyaBlockDto } from './dto/allocate-patta-partiya-block.dto.js';
import { ReportPattaPartiyaBlockUsageDto } from './dto/report-patta-partiya-block-usage.dto.js';
import { PattaPartiyaNumberBlocksService } from './patta-partiya-number-blocks.service.js';

@Controller('api/v2/patta-partiya-number-blocks')
@UseGuards(TenantAuthGuard, TenantPermissionGuard)
export class PattaPartiyaNumberBlocksController {
  constructor(
    private readonly deviceAccessService: DeviceAccessService,
    private readonly blocksService: PattaPartiyaNumberBlocksService,
  ) {}

  @Post('allocate')
  @HttpCode(201)
  @TenantPermissions('patta.chiqarish.create')
  async allocate(@Req() request: TenantAuthenticatedRequest, @Body() input: AllocatePattaPartiyaBlockDto) {
    const { dataSource, actorUserId, companyId } = requireTenantContext(request);
    const device = await this.deviceAccessService.assertActiveDevice(companyId, input.device_id);
    return this.blocksService.allocate(dataSource, actorUserId, device.id);
  }

  @Post(':id/usage')
  @HttpCode(200)
  @TenantPermissions('patta.chiqarish.create')
  async reportUsage(
    @Req() request: TenantAuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) blockId: string,
    @Body() input: ReportPattaPartiyaBlockUsageDto,
  ) {
    const { dataSource, companyId } = requireTenantContext(request);
    const device = await this.deviceAccessService.assertActiveDevice(companyId, input.device_id);
    return this.blocksService.reportUsage(dataSource, device.id, blockId, BigInt(input.reported_used_count));
  }
}
