import { describe, expect, it } from 'vitest'
import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import type { WorkspaceLineage } from '../../../shared/worktree/lineage-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { removeWorkspaceLineageForFolderParent } from './workspace-lineage-folder-removal'

describe('removeWorkspaceLineageForFolderParent', () => {
  it('removes only lineage entries belonging to the removed folder parent', () => {
    const parentKey = folderWorkspaceKey('removed-parent')
    const otherParentKey = folderWorkspaceKey('other-parent')
    const removedChildKey = folderWorkspaceKey('child-a')
    const retainedChildKey = folderWorkspaceKey('child-b')
    const makeLineage = (
      childWorkspaceKey: WorkspaceKey,
      parentWorkspaceKey: WorkspaceKey,
      createdAt: number
    ): WorkspaceLineage => ({
      childWorkspaceKey,
      parentWorkspaceKey,
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt
    })
    const lineages: Record<WorkspaceKey, WorkspaceLineage> = {
      [removedChildKey]: makeLineage(removedChildKey, parentKey, 1),
      [retainedChildKey]: makeLineage(retainedChildKey, otherParentKey, 2)
    }

    removeWorkspaceLineageForFolderParent(
      { getAllWorkspaceLineage: () => lineages },
      'removed-parent'
    )

    expect(lineages).toEqual({
      [retainedChildKey]: makeLineage(retainedChildKey, otherParentKey, 2)
    })
  })
})
