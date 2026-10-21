import { describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import { OrcaRuntimeService } from './orca-runtime'

const repo: Repo = {
  id: 'repo-id',
  path: '/private/repo',
  displayName: 'Private repo',
  addedAt: 1,
  badgeColor: 'blue'
}
const worktreeId = 'repo-id::/private/worktree'
const gitRow = {
  path: '/private/worktree',
  head: '0'.repeat(40),
  branch: 'main',
  isBare: false,
  isMainWorktree: false
}

class CatalogProbe extends OrcaRuntimeService {
  scan: RuntimeWorktreeScanResult = { ok: true, worktrees: [gitRow] }
  scans = 0
  protected override async listRepoWorktreesForResolutionUncached(): Promise<RuntimeWorktreeScanResult> {
    this.scans += 1
    return this.scan
  }
}

describe('observer current local worktree check', () => {
  it('requires a live local checkout and the matching host-qualified instance', async () => {
    const runtime = new CatalogProbe()
    let instanceId: string | undefined = 'instance-a'
    Object.assign(runtime, {
      store: {
        getRepos: () => [repo],
        getWorktreeMetaForHost: (id: string, host: string) =>
          id === worktreeId && host === 'local' && instanceId ? { instanceId } : undefined
      }
    })
    await expect(runtime.getCurrentLocalObserverWorktreeInstanceId(worktreeId)).resolves.toBe(
      'instance-a'
    )
    instanceId = undefined
    await expect(runtime.getCurrentLocalObserverWorktreeInstanceId(worktreeId)).resolves.toBeNull()
    instanceId = 'instance-b'
    runtime.scan = { ok: true, worktrees: [] }
    await expect(runtime.getCurrentLocalObserverWorktreeInstanceId(worktreeId)).resolves.toBeNull()
    runtime.scan = { ok: false, worktrees: [gitRow] }
    await expect(runtime.getCurrentLocalObserverWorktreeInstanceId(worktreeId)).resolves.toBeNull()
    expect(runtime.scans).toBe(3)
  })

  it('denies ambiguous or nonlocal owners without scanning', async () => {
    const runtime = new CatalogProbe()
    Object.assign(runtime, {
      store: {
        getRepos: () => [repo, { ...repo, connectionId: 'remote' }],
        getWorktreeMetaForHost: () => ({ instanceId: 'instance-a' })
      }
    })
    await expect(runtime.getCurrentLocalObserverWorktreeInstanceId(worktreeId)).resolves.toBe(
      'instance-a'
    )
    Object.assign(runtime, {
      store: {
        getRepos: () => [repo, { ...repo }],
        getWorktreeMetaForHost: () => ({ instanceId: 'instance-a' })
      }
    })
    await expect(runtime.getCurrentLocalObserverWorktreeInstanceId(worktreeId)).resolves.toBeNull()
    Object.assign(runtime, {
      store: {
        getRepos: () => [{ ...repo, connectionId: 'remote' }],
        getWorktreeMetaForHost: () => ({ instanceId: 'instance-a' })
      }
    })
    await expect(runtime.getCurrentLocalObserverWorktreeInstanceId(worktreeId)).resolves.toBeNull()
    expect(runtime.scans).toBe(1)
  })
})
