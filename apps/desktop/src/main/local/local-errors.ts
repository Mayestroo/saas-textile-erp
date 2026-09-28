export class LocalDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, string>> = {}
  ) {
    super(message)
    this.name = 'LocalDomainError'
  }
}
