import type { SyncEngine } from './sync-engine'

export class SyncEngineRegistry {
  private engine: SyncEngine | null = null

  current(): SyncEngine | null {
    return this.engine
  }

  install(engine: SyncEngine): void {
    this.engine?.dispose()
    this.engine = engine
    engine.start()
  }

  dispose(): void {
    this.engine?.dispose()
    this.engine = null
  }
}

export const desktopSyncEngineRegistry = new SyncEngineRegistry()
