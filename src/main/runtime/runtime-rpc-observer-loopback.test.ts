import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from '../../shared/e2ee-crypto'
import { DeviceRegistry } from './device-registry'
import { ObserverCredentialStore } from './observer-credential-store'
import { OrcaRuntimeService } from './orca-runtime'
import { defineMethod } from './rpc/core'
import { RUNTIME_OBSERVER_METHODS } from './rpc/methods/runtime-observer'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(data.toString()))
    socket.once('error', reject)
  })
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.once('close', (code) => resolve(code))
    socket.once('error', reject)
  })
}

describe('observer real loopback WebSocket', () => {
  it('allows fixed reads and keeps denial and revoked reconnect inert', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-observer-loopback-'))
    const store = new ObserverCredentialStore(dir)
    const issued = store.issue('repo-id::/fictional/worktree', 'instance-a')
    const mutation = vi.fn()
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath: dir,
      enableWebSocket: true,
      wsPort: 0,
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
    const clients: WebSocket[] = []
    try {
      await server.start()
      const endpoint = server.getWebSocketEndpoint()
      const publicKey = server.getE2EEPublicKey()
      expect(endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:/)
      expect(publicKey).toBeTruthy()
      const keypair = generateKeyPair()
      const key = deriveSharedKey(keypair.secretKey, Buffer.from(publicKey!, 'base64'))
      const client = new WebSocket(endpoint!)
      clients.push(client)
      await opened(client)
      client.send(JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: Buffer.from(keypair.publicKey).toString('base64')
      }))
      expect(JSON.parse(await nextMessage(client))).toMatchObject({ type: 'e2ee_ready' })
      client.send(encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: issued.token }), key))
      expect(JSON.parse(decrypt(await nextMessage(client), key) ?? 'null')).toMatchObject({
        type: 'e2ee_authenticated'
      })

      const request = async (id: string, method: string) => {
        client.send(encrypt(JSON.stringify({ id, method }), key))
        return JSON.parse(decrypt(await nextMessage(client), key) ?? 'null')
      }
      expect(await request('read', 'observer.runtimeIdentity')).toMatchObject({
        id: 'read',
        ok: true
      })
      expect(await request('write', 'test.mutate')).toMatchObject({
        id: 'write',
        ok: false
      })
      expect(await request('unknown', 'observer.nonexistent')).toMatchObject({
        id: 'unknown',
        ok: false
      })
      expect(mutation).not.toHaveBeenCalled()
      expect(server.getDeviceRegistry()?.listDevices()).toHaveLength(0)

      expect(store.revoke(issued.id)).toBe(true)
      expect(await request('revoked', 'observer.runtimeIdentity')).toMatchObject({
        id: 'revoked',
        ok: false,
        error: { code: 'unauthorized' }
      })

      const reconnect = new WebSocket(endpoint!)
      clients.push(reconnect)
      await opened(reconnect)
      const reconnectKeypair = generateKeyPair()
      const reconnectKey = deriveSharedKey(
        reconnectKeypair.secretKey,
        Buffer.from(publicKey!, 'base64')
      )
      reconnect.send(JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: Buffer.from(reconnectKeypair.publicKey).toString('base64')
      }))
      expect(JSON.parse(await nextMessage(reconnect))).toMatchObject({ type: 'e2ee_ready' })
      const close = closed(reconnect)
      reconnect.send(
        encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: issued.token }), reconnectKey)
      )
      expect(await close).toBe(4001)
      expect(mutation).not.toHaveBeenCalled()
      expect(server.getDeviceRegistry()?.listDevices()).toHaveLength(0)
      expect(new DeviceRegistry(dir).validateToken(issued.token)).toBeNull()
    } finally {
      for (const client of clients) {
        client.terminate()
      }
      await server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
