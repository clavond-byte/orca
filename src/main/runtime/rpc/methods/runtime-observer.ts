import { defineMethod } from '../core'
import { getRemoteServerUpdaterSnapshot } from '../../remote-server-updater'

export const RUNTIME_OBSERVER_METHODS = [
  defineMethod({
    name: 'observer.runtimeIdentity',
    permission: 'observer-read',
    params: null,
    handler: (_params, { runtime }) => ({
      runtimeId: runtime.getRuntimeId(),
      startedAt: runtime.getStartedAt(),
      appVersion: getRemoteServerUpdaterSnapshot(runtime.getRuntimeId()).appVersion
    })
  }),
  defineMethod({
    name: 'observer.sessionInventory',
    permission: 'observer-read',
    params: null,
    handler: (_params, { runtime, observerWorktreeId }) => {
      const base = {
        runtimeId: runtime.getRuntimeId(),
        startedAt: runtime.getStartedAt(),
        worktreeId: observerWorktreeId ?? null,
        readAt: Date.now(),
        // The read time does not attest when the tab snapshot was published.
        snapshotFreshness: 'unverified' as const,
        coverage: 'published-agent-tabs-only' as const
      }
      if (!observerWorktreeId) {
        return { ...base, state: 'unknown' as const }
      }
      const snapshot = runtime.mobileSessionTabsByWorktree.get(observerWorktreeId)
      if (!snapshot || snapshot.worktree !== observerWorktreeId) {
        return { ...base, state: 'unknown' as const }
      }
      return {
        ...base,
        state: 'observed' as const,
        publicationEpoch: snapshot.publicationEpoch,
        snapshotVersion: snapshot.snapshotVersion,
        worktreeInstanceId: snapshot.worktreeInstanceId ?? null,
        knownSessionIds: [
          ...new Set(
            snapshot.tabs.filter((tab) => tab.type === 'agent-session').map((tab) => tab.sessionId)
          )
        ].sort()
      }
    }
  })
]
