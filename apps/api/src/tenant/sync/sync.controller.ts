import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TenantPermissions } from '../../common/auth/auth-decorators.js';
import type { TenantAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { DeviceAccessService } from '../../master/devices/device-access.service.js';
import { requireTenantContext } from '../auth/require-tenant-context.js';
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js';
import { TenantPermissionGuard } from '../auth/tenant-permission.guard.js';
import { SyncPullQueryDto } from './dto/sync-pull-query.dto.js';
import { SyncPushEnvelopeDto } from './dto/sync-push-envelope.dto.js';
import { SyncService } from './sync.service.js';

@Controller('api/v1/sync')
@UseGuards(TenantAuthGuard, TenantPermissionGuard)
export class SyncController {
  constructor(
    private readonly deviceAccessService: DeviceAccessService,
    private readonly syncService: SyncService,
  ) {}

  @Post('push')
  @HttpCode(200)
  @TenantPermissions('sync.push', 'patta.chiqarish.create')
  async push(
    @Req() request: TenantAuthenticatedRequest,
    @Body() input: SyncPushEnvelopeDto,
  ) {
    const context = requireTenantContext(request);
    const device = await this.deviceAccessService.assertActiveDevice(
      context.companyId,
      input.device_id,
    );
    return this.syncService.push(context, device.id, input.events);
  }

  @Get('pull')
  @TenantPermissions('sync.pull')
  async pull(
    @Req() request: TenantAuthenticatedRequest,
    @Query() query: SyncPullQueryDto,
  ) {
    const context = requireTenantContext(request);
    await this.deviceAccessService.assertActiveDevice(context.companyId, query.device_id);
    return this.syncService.pull(context.dataSource, query.cursor, query.limit);
  }
}
