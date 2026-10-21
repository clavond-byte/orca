import { defineMethod } from '../core'
import { getRemoteServerUpdaterSnapshot } from '../../remote-server-updater'

const MAX_OBSERVER_SNAPSHOT_TABS = 1024

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
    handler: (
      _params,
      { runtime, observerWorktreeId, observerWorktreeInstanceId, observerScopeId }
    ) => {
      const base = {
        runtimeId: runtime.getRuntimeId(),
        startedAt: runtime.getStartedAt(),
        // A worktree locator may contain a filesystem path. Only an opaque credential-local ID leaves the host.
        scopeId: observerScopeId ?? null,
        readAt: Date.now(),
        // The read time does not attest when the tab snapshot was published.
        snapshotFreshness: 'unverified' as const,
        checkoutContinuity: 'unverified' as const,
        coverage: 'published-agent-tabs-only' as const
      }
      if (!observerWorktreeId || !observerWorktreeInstanceId || !observerScopeId) {
        return { ...base, state: 'unknown' as const }
      }
      const snapshot = runtime.mobileSessionTabsByWorktree.get(observerWorktreeId)
      if (
        !snapshot ||
        snapshot.worktree !== observerWorktreeId ||
        snapshot.worktreeInstanceId !== observerWorktreeInstanceId
      ) {
        // A different logical catalog instance cannot reuse the credential's retained view.
        return { ...base, state: 'unknown' as const }
      }
      if (snapshot.tabs.length > MAX_OBSERVER_SNAPSHOT_TABS) {
        // Never truncate a session set while reporting it as complete.
        return { ...base, state: 'unknown' as const, reason: 'snapshot-over-limit' as const }
      }
      // This is a retained logical-catalog view, not a filesystem or liveness census.
      // The lookup is synchronous, so no uncached scan or unbounded request work occurs.
      const snapshotVersion = snapshot.snapshotVersion
      let catalogInstanceId: string | null
      try {
        catalogInstanceId = runtime.getLogicalLocalObserverWorktreeInstanceId(observerWorktreeId)
      } catch {
        return { ...base, state: 'unknown' as const }
      }
      if (
        catalogInstanceId !== observerWorktreeInstanceId ||
        runtime.mobileSessionTabsByWorktree.get(observerWorktreeId) !== snapshot ||
        snapshot.snapshotVersion !== snapshotVersion
      ) {
        // A publication retired or replaced during the lookup cannot be returned.
        return { ...base, state: 'unknown' as const }
      }
      if (snapshot.tabs.length > MAX_OBSERVER_SNAPSHOT_TABS) {
        // Never truncate a session set while reporting it as complete.
        return { ...base, state: 'unknown' as const, reason: 'snapshot-over-limit' as const }
      }
      return {
        ...base,
        state: 'observed' as const,
        publicationEpoch: snapshot.publicationEpoch,
        snapshotVersion: snapshot.snapshotVersion,
        worktreeInstanceId: snapshot.worktreeInstanceId,
        knownSessionIds: [
          ...new Set(
            snapshot.tabs.filter((tab) => tab.type === 'agent-session').map((tab) => tab.sessionId)
          )
        ].sort()
      }
    }
  })
]
