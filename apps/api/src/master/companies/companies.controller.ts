import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { PlatformPermissions } from '../../common/auth/auth-decorators.js';
import { PlatformAuthGuard } from '../platform-auth/platform-auth.guard.js';
import { PlatformPermissionGuard } from '../platform-auth/platform-permission.guard.js';
import { CreateCompanyDto } from './dto/create-company.dto.js';
import { CompaniesService } from './companies.service.js';
import type { ProvisioningSnapshot } from '../provisioning/provisioning.service.js';

@Controller('api/v1/platform/companies')
@UseGuards(PlatformAuthGuard, PlatformPermissionGuard)
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  @Post()
  @PlatformPermissions('companies.create')
  create(@Body() input: CreateCompanyDto): Promise<ProvisioningSnapshot> {
    return this.companiesService.createAndProvision(input);
  }
}
