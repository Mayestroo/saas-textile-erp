import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { TenantAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { TenantPermissions } from '../../common/auth/auth-decorators.js';
import { DeviceAccessService } from '../../master/devices/device-access.service.js';
import { OperationsService } from '../operations/operations.service.js';
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js';
import { TenantPermissionGuard } from '../auth/tenant-permission.guard.js';
import { requireTenantContext } from '../auth/require-tenant-context.js';
import { PattaSheetLifecycleDto } from './dto/patta-sheet-lifecycle.dto.js';
import { CreatePattaSheetDto, UpdatePattaSheetDto } from './dto/patta-sheet-input.dto.js';
import { ModelAccountQueryService } from './model-account-query.service.js';
import { PattaSheetsService } from './patta-sheets.service.js';
import { CreatePattaSheetOperationDto } from './dto/create-patta-sheet-operation.dto.js';

@Controller('api/v2/patta-sheets')
@UseGuards(TenantAuthGuard, TenantPermissionGuard)
export class PattaSheetsController {
  constructor(
    private readonly deviceAccess: DeviceAccessService,
    private readonly sheets: PattaSheetsService,
    private readonly operations: OperationsService,
  ) {}

  @Post('custom-operations')
  @TenantPermissions('patta_varaq.custom_operation')
  async createCustomOperation(
    @Req() request: TenantAuthenticatedRequest,
    @Body() input: CreatePattaSheetOperationDto,
  ) {
    const { dataSource, actorUserId, companyId } = requireTenantContext(request);
    const device = await this.deviceAccess.assertActiveDevice(companyId, input.device_id);
    return this.operations.createForPattaSheet(dataSource, input.model_id, actorUserId, device.id, input);
  }

  @Get('by-patta/:pattaId')
  @TenantPermissions('patta_varaq.view')
  findByPatta(
    @Req() request: TenantAuthenticatedRequest,
    @Param('pattaId', new ParseUUIDPipe()) pattaId: string,
  ) {
    const { dataSource } = requireTenantContext(request);
    return this.sheets.findByPatta(dataSource, pattaId);
  }

  @Get(':id')
  @TenantPermissions('patta_varaq.view')
  getById(@Req() request: TenantAuthenticatedRequest, @Param('id', new ParseUUIDPipe()) sheetId: string) {
    const { dataSource } = requireTenantContext(request);
    return this.sheets.getById(dataSource, sheetId);
  }

  @Post()
  @TenantPermissions('patta_varaq.create')
  async create(@Req() request: TenantAuthenticatedRequest, @Body() input: CreatePattaSheetDto) {
    const { dataSource, actorUserId, companyId, timezone } = requireTenantContext(request);
    const device = await this.deviceAccess.assertActiveDevice(companyId, input.device_id);
    return this.sheets.create(dataSource, {
      actorUserId,
      validatedDeviceId: device.id,
      timezone,
    }, input);
  }

  @Patch(':id')
  @TenantPermissions('patta_varaq.edit')
  async update(
    @Req() request: TenantAuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) sheetId: string,
    @Body() input: UpdatePattaSheetDto,
  ) {
    const { dataSource, actorUserId, companyId, timezone } = requireTenantContext(request);
    const device = await this.deviceAccess.assertActiveDevice(companyId, input.device_id);
    return this.sheets.update(dataSource, { actorUserId, validatedDeviceId: device.id, timezone }, sheetId, input);
  }

  @Patch(':id/trash')
  @TenantPermissions('patta_varaq.delete')
  async trash(
    @Req() request: TenantAuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) sheetId: string,
    @Body() input: PattaSheetLifecycleDto,
  ) {
    const { dataSource, actorUserId, companyId, timezone } = requireTenantContext(request);
    const device = await this.deviceAccess.assertActiveDevice(companyId, input.device_id);
    return this.sheets.trash(dataSource, { actorUserId, validatedDeviceId: device.id, timezone }, sheetId, input.expected_version);
  }

  @Patch(':id/restore')
  @TenantPermissions('patta_varaq.restore')
  async restore(
    @Req() request: TenantAuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) sheetId: string,
    @Body() input: PattaSheetLifecycleDto,
  ) {
    const { dataSource, actorUserId, companyId, timezone } = requireTenantContext(request);
    const device = await this.deviceAccess.assertActiveDevice(companyId, input.device_id);
    return this.sheets.restore(dataSource, { actorUserId, validatedDeviceId: device.id, timezone }, sheetId, input.expected_version);
  }

  @Delete(':id/purge')
  @TenantPermissions('patta_varaq.purge')
  async purge(
    @Req() request: TenantAuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) sheetId: string,
    @Body() input: PattaSheetLifecycleDto,
  ) {
    const { dataSource, actorUserId, companyId, timezone } = requireTenantContext(request);
    const device = await this.deviceAccess.assertActiveDevice(companyId, input.device_id);
    return this.sheets.purge(dataSource, { actorUserId, validatedDeviceId: device.id, timezone }, sheetId, input.expected_version);
  }
}

@Controller('api/v2/models')
@UseGuards(TenantAuthGuard, TenantPermissionGuard)
export class ModelAccountController {
  constructor(private readonly accountQuery: ModelAccountQueryService) {}

  @Get(':modelId/account-sheet')
  @TenantPermissions('patta_varaq.view')
  getAccountSheet(
    @Req() request: TenantAuthenticatedRequest,
    @Param('modelId', new ParseUUIDPipe()) modelId: string,
  ) {
    const { dataSource } = requireTenantContext(request);
    return this.accountQuery.getModelAccountSheet(dataSource, modelId);
  }
}
