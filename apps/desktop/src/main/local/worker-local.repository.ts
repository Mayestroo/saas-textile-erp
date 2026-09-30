import type Database from 'better-sqlite3'

export interface LocalWorkerRecord {
  id: string
  full_name: string
  status: 'ACTIVE' | 'INACTIVE'
}

export class WorkerLocalRepository {
  constructor(private readonly database: Database.Database) {}

  listActiveWorkers(): readonly LocalWorkerRecord[] {
    return this.database.prepare(`
      SELECT worker.id, worker.full_name, worker.status
      FROM workers AS worker
      WHERE worker.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS tombstone
          WHERE tombstone.entity_type = 'workers' AND tombstone.entity_id = worker.id
        )
      ORDER BY worker.full_name COLLATE NOCASE, worker.id
    `).all() as LocalWorkerRecord[]
  }

  getById(workerId: string): LocalWorkerRecord | null {
    const worker = this.database
      .prepare(
        `
      SELECT worker.id, worker.full_name, worker.status
      FROM workers AS worker
      WHERE worker.id = ?
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS tombstone
          WHERE tombstone.entity_type = 'workers' AND tombstone.entity_id = worker.id
        )
    `
      )
      .get(workerId) as LocalWorkerRecord | undefined
    return worker ?? null
  }
}
