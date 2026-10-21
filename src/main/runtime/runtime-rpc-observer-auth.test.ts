import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from '../../shared/e2ee-crypto'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import { ObserverCredentialStore } from './observer-credential-store'
import { defineMethod } from './rpc/core'
import { RUNTIME_OBSERVER_METHODS } from './rpc/methods/runtime-observer'
import type { AuthenticatedMobileSocket } from './rpc/mobile-socket-wiring'
import type { MobileSocketTransport } from './rpc/mobile-socket-wiring'

const directories: string[] = []
const servers: OrcaRuntimeRpcServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('observer WebSocket request authorization', () => {
  it('enforces the observer scope through a real E2EE socket and rejects revocation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-observer-e2ee-'))
    directories.push(dir)
    const store = new ObserverCredentialStore(dir)
    const issued = store.issue('worktree-a')
    const serverKeys = generateKeyPair()
    const clientKeys = generateKeyPair()
    const mutation = vi.fn()
    const runtime = new OrcaRuntimeService()
    runtime.mobileSessionTabsByWorktree.set('worktree-a', {
      worktree: 'worktree-a',
      publicationEpoch: 'test-epoch',
      snapshotVersion: 3,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: [
        {
          type: 'agent-session',
          id: 'tab-a',
          title: 'private title',
          sessionId: 'session-a',
          agent: 'codex',
          isActive: true
        }
      ]
    })
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: dir,
      enableWebSocket: false,
      methods: [
        ...RUNTIME_OBSERVER_METHODS,
        defineMethod({
          name: 'test.mutate',
          permission: 'workspace',
          params: null,
          handler: () => mutation()
        })
      ]
    })
    servers.push(server)
    const registry = new DeviceRegistry(dir)
    server['deviceRegistry'] = registry
    const wiring = server['ensureMobileSocketWiring'](registry, {
      publicKey: serverKeys.publicKey,
      secretKey: serverKeys.secretKey,
      publicKeyB64: Buffer.from(serverKeys.publicKey).toString('base64')
    })
    const sent: string[] = []
    // SAFETY: this fake implements the E2EE and dispatch socket methods used below.
    const ws = {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn((frame: string) => sent.push(frame)),
      close: vi.fn(),
      on: vi.fn(),
      off: vi.fn()
    } as unknown as WebSocket
    let receive: Parameters<MobileSocketTransport['onMessage']>[0] | null = null
    const transport: MobileSocketTransport = {
      onMessage: (handler) => {
        receive = handler
      },
      onConnectionClose: vi.fn(),
      setClientId: vi.fn(),
      terminateClientConnections: vi.fn(() => 0)
    }
    wiring.attachTransport(transport)
    const send = (frame: string) => receive?.(frame, vi.fn(), ws)
    send(
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: Buffer.from(clientKeys.publicKey).toString('base64')
      })
    )
    const key = deriveSharedKey(clientKeys.secretKey, serverKeys.publicKey)
    send(encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: issued.token }), key))
    const handshakeFrames = sent.length
    const replies = () =>
      sent.slice(handshakeFrames).map((frame): unknown => JSON.parse(decrypt(frame, key) ?? 'null'))

    send(encrypt(JSON.stringify({ id: 'read-e2ee', method: 'observer.runtimeIdentity' }), key))
    await vi.waitFor(() => expect(replies()).toHaveLength(1))
    expect(replies()[0]).toMatchObject({ id: 'read-e2ee', ok: true })
    send(
      encrypt(JSON.stringify({ id: 'inventory-e2ee', method: 'observer.sessionInventory' }), key)
    )
    await vi.waitFor(() => expect(replies()).toHaveLength(2))
    expect(replies()[1]).toMatchObject({
      id: 'inventory-e2ee',
      ok: true,
      result: {
        worktreeId: 'worktree-a',
        state: 'observed',
        knownSessionIds: ['session-a'],
        snapshotFreshness: 'unverified',
        coverage: 'published-agent-tabs-only'
      }
    })
    expect(JSON.stringify(replies()[1])).not.toContain('private title')
    send(encrypt(JSON.stringify({ id: 'write-e2ee', method: 'test.mutate' }), key))
    await vi.waitFor(() => expect(replies()).toHaveLength(3))
    expect(replies()[2]).toMatchObject({ id: 'write-e2ee', ok: false })
    expect(mutation).not.toHaveBeenCalled()

    runtime.mobileSessionTabsByWorktree.set('worktree-b', {
      worktree: 'worktree-b',
      publicationEpoch: 'foreign-epoch',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: [
        {
          type: 'agent-session',
          id: 'foreign-tab',
          title: 'foreign title',
          sessionId: 'foreign-session',
          agent: 'codex',
          isActive: true
        }
      ]
    })
    runtime.mobileSessionTabsByWorktree.delete('worktree-a')
    send(
      encrypt(JSON.stringify({ id: 'inventory-unknown', method: 'observer.sessionInventory' }), key)
    )
    await vi.waitFor(() => expect(replies()).toHaveLength(4))
    expect(replies()[3]).toMatchObject({
      id: 'inventory-unknown',
      ok: true,
      result: {
        worktreeId: 'worktree-a',
        state: 'unknown',
        snapshotFreshness: 'unverified',
        coverage: 'published-agent-tabs-only'
      }
    })
    expect(JSON.stringify(replies()[3])).not.toContain('foreign-session')

    store.revoke(issued.id)
    send(encrypt(JSON.stringify({ id: 'revoked-e2ee', method: 'observer.runtimeIdentity' }), key))
    await vi.waitFor(() => expect(replies()).toHaveLength(5))
    expect(replies()[4]).toMatchObject({
      id: 'revoked-e2ee',
      ok: false,
      error: { code: 'unauthorized' }
    })
    expect(registry.validateToken(issued.token)).toBeNull()
  })

  it('allows the fixed projection, denies a write, and rechecks revocation on the same socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-observer-dispatch-'))
    directories.push(dir)
    const store = new ObserverCredentialStore(dir)
    const issued = store.issue()
    const observer = store.authenticate(issued.token)!
    const mutation = vi.fn()
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath: dir,
      enableWebSocket: false,
      methods: [
        ...RUNTIME_OBSERVER_METHODS,
        defineMethod({
          name: 'test.mutate',
          permission: 'workspace',
          params: null,
          handler: () => mutation()
        })
      ]
    })
    servers.push(server)
    // SAFETY: the server only uses the socket's identity fields in this direct-dispatch test.
    const socket: AuthenticatedMobileSocket = {
      ws: {} as WebSocket,
      connectionId: 'observer-connection',
      transcriptHashB64: null,
      clientCapabilities: [],
      transport: { transport: 'direct' },
      device: {
        deviceId: `observer:${observer.id}`,
        clientId: `observer:${observer.id}`,
        scope: 'runtime',
        callerFingerprint: observer.tokenHash,
        credentialRevision: 1,
        deviceToken: issued.token,
        observerCredentialId: observer.id
      }
    }
    const call = async (id: string, method: string, authenticated = socket) => {
      const replies: unknown[] = []
      await server['handleWebSocketMessage'](
        JSON.stringify({ id, method }),
        (response) => replies.push(JSON.parse(response)),
        vi.fn(),
        undefined,
        undefined,
        null,
        authenticated
      )
      return replies[0]
    }

    expect(await call('read', 'observer.runtimeIdentity')).toMatchObject({
      id: 'read',
      ok: true,
      result: { runtimeId: expect.any(String), appVersion: expect.any(String) }
    })
    expect(await call('inventory-unscoped', 'observer.sessionInventory')).toMatchObject({
      id: 'inventory-unscoped',
      ok: false,
      error: { code: 'forbidden' }
    })
    expect(await call('write', 'test.mutate')).toMatchObject({ id: 'write', ok: false })
    expect(mutation).not.toHaveBeenCalled()
    expect(await call('unknown', 'observer.nonexistent')).toMatchObject({
      id: 'unknown',
      ok: false
    })

    expect(store.revoke(issued.id)).toBe(true)
    expect(await call('revoked', 'observer.runtimeIdentity')).toMatchObject({
      id: 'revoked',
      ok: false,
      error: { code: 'unauthorized' }
    })
  })
})
