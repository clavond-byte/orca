import { describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { OrcaRuntimeService } from './orca-runtime'

const repo: Repo = {
  id: 'repo-id',
  path: '/private/repo',
  displayName: 'Private repo',
  addedAt: 1,
  badgeColor: 'blue'
}
const worktreeId = 'repo-id::/private/worktree'

class CatalogProbe extends OrcaRuntimeService {
  scans = 0
  protected override async listRepoWorktreesForResolutionUncached(): Promise<never> {
    this.scans += 1
    throw new Error('Logical observer projection must not scan the filesystem')
  }
}

describe('observer retained local catalog lookup', () => {
  it('requires a unique host-qualified instance without migration or a filesystem scan', () => {
    const runtime = new CatalogProbe()
    let instanceId: string | undefined = 'instance-a'
    Object.assign(runtime, {
      store: {
        getRepos: () => [repo],
        peekUniqueWorktreeInstanceForHost: (id: string, host: string) =>
          id === worktreeId && host === 'local' && instanceId
            ? { state: 'unique', instanceId }
            : { state: 'missing' },
        getWorktreeMetaForHost: () => {
          throw new Error('Observer must not invoke the migrating single-row getter')
        }
      }
    })
    expect(runtime.getLogicalLocalObserverWorktreeInstanceId(worktreeId)).toBe('instance-a')
    instanceId = undefined
    expect(runtime.getLogicalLocalObserverWorktreeInstanceId(worktreeId)).toBeNull()
    expect(runtime.scans).toBe(0)
  })

  it('denies competing aliases, duplicate local owners, and remote-only owners', () => {
    const runtime = new CatalogProbe()
    Object.assign(runtime, {
      store: {
        getRepos: () => [repo, { ...repo, connectionId: 'remote' }],
        peekUniqueWorktreeInstanceForHost: () => ({ state: 'unique', instanceId: 'instance-a' })
      }
    })
    expect(runtime.getLogicalLocalObserverWorktreeInstanceId(worktreeId)).toBe('instance-a')
    Object.assign(runtime, {
      store: {
        getRepos: () => [repo, { ...repo }],
        peekUniqueWorktreeInstanceForHost: () => ({ state: 'unique', instanceId: 'instance-a' })
      }
    })
    expect(runtime.getLogicalLocalObserverWorktreeInstanceId(worktreeId)).toBeNull()
    Object.assign(runtime, {
      store: {
        getRepos: () => [{ ...repo, connectionId: 'remote' }],
        peekUniqueWorktreeInstanceForHost: () => ({ state: 'unique', instanceId: 'instance-a' })
      }
    })
    expect(runtime.getLogicalLocalObserverWorktreeInstanceId(worktreeId)).toBeNull()
    Object.assign(runtime, {
      store: {
        getRepos: () => [repo],
        peekUniqueWorktreeInstanceForHost: () => ({ state: 'ambiguous' })
      }
    })
    expect(runtime.getLogicalLocalObserverWorktreeInstanceId(worktreeId)).toBeNull()
    expect(runtime.scans).toBe(0)
  })

  it('labels a retained logical identity without pretending to prove path presence', () => {
    const runtime = new CatalogProbe()
    Object.assign(runtime, {
      store: {
        getRepos: () => [repo],
        peekUniqueWorktreeInstanceForHost: () => ({ state: 'unique', instanceId: 'instance-a' })
      }
    })
    expect(runtime.getLogicalLocalObserverWorktreeInstanceId(worktreeId)).toBe('instance-a')
    expect(runtime.scans).toBe(0)
  })
})
