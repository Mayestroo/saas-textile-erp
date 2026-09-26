import {
  Body,
  Controller,
  Get,
  Param,
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
import { BadgeHistoryService } from '../badges/badge-history.service.js';
import { AssignBadgeDto } from '../badges/dto/assign-badge.dto.js';
import { CreateWorkerDto } from './dto/create-worker.dto.js';
import { ListWorkersDto } from './dto/list-workers.dto.js';
import { UpdateWorkerDto } from './dto/update-worker.dto.js';
import { WorkerIdPipe } from './worker-id.pipe.js';
import { WorkersService } from './workers.service.js';

@Controller('api/v1/workers')
@UseGuards(TenantAuthGuard, TenantPermissionGuard)
export class WorkersController {
  constructor(
    private readonly workersService: WorkersService,
    private readonly badgeHistoryService: BadgeHistoryService,
  ) {}

  @Get()
  @TenantPermissions('workers.view')
  list(
    @Req() request: TenantAuthenticatedRequest,
    @Query() query: ListWorkersDto,
  ) {
    const { dataSource } = requireTenantContext(request);
    return this.workersService.list(dataSource, query.status ?? 'ACTIVE');
  }

  @Post()
  @TenantPermissions('workers.manage')
  create(
    @Req() request: TenantAuthenticatedRequest,
    @Body() input: CreateWorkerDto,
  ) {
    const { dataSource, actorUserId } = requireTenantContext(request);
    return this.workersService.create(dataSource, actorUserId, input);
  }

  @Get(':id')
  @TenantPermissions('workers.view')
  getById(
    @Req() request: TenantAuthenticatedRequest,
    @Param('id', new WorkerIdPipe()) workerId: string,
  ) {
    const { dataSource } = requireTenantContext(request);
    return this.workersService.getById(dataSource, workerId);
  }

  @Patch(':id')
  @TenantPermissions('workers.manage')
  update(
    @Req() request: TenantAuthenticatedRequest,
    @Param('id', new WorkerIdPipe()) workerId: string,
    @Body() input: UpdateWorkerDto,
  ) {
    const { dataSource, actorUserId } = requireTenantContext(request);
    return this.workersService.update(dataSource, actorUserId, workerId, input);
  }

  @Get(':id/badges')
  @TenantPermissions('workers.view')
  listBadgeHistory(
    @Req() request: TenantAuthenticatedRequest,
    @Param('id', new WorkerIdPipe()) workerId: string,
  ) {
    const { dataSource } = requireTenantContext(request);
    return this.badgeHistoryService.listByWorker(dataSource, workerId);
  }

  @Post(':id/badges')
  @TenantPermissions('workers.badge.manage')
  assignBadge(
    @Req() request: TenantAuthenticatedRequest,
    @Param('id', new WorkerIdPipe()) workerId: string,
    @Body() input: AssignBadgeDto,
  ) {
    const { dataSource, actorUserId } = requireTenantContext(request);
    return this.badgeHistoryService.assign(dataSource, actorUserId, workerId, input);
  }
}
