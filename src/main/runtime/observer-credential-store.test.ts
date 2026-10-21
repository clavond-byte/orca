import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { ObserverCredentialStore } from './observer-credential-store'

const dirs: string[] = []

function setup(): { dir: string; store: ObserverCredentialStore } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-observer-test-'))
  dirs.push(dir)
  return { dir, store: new ObserverCredentialStore(dir) }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('separate observer credentials', () => {
  it('issues only after secure storage and never writes bearer bytes to disk', () => {
    const { dir, store } = setup()
    const issued = store.issue()
    expect(issued.token).toMatch(/^orca-observer-v1-[A-Za-z0-9_-]{43}$/)
    expect(store.authenticate(issued.token)?.id).toBe(issued.id)
    expect(readFileSync(join(dir, 'observer-credentials.v1.json'), 'utf8')).not.toContain(
      issued.token
    )
    expect(new DeviceRegistry(dir).validateToken(issued.token)).toBeNull()
  })

  it('rejects unknown, malformed, and revoked credentials', () => {
    const { store } = setup()
    const issued = store.issue()
    expect(store.authenticate(`${issued.token.slice(0, -1)}x`)).toBeNull()
    expect(store.authenticate('not-an-observer')).toBeNull()
    expect(store.resolve('wrong-id', issued.token)).toBeNull()
    expect(store.revoke(issued.id)).toBe(true)
    expect(store.authenticate(issued.token)).toBeNull()
    expect(store.revoke(issued.id)).toBe(false)
  })

  it('fails closed on corrupt storage and does not overwrite it during issuance', () => {
    const { dir, store } = setup()
    const issued = store.issue()
    const path = join(dir, 'observer-credentials.v1.json')
    writeFileSync(path, '{bad-json')
    expect(store.authenticate(issued.token)).toBeNull()
    expect(() => store.issue()).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{bad-json')
  })

  it('serializes owner-local writes instead of losing a concurrent revocation', () => {
    const { dir, store } = setup()
    const issued = store.issue()
    const lockPath = join(dir, 'observer-credentials.v1.json.lock')
    const lock = openSync(lockPath, 'wx', 0o600)
    try {
      expect(() => store.issue()).toThrow()
      expect(() => store.revoke(issued.id)).toThrow()
      expect(store.authenticate(issued.token)?.id).toBe(issued.id)
    } finally {
      closeSync(lock)
      unlinkSync(lockPath)
    }
    expect(store.revoke(issued.id)).toBe(true)
  })
})
