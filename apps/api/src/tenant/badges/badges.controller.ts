import {
  Body,
  Controller,
  Get,
  Param,
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
import { BadgeHistoryService } from './badge-history.service.js';
import { BadgeNumberPipe } from './badge-number.pipe.js';
import { ReassignBadgeDto } from './dto/reassign-badge.dto.js';
import { ReleaseBadgeDto } from './dto/release-badge.dto.js';
import { ResolveBadgeDto } from './dto/resolve-badge.dto.js';
import { BadgeResolutionService } from './badge-resolution.service.js';

@Controller('api/v1/badges')
@UseGuards(TenantAuthGuard, TenantPermissionGuard)
export class BadgesController {
  constructor(
    private readonly badgeHistoryService: BadgeHistoryService,
    private readonly badgeResolutionService: BadgeResolutionService,
  ) {}

  @Post(':badgeNumber/reassign')
  @TenantPermissions('workers.badge.manage')
  reassign(
    @Req() request: TenantAuthenticatedRequest,
    @Param('badgeNumber', new BadgeNumberPipe()) badgeNumber: string,
    @Body() input: ReassignBadgeDto,
  ) {
    const { dataSource, actorUserId } = requireTenantContext(request);
    return this.badgeHistoryService.reassign(dataSource, actorUserId, badgeNumber, input);
  }

  @Post(':badgeNumber/release')
  @TenantPermissions('workers.badge.manage')
  release(
    @Req() request: TenantAuthenticatedRequest,
    @Param('badgeNumber', new BadgeNumberPipe()) badgeNumber: string,
    @Body() input: ReleaseBadgeDto,
  ) {
    const { dataSource, actorUserId } = requireTenantContext(request);
    return this.badgeHistoryService.release(dataSource, actorUserId, badgeNumber, input);
  }

  @Get(':badgeNumber/resolve')
  @TenantPermissions('workers.view')
  resolve(
    @Req() request: TenantAuthenticatedRequest,
    @Param('badgeNumber', new BadgeNumberPipe()) badgeNumber: string,
    @Query() query: ResolveBadgeDto,
  ) {
    const { dataSource } = requireTenantContext(request);
    return this.badgeResolutionService.resolve(dataSource, badgeNumber, query.at);
  }
}
