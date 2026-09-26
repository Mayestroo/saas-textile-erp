import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { TenantAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { TenantPermissions } from '../../common/auth/auth-decorators.js';
import { DeviceAccessService } from '../../master/devices/device-access.service.js';
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js';
import { TenantPermissionGuard } from '../auth/tenant-permission.guard.js';
import { requireTenantContext } from '../auth/require-tenant-context.js';
import { AllocatePattaNumberBlockDto } from './dto/allocate-patta-number-block.dto.js';
import { CancelPattaNumberBlockDto } from './dto/cancel-patta-number-block.dto.js';
import { ReportPattaBlockUsageDto } from './dto/report-patta-block-usage.dto.js';
import { GeneratePattaDto } from './dto/generate-patta.dto.js';
import { ListPattaDto } from './dto/list-patta.dto.js';
import { LookupPattaDto } from './dto/lookup-patta.dto.js';
import { PattaNumberBlocksService } from './patta-number-blocks.service.js';
import { PattaService } from './patta.service.js';

@Controller('api/v1')
@UseGuards(TenantAuthGuard, TenantPermissionGuard)
export class PattaController {
  constructor(
    private readonly deviceAccessService: DeviceAccessService,
    private readonly pattaNumberBlocksService: PattaNumberBlocksService,
    private readonly pattaService: PattaService,
  ) {}

  @Post('patta-number-blocks/allocate')
  @HttpCode(201)
  @TenantPermissions('patta.chiqarish.create')
  async allocateNumberBlock(
    @Req() request: TenantAuthenticatedRequest,
    @Body() input: AllocatePattaNumberBlockDto,
  ) {
    const { dataSource, actorUserId, companyId } = requireTenantContext(request);
    const device = await this.deviceAccessService.assertActiveDevice(companyId, input.device_id);
    return this.pattaNumberBlocksService.allocate(dataSource, actorUserId, device.id);
  }

  @Post('patta-number-blocks/:id/usage')
  @HttpCode(200)
  @TenantPermissions('patta.chiqarish.create')
  async reportNumberBlockUsage(
    @Req() request: TenantAuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) blockId: string,
    @Body() input: ReportPattaBlockUsageDto,
  ) {
    const { dataSource, actorUserId, companyId } = requireTenantContext(request);
    const device = await this.deviceAccessService.assertActiveDevice(companyId, input.device_id);
    return this.pattaNumberBlocksService.reportUsage(
      dataSource,
      actorUserId,
      device.id,
      blockId,
      BigInt(input.reported_used_count),
    );
  }

  @Post('patta-number-blocks/:id/cancel')
  @HttpCode(200)
  @TenantPermissions('patta.chiqarish.create')
  async cancelNumberBlock(
    @Req() request: TenantAuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) blockId: string,
    @Body() input: CancelPattaNumberBlockDto,
  ) {
    const { dataSource, actorUserId, companyId } = requireTenantContext(request);
    const device = await this.deviceAccessService.assertActiveDevice(companyId, input.device_id);
    return this.pattaNumberBlocksService.cancel(dataSource, actorUserId, device.id, blockId);
  }

  @Post('patta/generate')
  @HttpCode(201)
  @TenantPermissions('patta.chiqarish.create')
  async generate(
    @Req() request: TenantAuthenticatedRequest,
    @Body() input: GeneratePattaDto,
  ) {
    const { dataSource, actorUserId, companyId } = requireTenantContext(request);
    const device = await this.deviceAccessService.assertActiveDevice(companyId, input.device_id);
    return this.pattaService.generate(dataSource, actorUserId, device.id, input);
  }

  @Get('patta/lookup')
  @TenantPermissions('patta.hisob.view')
  lookup(
    @Req() request: TenantAuthenticatedRequest,
    @Query() query: LookupPattaDto,
  ) {
    const { dataSource } = requireTenantContext(request);
    return this.pattaService.lookup(dataSource, query.partiya_number, query.patta_number);
  }

  @Get('patta')
  @TenantPermissions('patta.hisob.view')
  list(
    @Req() request: TenantAuthenticatedRequest,
    @Query() query: ListPattaDto,
  ) {
    const { dataSource } = requireTenantContext(request);
    return this.pattaService.list(dataSource, query);
  }
}
