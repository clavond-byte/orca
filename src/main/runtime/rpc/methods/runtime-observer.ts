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
  })
]
