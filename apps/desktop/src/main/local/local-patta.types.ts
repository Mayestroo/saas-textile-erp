import type {
  SyncPattaCreatePayload,
  SyncPattaOperationSnapshotInput
} from '@textile/sync-protocol'

export type LocalPattaOwnershipState =
  'LOCAL_PENDING' | 'SYNCING' | 'SERVER_SYNCED' | 'CONFLICT' | 'FAILED'

export type LocalPattaOperationSnapshot = SyncPattaOperationSnapshotInput

export interface LocalPattaRecord {
  id: string
  partiya_number: string
  patta_number: string
  model_id: string
  model_name_snapshot: string
  template_id: string | null
  konveyer_snapshot: string
  razmer: string | null
  rang: string | null
  ish_soni: number
  created_device_id: string
  created_from_block_id: string
  created_at: string
  client_created_at: string
  occurred_at: string
  version: '0'
  ownership_state: 'LOCAL_PENDING'
  reference_versions: SyncPattaCreatePayload['reference_versions']
  template_overrides?: SyncPattaCreatePayload['template_overrides']
  operations: readonly LocalPattaOperationSnapshot[]
}

export interface PersistedLocalPatta extends Omit<
  LocalPattaRecord,
  | 'reference_versions'
  | 'template_overrides'
  | 'version'
  | 'created_from_block_id'
  | 'ownership_state'
> {
  created_from_block_id: string | null
  version: string
  ownership_state: LocalPattaOwnershipState
  server_sequence: string | null
}
