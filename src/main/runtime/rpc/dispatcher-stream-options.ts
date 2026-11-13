import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { TerminalStreamFrame } from '../../../shared/terminal-stream-protocol'
import type { PairingRpcContext } from './core'
import type { RpcCallerIdentity } from './rpc-caller-identity'
import type { RpcCallerScope } from './rpc-caller-scope'

export type RpcDispatchStreamingOptions = {
  authenticatedCallerFingerprint?: string
  observerWorktreeId?: string
  observerWorktreeInstanceId?: string
  observerScopeId?: string
  connectionId?: string
  signal?: AbortSignal
  clientId?: string
  pairedDeviceId?: string
  caller?: RpcCallerIdentity
  callerScope?: RpcCallerScope
  clientKind?: 'mobile' | 'runtime'
  clientCapabilities?: readonly RuntimeCapability[]
  updateClientCapabilities?: (capabilities: readonly RuntimeCapability[]) => void
  pairing?: PairingRpcContext
  sendBinary?: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
  registerBinaryStreamHandler?: (streamId: number, handler: (frame: TerminalStreamFrame) => void) => () => void
  registerBinaryMessageHandler?: (handler: (bytes: Uint8Array<ArrayBufferLike>) => void) => () => void
}
