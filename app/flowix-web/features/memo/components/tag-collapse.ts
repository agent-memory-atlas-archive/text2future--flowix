import type { MemoTagTreeItem } from '@features/memo/services/memo-list-metadata-service';

export type CollapsibleTagTreeItem = MemoTagTreeItem & {
  collapsedByAncestor: boolean;
};

/**
 * 标记被任一折叠祖先隐藏的标签。
 *
 * 不能依赖 DFS 数组中的单个 depth 游标：当隐藏子树里还有已折叠节点时，
 * 内层 depth 会覆盖外层折叠范围，导致后续分支泄漏。parentId 祖先链是
 * 标签树结构的真实来源，也不受同级拖拽排序影响。
 */
export function markTagsCollapsedByAncestor(
  tagOptions: MemoTagTreeItem[],
  collapsedTagIds: ReadonlySet<string>,
): CollapsibleTagTreeItem[] {
  const tagById = new Map(tagOptions.map((tag) => [tag.id, tag]));

  return tagOptions.map((tag) => {
    let ancestorId = tag.parentId;
    const visited = new Set<string>([tag.id]);
    let collapsedByAncestor = false;

    while (ancestorId && !visited.has(ancestorId)) {
      if (collapsedTagIds.has(ancestorId)) {
        collapsedByAncestor = true;
        break;
      }

      visited.add(ancestorId);
      ancestorId = tagById.get(ancestorId)?.parentId ?? null;
    }

    return { ...tag, collapsedByAncestor };
  });
}

/** Keep rows mounted through the collapse animation, then remove settled subtrees. */
export function markTagsDuringCollapseTransition(
  tagOptions: MemoTagTreeItem[],
  collapsedTagIds: ReadonlySet<string>,
  settledCollapsedTagIds: ReadonlySet<string>,
): CollapsibleTagTreeItem[] {
  const activeTags = markTagsCollapsedByAncestor(tagOptions, collapsedTagIds);
  const settledCollapsed = new Set(
    [...collapsedTagIds].filter((id) => settledCollapsedTagIds.has(id)),
  );
  if (settledCollapsed.size === 0) return activeTags;

  const settledHiddenIds = new Set(
    markTagsCollapsedByAncestor(tagOptions, settledCollapsed)
      .filter((tag) => tag.collapsedByAncestor)
      .map((tag) => tag.id),
  );
  return activeTags.filter((tag) => !settledHiddenIds.has(tag.id));
}
