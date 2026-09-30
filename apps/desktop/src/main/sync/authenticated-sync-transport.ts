import type {
  PattaNumberBlockProjection,
  PattaPartiyaNumberBlockProjection,
  PattaV2LookupMirror,
  OperationPriceChangeProjection,
  SyncBootstrapPage,
  SyncBootstrapSession,
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse
} from '@textile/sync-protocol'

export interface AuthenticatedHttpRequest {
  method: 'GET' | 'POST'
  url: string
  body?: unknown
}

export interface AuthenticatedHttpClient {
  request(request: AuthenticatedHttpRequest): Promise<unknown>
}

export interface DeviceIdentity {
  deviceId(): string
}

export interface AuthenticatedSyncTransport {
  deviceId(): string
  push(request: Omit<SyncPushRequest, 'device_id'>): Promise<SyncPushResponse>
  pull(request: Omit<SyncPullRequest, 'device_id'>): Promise<SyncPullResponse>
  createBootstrap(): Promise<SyncBootstrapSession>
  bootstrapPage(sessionId: string, after: string | null, limit: number): Promise<SyncBootstrapPage>
  completeBootstrap(sessionId: string): Promise<void>
  allocatePattaNumberBlock(): Promise<PattaNumberBlockProjection>
  reportPattaBlockUsage(
    blockId: string,
    reportedUsedCount: string
  ): Promise<PattaNumberBlockProjection>
  allocatePattaPartiyaNumberBlock?(): Promise<PattaPartiyaNumberBlockProjection>
  reportPattaPartiyaBlockUsage?(
    blockId: string,
    reportedUsedCount: string
  ): Promise<PattaPartiyaNumberBlockProjection>
  lookupPattaV2?(partiyaNumber: string, pattaNumber: string): Promise<PattaV2LookupMirror>
  changeOperationPrice?(
    operationId: string,
    expectedVersion: string,
    price: string
  ): Promise<OperationPriceChangeProjection>
}
