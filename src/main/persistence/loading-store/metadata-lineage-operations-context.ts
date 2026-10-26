import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import type { SessionHostPartitionOperations } from './session-host-partitions'
import type { MetadataLineageOperations } from './metadata-lineage-operations'

export type MetadataLineageOperationsRuntime = Pick<StoreRuntimeState, 'state'>

export type MetadataLineageOperationsContext = {
  runtime: MetadataLineageOperationsRuntime
  scheduling: WriteSchedulingOperations
  sessions: SessionHostPartitionOperations
}

export const metadataLineageOperationsContext = Symbol('MetadataLineageOperations')

export function removeWorkspaceLineageForFolderParent(
  owner: MetadataLineageOperations,
  folderWorkspaceId: string
): void {
  const parentKey = folderWorkspaceKey(folderWorkspaceId)
  for (const [childKey, lineage] of Object.entries(
    owner[metadataLineageOperationsContext].runtime.state.workspaceLineageByChildKey
  )) {
    if (lineage.parentWorkspaceKey === parentKey) {
      delete owner[metadataLineageOperationsContext].runtime.state.workspaceLineageByChildKey[
        childKey as WorkspaceKey
      ]
    }
  }
}

export function installMetadataLineageOperationsContext(
  target: MetadataLineageOperations,
  source: MetadataLineageOperations
): void {
  Object.defineProperty(target, metadataLineageOperationsContext, {
    value: source[metadataLineageOperationsContext]
  })
}
