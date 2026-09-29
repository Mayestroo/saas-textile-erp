import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { TenantAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { TenantPermissions } from '../../common/auth/auth-decorators.js';
import { DeviceAccessService } from '../../master/devices/device-access.service.js';
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js';
import { TenantPermissionGuard } from '../auth/tenant-permission.guard.js';
import { requireTenantContext } from '../auth/require-tenant-context.js';
import { CreatePattaPrintBatchDto } from './dto/create-patta-print-batch.dto.js';
import { RecordPattaPrintEventDto } from './dto/record-patta-print-event.dto.js';
import { CorrectPattaPrintBatchDto } from './dto/correct-patta-print-batch.dto.js';
import { PattaPrintBatchesService } from './patta-print-batches.service.js';

@Controller('api/v2/patta-print-batches')
@UseGuards(TenantAuthGuard, TenantPermissionGuard)
export class PattaPrintBatchesController {
  constructor(
    private readonly deviceAccessService: DeviceAccessService,
    private readonly batchesService: PattaPrintBatchesService,
  ) {}

  @Post()
  @HttpCode(201)
  @TenantPermissions('patta.chiqarish.create')
  async create(@Req() request: TenantAuthenticatedRequest, @Body() input: CreatePattaPrintBatchDto) {
    const { dataSource, actorUserId, companyId } = requireTenantContext(request);
    const device = await this.deviceAccessService.assertActiveDevice(companyId, input.device_id);
    return this.batchesService.create(dataSource, actorUserId, device.id, input);
  }

  @Patch(':id')
  @TenantPermissions('patta.chiqarish.correct')
  async correct(
    @Req() request: TenantAuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) batchId: string,
    @Body() input: CorrectPattaPrintBatchDto,
  ) {
    const { dataSource, actorUserId, companyId } = requireTenantContext(request);
    const device = await this.deviceAccessService.assertActiveDevice(companyId, input.device_id);
    return this.batchesService.correctBatch(dataSource, actorUserId, device.id, batchId, input);
  }

  @Post(':id/print-events')
  @HttpCode(201)
  @TenantPermissions('patta.chiqarish.create')
  async recordPrintEvent(
    @Req() request: TenantAuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) batchId: string,
    @Body() input: RecordPattaPrintEventDto,
  ) {
    const { dataSource, actorUserId, companyId } = requireTenantContext(request);
    const device = await this.deviceAccessService.assertActiveDevice(companyId, input.device_id);
    return this.batchesService.recordPrintEvent(dataSource, actorUserId, device.id, batchId, input);
  }
}
