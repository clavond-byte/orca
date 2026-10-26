import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { MetadataLineageOperations } from './metadata-lineage-operations'

export function removeWorkspaceLineageForFolderParent(
  owner: Pick<MetadataLineageOperations, 'getAllWorkspaceLineage'>,
  folderWorkspaceId: string
): void {
  const parentKey = folderWorkspaceKey(folderWorkspaceId)
  const lineages = owner.getAllWorkspaceLineage()
  for (const [childKey, lineage] of Object.entries(lineages)) {
    if (lineage.parentWorkspaceKey === parentKey) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Object.entries yields keys from this typed workspace-lineage record.
      delete lineages[childKey as WorkspaceKey]
    }
  }
}
