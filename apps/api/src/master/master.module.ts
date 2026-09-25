import { Module } from '@nestjs/common';
import { CompaniesModule } from './companies/companies.module.js';
import { ProvisioningModule } from './provisioning/provisioning.module.js';
import { LicensesModule } from './licenses/licenses.module.js';
import { DevicesModule } from './devices/devices.module.js';
import { PlatformAuthModule } from './platform-auth/platform-auth.module.js';

@Module({
  imports: [CompaniesModule, ProvisioningModule, LicensesModule, DevicesModule, PlatformAuthModule]
})
export class MasterModule {}
