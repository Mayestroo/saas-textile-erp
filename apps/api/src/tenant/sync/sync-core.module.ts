import { Module } from '@nestjs/common';
import { SyncChangeRecorder } from './sync-change-recorder.js';

@Module({
  providers: [SyncChangeRecorder],
  exports: [SyncChangeRecorder],
})
export class TenantSyncCoreModule {}
