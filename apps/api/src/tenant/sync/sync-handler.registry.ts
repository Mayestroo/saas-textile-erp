import { Inject, Injectable, Optional } from '@nestjs/common';
import type { SyncMutationOperation } from '@textile/sync-protocol';
import type { SyncEntityHandler } from './sync-entity-handler.js';

export const SYNC_ENTITY_HANDLERS = Symbol('SYNC_ENTITY_HANDLERS');

@Injectable()
export class SyncHandlerRegistry {
  constructor(
    @Optional()
    @Inject(SYNC_ENTITY_HANDLERS)
    private readonly handlers: readonly SyncEntityHandler[] = [],
  ) {}

  find(
    entityType: string,
    operation: SyncMutationOperation,
  ): SyncEntityHandler | undefined {
    const matches = this.handlers.filter((handler) =>
      handler.supports(entityType, operation),
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple sync handlers support ${entityType}/${operation}`,
      );
    }
    return matches[0];
  }
}
