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
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    const issued = store.issue('worktree-a', 'instance-a')
    expect(issued.token).toMatch(/^orca-observer-v1-[A-Za-z0-9_-]{43}$/)
    expect(store.authenticate(issued.token)?.id).toBe(issued.id)
    expect(readFileSync(join(dir, 'observer-credentials.v1.json'), 'utf8')).not.toContain(
      issued.token
    )
    expect(new DeviceRegistry(dir).validateToken(issued.token)).toBeNull()
  })

  it('binds a scoped credential to one worktree and expires it after one hour', () => {
    const { store } = setup()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      expect(() => store.issue('', 'instance-a')).toThrow('Invalid observer worktree scope')
      expect(() => store.issue('worktree-a', '')).toThrow(
        'Invalid observer worktree scope or instance'
      )
      expect(() => store.issue(undefined as unknown as string, 'instance-a')).toThrow(
        'Invalid observer worktree scope or instance'
      )
      const issued = store.issue('worktree-a', 'instance-a')
      expect(store.authenticate(issued.token)).toMatchObject({
        id: issued.id,
        worktreeId: 'worktree-a',
        worktreeInstanceId: 'instance-a',
        expiresAt: now + 3_600_000
      })
      clock.mockReturnValue(now + 3_600_000)
      expect(store.authenticate(issued.token)).toBeNull()
    } finally {
      clock.mockRestore()
    }
  })

  it('rejects unknown, malformed, and revoked credentials', () => {
    const { store } = setup()
    const issued = store.issue('worktree-a', 'instance-a')
    expect(store.authenticate(`${issued.token.slice(0, -1)}x`)).toBeNull()
    expect(store.authenticate('not-an-observer')).toBeNull()
    expect(store.resolve('wrong-id', issued.token)).toBeNull()
    expect(store.revoke(issued.id)).toBe(true)
    expect(store.authenticate(issued.token)).toBeNull()
    expect(store.revoke(issued.id)).toBe(false)
  })

  it('fails closed on corrupt storage and does not overwrite it during issuance', () => {
    const { dir, store } = setup()
    const issued = store.issue('worktree-a', 'instance-a')
    const path = join(dir, 'observer-credentials.v1.json')
    writeFileSync(path, '{bad-json')
    expect(store.authenticate(issued.token)).toBeNull()
    expect(() => store.issue('worktree-a', 'instance-a')).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{bad-json')
  })

  it('fails closed with an explicit fresh-store prerequisite for intermediate scoped rows', () => {
    const { dir, store } = setup()
    const issued = store.issue('worktree-a', 'instance-a')
    const path = join(dir, 'observer-credentials.v1.json')
    const saved = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number
      credentials: unknown[]
    }
    saved.credentials.push({
      id: '00000000-0000-4000-8000-000000000000',
      tokenHash: '0'.repeat(64),
      createdAt: Date.now() - 4_000_000,
      worktreeId: 'old-locator',
      expiresAt: Date.now() - 1
    })
    writeFileSync(path, JSON.stringify(saved))
    expect(store.authenticate(issued.token)).toBeNull()
    expect(() => store.issue('worktree-b', 'instance-b')).toThrow(
      'Incomplete observer store requires fresh path and reissue'
    )
    expect(() => store.revoke(issued.id)).toThrow(
      'Incomplete observer store requires fresh path and reissue'
    )
  })

  it('rejects a legacy unscoped row without reviving any bearer in that store', () => {
    const { dir, store } = setup()
    const issued = store.issue('worktree-a', 'instance-a')
    const path = join(dir, 'observer-credentials.v1.json')
    const saved = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number
      credentials: unknown[]
    }
    saved.credentials.push({
      id: '00000000-0000-4000-8000-000000000001',
      tokenHash: '0'.repeat(64),
      createdAt: Date.now()
    })
    writeFileSync(path, JSON.stringify(saved))
    expect(store.authenticate(issued.token)).toBeNull()
    expect(() => store.issue('worktree-b', 'instance-b')).toThrow(
      'Incomplete observer store requires fresh path and reissue'
    )
    expect(() => store.revoke(issued.id)).toThrow(
      'Incomplete observer store requires fresh path and reissue'
    )
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(saved)
  })

  it('rejects a stored bearer whose expiry exceeds one hour', () => {
    const { dir, store } = setup()
    const issued = store.issue('worktree-a', 'instance-a')
    const path = join(dir, 'observer-credentials.v1.json')
    const saved = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number
      credentials: Array<{ createdAt: number; expiresAt: number }>
    }
    saved.credentials[0]!.expiresAt = saved.credentials[0]!.createdAt + 3_600_001
    writeFileSync(path, JSON.stringify(saved))
    expect(store.authenticate(issued.token)).toBeNull()
    expect(() => store.issue('worktree-b', 'instance-b')).toThrow('Invalid observer store')
  })

  it('serializes owner-local writes instead of losing a concurrent revocation', () => {
    const { dir, store } = setup()
    const issued = store.issue('worktree-a', 'instance-a')
    const lockPath = join(dir, 'observer-credentials.v1.json.lock')
    const lock = openSync(lockPath, 'wx', 0o600)
    try {
      expect(() => store.issue('worktree-b', 'instance-b')).toThrow()
      expect(() => store.revoke(issued.id)).toThrow()
      expect(store.authenticate(issued.token)?.id).toBe(issued.id)
    } finally {
      closeSync(lock)
      unlinkSync(lockPath)
    }
    expect(store.revoke(issued.id)).toBe(true)
  })
})
