import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
import { SyncBootstrapCompleteDto } from './dto/sync-bootstrap-complete.dto.js';
import { SyncBootstrapPageQueryDto } from './dto/sync-bootstrap-page-query.dto.js';
import { SyncBootstrapRequestDto } from './dto/sync-bootstrap-request.dto.js';
import { SyncBootstrapService } from './sync-bootstrap.service.js';
import { SyncService } from './sync.service.js';

@Controller('api/v1/sync')
@UseGuards(TenantAuthGuard, TenantPermissionGuard)
export class SyncController {
  constructor(
    private readonly deviceAccessService: DeviceAccessService,
    private readonly syncService: SyncService,
    private readonly syncBootstrapService: SyncBootstrapService,
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

  @Post('bootstrap')
  @HttpCode(201)
  @TenantPermissions('sync.pull')
  async createBootstrap(
    @Req() request: TenantAuthenticatedRequest,
    @Body() input: SyncBootstrapRequestDto,
  ) {
    const context = requireTenantContext(request);
    const device = await this.deviceAccessService.assertActiveDevice(
      context.companyId,
      input.device_id,
    );
    return this.syncBootstrapService.create(context.dataSource, device.id);
  }

  @Get('bootstrap/:sessionId')
  @TenantPermissions('sync.pull')
  async bootstrapPage(
    @Req() request: TenantAuthenticatedRequest,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Query() query: SyncBootstrapPageQueryDto,
  ) {
    const context = requireTenantContext(request);
    const device = await this.deviceAccessService.assertActiveDevice(
      context.companyId,
      query.device_id,
    );
    return this.syncBootstrapService.page(
      context.dataSource,
      device.id,
      sessionId,
      query.after ?? null,
      query.limit,
    );
  }

  @Post('bootstrap/:sessionId/complete')
  @HttpCode(200)
  @TenantPermissions('sync.pull')
  async completeBootstrap(
    @Req() request: TenantAuthenticatedRequest,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Body() input: SyncBootstrapCompleteDto,
  ) {
    const context = requireTenantContext(request);
    const device = await this.deviceAccessService.assertActiveDevice(
      context.companyId,
      input.device_id,
    );
    return this.syncBootstrapService.complete(
      context.dataSource,
      device.id,
      sessionId,
    );
  }
}
