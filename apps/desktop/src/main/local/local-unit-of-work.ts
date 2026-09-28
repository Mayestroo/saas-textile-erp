import type Database from 'better-sqlite3'

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== 'object' || value === null) return false
  return 'then' in value && typeof Reflect.get(value, 'then') === 'function'
}

export class LocalUnitOfWork {
  constructor(private readonly database: Database.Database) {}

  transaction<T>(action: (database: Database.Database) => T): T {
    const transaction = this.database.transaction(() => {
      const result = action(this.database)
      if (isPromiseLike(result)) {
        throw new Error('SQLite unit-of-work transactions must not await asynchronous work')
      }
      return result
    })
    return transaction.immediate()
  }
}
