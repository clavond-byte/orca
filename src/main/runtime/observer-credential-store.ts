// Observer credentials never enter device-registry.json. Older Orca builds do not read this file
// and therefore cannot reinterpret a new observer scope as a mutable mobile or runtime device.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hardenExistingSecureFile, writeDurableSecureJsonFile } from '../../shared/secure-file'

const FILE_NAME = 'observer-credentials.v1.json'
const TOKEN_PREFIX = 'orca-observer-v1-'
const TOKEN_PATTERN = /^orca-observer-v1-[A-Za-z0-9_-]{43}$/

type ObserverCredentialRow = {
  id: string
  tokenHash: string
  createdAt: number
  worktreeId?: string
  expiresAt?: number
}

export type ObserverCredential = {
  id: string
  tokenHash: string
  worktreeId?: string
  expiresAt?: number
}

function validWorktreeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function validRow(value: unknown): value is ObserverCredentialRow {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const row = value as Partial<ObserverCredentialRow>
  return (
    typeof row.id === 'string' &&
    /^[0-9a-f-]{36}$/.test(row.id) &&
    typeof row.tokenHash === 'string' &&
    /^[0-9a-f]{64}$/.test(row.tokenHash) &&
    typeof row.createdAt === 'number' &&
    Number.isSafeInteger(row.createdAt) &&
    row.createdAt > 0 &&
    (row.worktreeId === undefined
      ? row.expiresAt === undefined
      : validWorktreeId(row.worktreeId) &&
        typeof row.expiresAt === 'number' &&
        Number.isSafeInteger(row.expiresAt) &&
        row.expiresAt > row.createdAt)
  )
}

export class ObserverCredentialStore {
  private readonly path: string

  constructor(userDataPath: string) {
    this.path = join(userDataPath, FILE_NAME)
  }

  private withWriteLock<T>(work: () => T): T {
    // Serializes owner-local issue/revoke processes. A crash leaves the lock and fails closed
    // until the owner inspects it; silently breaking a stale lock could resurrect a revoked row.
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    hardenExistingSecureFile(this.path)
    const lockPath = `${this.path}.lock`
    const descriptor = openSync(lockPath, 'wx', 0o600)
    try {
      return work()
    } finally {
      closeSync(descriptor)
      unlinkSync(lockPath)
    }
  }

  private readRows(): ObserverCredentialRow[] {
    let text: string
    try {
      hardenExistingSecureFile(this.path)
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Invalid observer store')
    }
    const store = parsed as { version?: unknown; credentials?: unknown }
    if (
      store.version !== 1 ||
      !Array.isArray(store.credentials) ||
      !store.credentials.every(validRow)
    ) {
      throw new Error('Invalid observer store')
    }
    const rows = store.credentials as ObserverCredentialRow[]
    if (new Set(rows.map((row) => row.id)).size !== rows.length) {
      throw new Error('Duplicate observer credential id')
    }
    return rows
  }

  /** The bearer is returned once, only after its hash is durably stored. */
  issue(worktreeId?: string): { id: string; token: string } {
    if (worktreeId !== undefined && !validWorktreeId(worktreeId)) {
      throw new Error('Invalid observer worktree scope')
    }
    return this.withWriteLock(() => {
      const rows = this.readRows()
      const id = randomUUID()
      const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
      const createdAt = Date.now()
      const scope = worktreeId === undefined ? {} : { worktreeId, expiresAt: createdAt + 3_600_000 }
      if (
        !writeDurableSecureJsonFile(this.path, {
          version: 1,
          credentials: [...rows, { id, tokenHash: tokenHash(token), createdAt, ...scope }]
        })
      ) {
        throw new Error('Observer credential store could not be secured')
      }
      return { id, token }
    })
  }

  revoke(id: string): boolean {
    return this.withWriteLock(() => {
      const rows = this.readRows()
      if (!rows.some((row) => row.id === id)) {
        return false
      }
      if (
        !writeDurableSecureJsonFile(this.path, {
          version: 1,
          credentials: rows.filter((row) => row.id !== id)
        })
      ) {
        throw new Error('Observer credential revocation could not be secured')
      }
      return true
    })
  }

  /** Any missing, unreadable, or malformed store fails closed for admission. */
  authenticate(token: string): ObserverCredential | null {
    if (!TOKEN_PATTERN.test(token)) {
      return null
    }
    try {
      const expected = Buffer.from(tokenHash(token), 'hex')
      const row = this.readRows().find((candidate) =>
        timingSafeEqual(Buffer.from(candidate.tokenHash, 'hex'), expected)
      )
      if (!row || (row.expiresAt !== undefined && row.expiresAt <= Date.now())) return null
      return {
        id: row.id,
        tokenHash: row.tokenHash,
        worktreeId: row.worktreeId,
        expiresAt: row.expiresAt
      }
    } catch {
      return null
    }
  }

  resolve(id: string, token: string): ObserverCredential | null {
    const credential = this.authenticate(token)
    return credential?.id === id ? credential : null
  }
}
