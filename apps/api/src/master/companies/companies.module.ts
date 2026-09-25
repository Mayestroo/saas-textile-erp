import { Module } from '@nestjs/common';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { CompaniesService } from './companies.service.js';

@Module({
  imports: [ProvisioningModule],
  providers: [CompaniesService],
  exports: [CompaniesService],
})
export class CompaniesModule {}
