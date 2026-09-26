import { Module } from '@nestjs/common';
import { DeviceAccessService } from './device-access.service.js';

@Module({
  providers: [DeviceAccessService],
  exports: [DeviceAccessService],
})
export class DevicesModule {}
